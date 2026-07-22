/**
 * WebSocket handler for pipane.
 *
 * Architecture:
 * - SessionRegistry provides one serialized SessionActor per session path.
 * - The actor owns its process lease, phase, materialized state, steering, and cleanup.
 * - WsHandler validates/routes transport commands and publishes actor updates.
 * - Any number of clients can connect; each subscribes to one session at a time.
 * - Detached sessions are read from JSONL on demand.
 */

import type { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import {
	FRAME_CONNECTION_OPEN,
	WebSocketFrameConnection,
	type ServerFrameConnection,
} from "./frame-connection.js";

import { copyFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import path from "node:path";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { SessionRegistry } from "./session-registry.js";
import type { SessionActor } from "./session-actor.js";
import {
	ProcessPool,
	type RpcProcess,
	type RpcProcessEvent,
	type RpcProcessLease,
} from "./process-pool.js";
import {
	SessionJsonl,
	readSessionFromDisk,
	getSessionFileSize,
	serializeSessionState,
} from "./session-jsonl.js";
import { getSessionCwd } from "./session-cwd.js";
import { checkCommandAvailable, installPiGlobal, isPiInstallable, makePiNotFoundMessage } from "./pi-runtime.js";
import { modelsMatch, toCompactModelRef } from "../shared/thinking-levels.js";
import { computeSyncOp } from "../shared/jsonl-sync.js";
import { COMPACT_RPC_TIMEOUT_MS } from "../shared/rpc-timeouts.js";
import {
	assertNever,
	decodeClientCommand,
	encodeServerMessage,
	type ClientCommand,
	type ClientCommandType,
	type CommandResponseData,
	type ExtensionStatusMessage,
	type ProviderUsageMessage,
	type ServerMessagePayload,
} from "../shared/ws-protocol.js";
import { SessionPathError, SessionPathGuard } from "./session-path.js";
import {
	extensionStatusSnapshot,
	isValidExtensionStatusKey,
	normalizeExtensionStatusText,
	providerForUsageStatus,
	PROVIDER_USAGE_STATUS_KEY,
	type ProviderUsageProvider,
} from "./extension-status.js";

export interface WsHandlerOptions {
	registry: SessionRegistry;
	pool: ProcessPool;
	sessionPaths?: SessionPathGuard;
	defaultCwd: string;
	piLaunch: { command: string; baseArgs: string[] };
	ensurePool: () => void;
	isRequestAuthorized: (req: IncomingMessage) => boolean;
}

type CommandOf<Type extends ClientCommandType> = Extract<ClientCommand, { type: Type }>;
type ControlCommand = CommandOf<"prompt"> | CommandOf<"fork_prompt">;
type ExtensionStatusPayload = Omit<ExtensionStatusMessage, "protocolVersion">;
type ProviderUsagePayload = Omit<ProviderUsageMessage, "protocolVersion">;

const DETACHED_SYNC_COALESCE_MS = 75;
const SESSION_SYNC_TRANSFER_KEY = "active-session-sync";

interface ClientState {
	subscribedSession: string | null;
	/** Client's last known version of the session */
	lastVersion: number;
	/** Client's current JSONL string (for computing diffs) */
	lastJson: string;
	/** Client's current hash (for verifying diffs) */
	lastHash: string;
}

interface TurnEventObserver {
	started: Promise<void>;
	ended: Promise<void>;
	settled: Promise<void>;
	hasStarted: () => boolean;
	hasSettled: () => boolean;
}

let nextTurnId = 0;
function makeTurnId(): string {
	return `turn_${Date.now()}_${++nextTurnId}`;
}

function debugTurn(stage: string, data: Record<string, unknown>) {
	console.log(`[turn] ${stage} ${JSON.stringify(data)}`);
}

export class WsHandler {
	private registry: SessionRegistry;
	private pool: ProcessPool;
	private sessionPaths: SessionPathGuard;
	private defaultCwd: string;
	private piLaunch: { command: string; baseArgs: string[] };
	private ensurePool: () => void;
	private isRequestAuthorized: (req: IncomingMessage) => boolean;

	private clients = new Map<ServerFrameConnection, ClientState>();
	/** Last known extension statuses, retained while a session is detached. */
	private extensionStatusesBySession = new Map<string, Map<string, string>>();
	/** Latest successful account-wide subscription usage from any process. */
	private providerUsageStatuses = new Map<ProviderUsageProvider, string>();
	/** Statuses emitted while a process is switching to a not-yet-attached session. */
	private pendingExtensionStatuses = new WeakMap<RpcProcess, Map<string, string>>();
	/**
	 * Track file sizes for detached sessions that clients are subscribed to.
	 * Used for change detection when the file watcher fires.
	 */
	private subscribedFileSizes = new Map<string, number>();
	/** Last revision/hash published for each authoritative session state. */
	private sessionRevisions = new Map<string, { revision: number; hash: string }>();
	/** Per-session trailing-edge disk refreshes for detached JSONL bursts. */
	private pendingDetachedSyncs = new Map<string, ReturnType<typeof setTimeout>>();

	private piAvailable: boolean;
	private piInstalling = false;

	constructor(options: WsHandlerOptions) {
		this.registry = options.registry;
		this.pool = options.pool;
		this.sessionPaths = options.sessionPaths ?? new SessionPathGuard();
		this.defaultCwd = options.defaultCwd;
		this.piLaunch = options.piLaunch;
		this.ensurePool = options.ensurePool;
		this.isRequestAuthorized = options.isRequestAuthorized;
		this.piAvailable = checkCommandAvailable(this.piLaunch.command);

		this.pool.subscribeEvents((proc, event) => this.handleProcessEvent(proc, event));

		this.registry.subscribe((event) => {
			switch (event.type) {
				case "session_attached":
					this.broadcast({
						type: "session_status_change",
						sessionPath: event.sessionPath,
						status: "running",
					});
					break;
				case "session_detached":
					this.broadcast({
						type: "session_status_change",
						sessionPath: event.sessionPath,
						status: "done",
					});
					break;
				case "steering_queue_update": {
					const session = this.registry.find(event.sessionPath)?.session;
					if (session) this.pushUpdateToSubscribers(event.sessionPath, session);
					break;
				}
			}
		});
	}

	get isPiAvailable(): boolean {
		return this.piAvailable;
	}

	/** Idempotently clean up the owning actor after an RPC process exits. */
	handleProcessExit(proc: RpcProcess): void {
		this.pendingExtensionStatuses.delete(proc);
		const actor = this.registry.getActorForProcess(proc);
		if (!actor) return;
		console.log(`[pool] pi#${proc.id} crashed while attached to ${path.basename(actor.sessionPath)} — marking done`);
		void actor.enqueue("process exit", () => {
			if (actor.process !== proc) return;
			actor.markFailed();
			// Without a final get_state, disk is safer than potentially stale
			// in-memory controls (pi may have persisted a model change before crash).
			this.releaseActor(actor, false);
		});
	}

	private handleProcessEvent(proc: RpcProcess, event: RpcProcessEvent): void {
		if (event.type !== "extension_ui_request" || event.method !== "setStatus") return;
		if (!isValidExtensionStatusKey(event.statusKey)) return;

		const normalizedStatusText = typeof event.statusText === "string"
			? normalizeExtensionStatusText(event.statusText)
			: undefined;

		// Subscription usage belongs to the provider account, not a conversation.
		// Capture successful values even from unattached prewarm processes so a
		// virtual or never-run conversation can still display the latest quota.
		if (event.statusKey === PROVIDER_USAGE_STATUS_KEY && normalizedStatusText) {
			const provider = providerForUsageStatus(normalizedStatusText);
			if (provider && this.providerUsageStatuses.get(provider) !== normalizedStatusText) {
				this.providerUsageStatuses.set(provider, normalizedStatusText);
				this.broadcast(this.makeProviderUsageMessage());
			}
		}

		const sessionPath = this.registry.getActorForProcess(proc)?.sessionPath;
		const statuses = sessionPath
			? (this.extensionStatusesBySession.get(sessionPath) ?? new Map<string, string>())
			: this.pendingExtensionStatuses.get(proc);
		if (!statuses) return;
		if (sessionPath && !this.extensionStatusesBySession.has(sessionPath)) {
			this.extensionStatusesBySession.set(sessionPath, statuses);
		}

		const previous = statuses.get(event.statusKey);
		if (event.statusText === undefined) {
			statuses.delete(event.statusKey);
		} else if (normalizedStatusText !== undefined) {
			if (normalizedStatusText) statuses.set(event.statusKey, normalizedStatusText);
			else statuses.delete(event.statusKey);
		} else {
			return;
		}

		if (sessionPath && previous !== statuses.get(event.statusKey)) {
			this.pushExtensionStatusesToSubscribers(sessionPath);
		}
	}

	private beginPendingExtensionStatusCapture(proc: RpcProcess, sessionPath?: string): void {
		const existing = sessionPath ? this.extensionStatusesBySession.get(sessionPath) : undefined;
		this.pendingExtensionStatuses.set(proc, new Map(existing ?? []));
	}

	private commitPendingExtensionStatuses(proc: RpcProcess, sessionPath: string): void {
		const pending = this.pendingExtensionStatuses.get(proc);
		this.pendingExtensionStatuses.delete(proc);
		if (pending) this.extensionStatusesBySession.set(sessionPath, pending);
		else if (!this.extensionStatusesBySession.has(sessionPath)) {
			this.extensionStatusesBySession.set(sessionPath, new Map());
		}
		this.pushExtensionStatusesToSubscribers(sessionPath);
	}

	private makeExtensionStatusMessage(sessionPath: string): ExtensionStatusPayload {
		return {
			type: "extension_status",
			sessionPath,
			statuses: extensionStatusSnapshot(this.extensionStatusesBySession.get(sessionPath)),
		};
	}

	private makeProviderUsageMessage(): ProviderUsagePayload {
		return {
			type: "provider_usage",
			statuses: Object.fromEntries(this.providerUsageStatuses),
		};
	}

	private pushExtensionStatusesToSubscribers(sessionPath: string): void {
		const message = encodeServerMessage(this.makeExtensionStatusMessage(sessionPath));
		for (const [ws, client] of this.clients) {
			if (client.subscribedSession !== sessionPath || ws.readyState !== FRAME_CONNECTION_OPEN) continue;
			ws.send(message);
		}
	}


	/**
	 * Called by the file watcher when a JSONL file changes on disk.
	 * Detached writes are coalesced per session so a burst is read, diffed, and
	 * published once at its trailing edge. Attached actor events remain authoritative.
	 */
	notifySessionFileChanged(sessionPath: string): void {
		if (this.registry.find(sessionPath)?.isAttached || !this.hasSubscribers(sessionPath)) return;
		const pending = this.pendingDetachedSyncs.get(sessionPath);
		if (pending) clearTimeout(pending);
		const timer = setTimeout(() => {
			this.pendingDetachedSyncs.delete(sessionPath);
			this.flushDetachedSessionSync(sessionPath);
		}, DETACHED_SYNC_COALESCE_MS);
		timer.unref?.();
		this.pendingDetachedSyncs.set(sessionPath, timer);
	}

	private hasSubscribers(sessionPath: string): boolean {
		for (const client of this.clients.values()) {
			if (client.subscribedSession === sessionPath) return true;
		}
		return false;
	}

	private flushDetachedSessionSync(sessionPath: string): void {
		if (this.registry.find(sessionPath)?.isAttached || !this.hasSubscribers(sessionPath)) return;
		const oldSize = this.subscribedFileSizes.get(sessionPath) ?? 0;
		const newSize = getSessionFileSize(sessionPath);
		if (newSize === oldSize) return;
		this.subscribedFileSizes.set(sessionPath, newSize);
		const { json, hash } = readSessionFromDisk(sessionPath);
		this.pushSnapshotToSubscribers(sessionPath, json, hash);
	}

	getDebugState() {
		const processes = this.pool.getAllProcesses().map((proc) => ({
			id: proc.id,
			pid: proc.process.pid ?? null,
			alive: proc.process.exitCode === null,
			exitCode: proc.process.exitCode,
			cwd: proc.cwd,
			busy: this.pool.isLeased(proc),
			decommissioning: this.pool.isDecommissioning(proc),
			attachedSession: this.registry.getActorForProcess(proc)?.sessionPath ?? null,
			pendingRequests: proc.pendingRequests.size,
		}));

		return {
			now: new Date().toISOString(),
			totalProcesses: this.pool.totalProcesses,
			attachedSessionCount: this.registry.attachedCount,
			attachedSessionPaths: processes
				.map((process) => process.attachedSession)
				.filter((sessionPath): sessionPath is string => sessionPath !== null),
			sessionStatuses: this.registry.getAllStatuses(),
			connectedWsOpen: Array.from(this.clients.keys()).filter((ws) => ws.readyState === FRAME_CONNECTION_OPEN).length,
			processes,
		};
	}

	register(wss: WebSocketServer): void {
		wss.on("connection", (ws, req) => {
			if (!this.isRequestAuthorized(req)) {
				ws.close(1008, "Unauthorized");
				return;
			}
			this.acceptConnection(new WebSocketFrameConnection(ws));
		});
	}

	acceptAuthenticatedConnection(connection: ServerFrameConnection): void {
		this.acceptConnection(connection);
	}

	private acceptConnection(ws: ServerFrameConnection): void {
		console.log("Frame client connected");
		this.clients.set(ws, {
			subscribedSession: null,
			lastVersion: 0,
			lastJson: "",
			lastHash: "",
		});

		this.sendMessage(ws, {
			type: "init",
			sessionStatuses: this.registry.getAllStatuses(),
			steeringQueues: this.registry.getAllSteeringQueues(),
			providerUsageStatuses: this.makeProviderUsageMessage().statuses,
		});

		if (!this.piAvailable) {
			this.sendMessage(ws, {
				type: "pi_install_required",
				command: this.piLaunch.command,
				installable: isPiInstallable(this.piLaunch.command, this.piLaunch.baseArgs),
				installing: this.piInstalling,
				message: makePiNotFoundMessage(this.piLaunch.command),
			});
		}

		ws.on("message", (raw) => this.handleMessage(ws, raw.toString()));
		ws.on("close", () => {
			console.log("Frame client disconnected");
			this.clients.delete(ws);
		});
	}

	private sendMessage(ws: ServerFrameConnection, payload: ServerMessagePayload): void {
		if (ws.readyState !== FRAME_CONNECTION_OPEN) return;
		ws.send(encodeServerMessage(payload), payload.type === "session_sync"
			? { priority: "bulk", transferKey: SESSION_SYNC_TRANSFER_KEY }
			: { priority: "control" });
	}

	private sendSuccess<Type extends ClientCommandType>(
		ws: ServerFrameConnection,
		id: string,
		command: Type,
		data: CommandResponseData<Type>,
	): void {
		this.sendMessage(ws, {
			type: "response",
			id,
			command,
			success: true,
			data,
		} as ServerMessagePayload);
	}

	private sendError(
		ws: ServerFrameConnection,
		id: string | null,
		command: string,
		error: string,
		code: "invalid_json" | "invalid_message" | "unsupported_version" | "unknown_command" | "unknown_message" | "command_failed",
	): void {
		this.sendMessage(ws, { type: "response", id, command, success: false, code, error });
	}

	notifySessionsChanged(file: string): void {
		this.broadcast({ type: "sessions_changed", file });
	}

	private broadcast(payload: ServerMessagePayload): void {
		const message = encodeServerMessage(payload);
		for (const ws of this.clients.keys()) {
			if (ws.readyState === FRAME_CONNECTION_OPEN) ws.send(message);
		}
	}

	private async handleMessage(ws: ServerFrameConnection, raw: string): Promise<void> {
		const decoded = decodeClientCommand(raw);
		if (!decoded.ok) {
			this.sendError(
				ws,
				decoded.error.requestId,
				decoded.error.command,
				decoded.error.message,
				decoded.error.code,
			);
			return;
		}

		const command = decoded.value;
		const id = command.id;
		try {
			if (!this.piAvailable && command.type !== "install_pi" && command.type !== "get_session_statuses") {
				this.sendMessage(ws, {
					type: "pi_install_required",
					command: this.piLaunch.command,
					installable: isPiInstallable(this.piLaunch.command, this.piLaunch.baseArgs),
					installing: this.piInstalling,
					message: makePiNotFoundMessage(this.piLaunch.command),
				});
				this.sendError(
					ws,
					id,
					command.type,
					makePiNotFoundMessage(this.piLaunch.command),
					"command_failed",
				);
				return;
			}

			switch (command.type) {
				case "install_pi":
					await this.handleInstallPi(ws, command);
					break;
				case "subscribe_session":
					this.handleSubscribeSession(ws, command);
					break;
				case "prompt":
					await this.handlePrompt(ws, command);
					break;
				case "steer":
					await this.handleSteer(ws, command);
					break;
				case "remove_steering":
					await this.handleRemoveSteering(ws, command);
					break;
				case "abort":
					await this.handleAbort(ws, command);
					break;
				case "hard_kill":
					await this.handleHardKill(ws, command);
					break;
				case "compact":
					await this.handleCompact(ws, command);
					break;
				case "get_available_models":
					await this.handleGetAvailableModels(ws, command);
					break;
				case "get_default_model":
					await this.handleGetDefaultModel(ws, command);
					break;
				case "get_session_statuses":
					this.handleGetSessionStatuses(ws, command);
					break;
				case "get_session_stats":
					await this.handleGetSessionStats(ws, command);
					break;
				case "fork":
					await this.handleFork(ws, command);
					break;
				case "fork_prompt":
					await this.handleForkPrompt(ws, command);
					break;
				case "set_session_name":
					await this.handleSetSessionName(ws, command);
					break;
				case "get_commands":
					await this.handleGetCommands(ws, command);
					break;
				case "reload_processes":
					await this.handleReloadProcesses(ws, command);
					break;
				default:
					assertNever(command);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debugTurn("command_error", { commandType: command.type, requestId: id, error: message });
			this.sendError(ws, id, command.type, message, "command_failed");
		}
	}

	private async handleInstallPi(ws: ServerFrameConnection, command: CommandOf<"install_pi">): Promise<void> {
		const installable = isPiInstallable(this.piLaunch.command, this.piLaunch.baseArgs);
		if (!installable) {
			throw new Error(`Automatic install not supported for command '${this.piLaunch.command}'. Set PI_CLI or install manually.`);
		}
		if (!this.piInstalling) {
			this.piInstalling = true;
			this.broadcast({
				type: "pi_install_required",
				command: this.piLaunch.command,
				installable: true,
				installing: true,
				message: "Installing pi...",
			});
			const ok = await installPiGlobal();
			this.piInstalling = false;
			this.piAvailable = checkCommandAvailable(this.piLaunch.command);
			if (!ok || !this.piAvailable) {
				throw new Error("pi installation failed. Please install manually and restart the server.");
			}
			console.log("[pi] pi installed successfully");
			this.ensurePool();
		}
		this.sendSuccess(ws, command.id, "install_pi", {});
	}

	private handleSubscribeSession(ws: ServerFrameConnection, command: CommandOf<"subscribe_session">): void {
		const client = this.clients.get(ws);
		if (!client) return;
		const requestedPath = command.sessionPath;

		if (!requestedPath) {
			ws.cancelTransfer?.(SESSION_SYNC_TRANSFER_KEY);
			client.subscribedSession = null;
			client.lastVersion = 0;
			client.lastJson = "";
			client.lastHash = "";
			this.sendSuccess(ws, command.id, "subscribe_session", {});
			return;
		}

		let sessionPath: string;
		try {
			sessionPath = this.sessionPaths.resolveExisting(requestedPath);
		} catch (error) {
			// Pi allocates a new path before its first prompt flushes the file. The
			// actor proves that such a confined pending path belongs to this server.
			if (!(error instanceof SessionPathError) || error.code !== "not_found") throw error;
			const pendingPath = this.sessionPaths.resolvePending(requestedPath);
			if (!this.registry.find(pendingPath)?.isAttached) throw error;
			sessionPath = pendingPath;
		}
		// A newly selected session makes every queued chunk from the previous
		// snapshot stale. The carrier emits a cancellation for a partial frame.
		ws.cancelTransfer?.(SESSION_SYNC_TRANSFER_KEY);
		client.subscribedSession = sessionPath;
		client.lastVersion = 0;
		client.lastJson = "";
		client.lastHash = "";

		// If the session is attached, send from its actor-owned in-memory state
		const attached = this.registry.find(sessionPath)?.session;
		if (attached) {
			// Send full sync
			client.lastJson = attached.json;
			client.lastHash = attached.hash;
			client.lastVersion = attached.version;
			this.sendMessage(ws, {
				type: "session_sync",
				sessionPath,
				revision: this.revisionForState(sessionPath, attached.hash),
				op: "full",
				data: attached.json,
				hash: attached.hash,
			});
		} else {
			// Detached — read from disk
			const { json, hash } = readSessionFromDisk(sessionPath);
			client.lastJson = json;
			client.lastHash = hash;
			client.lastVersion = 0;
			// Track file size for change detection
			this.subscribedFileSizes.set(sessionPath, getSessionFileSize(sessionPath));
			this.sendMessage(ws, {
				type: "session_sync",
				sessionPath,
				revision: this.revisionForState(sessionPath, hash),
				op: "full",
				data: json,
				hash,
			});
		}

		// Extension status is a separate, authoritative snapshot so reconnects
		// and session switches replace rather than merge stale client state.
		this.sendMessage(ws, this.makeExtensionStatusMessage(sessionPath));
		this.sendSuccess(ws, command.id, "subscribe_session", {});
	}

	private async handlePrompt(ws: ServerFrameConnection, command: CommandOf<"prompt">): Promise<void> {
		const requestedPath = command.sessionPath;
		if (!requestedPath) throw new Error("Missing sessionPath");
		let sessionPath = requestedPath === "__new__"
			? requestedPath
			: this.sessionPaths.resolveExisting(requestedPath);

		const turnId = makeTurnId();
		debugTurn("prompt_start", { turnId, sessionPath, hasModel: !!command.model });

		let actor: SessionActor | undefined;
		let proc: RpcProcess | undefined;
		let unownedLease: RpcProcessLease | undefined;
		let generation: number | undefined;
		try {
			let newSessionCwd: string | undefined;
			if (sessionPath === "__new__") {
				newSessionCwd = command.cwd as string || this.defaultCwd;
				unownedLease = await this.acquireProcess(newSessionCwd);
				proc = unownedLease.process;
				await this.pool.waitForReady(proc);
				this.beginPendingExtensionStatusCapture(proc);
				await this.replacePiSession(proc, { type: "new_session" }, "new_session");
				const stateResp = await this.pool.sendRpcChecked(proc, { type: "get_state" });
				const createdPath = stateResp.data.sessionFile;
				if (!createdPath) throw new Error("Failed to get session path from new session");
				sessionPath = this.sessionPaths.resolvePending(createdPath);
			}

			actor = this.registry.get(sessionPath);
			const start = await actor.enqueue("prompt start", async () => {
				// A second prompt that arrived during startup observes the committed
				// actor phase and becomes steering rather than a second turn owner.
				if (actor!.isTurnActive) {
					await this.sendSteering(actor!, command.message);
					return undefined;
				}
				actor!.assertAvailable("start prompt");

				if (unownedLease) {
					proc = unownedLease.process;
					actor!.attach(unownedLease, this.createSessionState(sessionPath));
					unownedLease = undefined;
					this.commitPendingExtensionStatuses(proc, sessionPath);
					this.sendMessage(ws, {
						type: "session_attached",
						sessionPath,
						cwd: newSessionCwd,
						firstMessage: command.message,
					});
				} else {
					proc = await this.acquireForActor(actor!);
				}

				generation = actor!.beginTurn();
				const observer = this.setupTurnEventForwarding(actor!, proc!, generation, turnId);
				await this.applyRequestedControlState(proc!, actor!, ws, command);

				const response = await this.pool.sendRpc(proc!, {
					type: "prompt",
					message: command.message,
					...(command.images?.length ? { images: command.images } : {}),
				});
				if (!response.success) throw new Error(response.error);
				await this.reconcileEffectiveControlState(proc!, actor!);
				return { observer, response, generation };
			});

			if (!start) {
				this.sendSuccess(ws, command.id, "prompt", { newSessionPath: sessionPath });
				return;
			}

			await this.waitForPromptSettlement(proc!, start.observer);
			await actor.enqueue("prompt settlement", async () => {
				if (!actor!.owns(proc!, start.generation)) return;
				await this.reconcileEffectiveControlState(proc!, actor!);
				this.releaseActor(actor!);
			});

			this.sendSuccess(ws, command.id, "prompt", { newSessionPath: sessionPath });
		} catch (error) {
			if (proc) this.pendingExtensionStatuses.delete(proc);
			unownedLease?.release();
			if (actor && proc && actor.process === proc) {
				let detailed = this.buildPromptFailureMessage(error, proc, actor);
				await actor.enqueue("prompt failure", () => {
					if (actor!.process !== proc) return;
					detailed = this.buildPromptFailureMessage(error, proc!, actor!);
					actor!.markFailed();
					this.injectSessionError(actor!, detailed);
					this.releaseActor(actor!);
				});
				const rawMessage = error instanceof Error ? error.message : String(error);
				if (rawMessage.includes("Timeout waiting for RPC response to prompt") && proc.process.exitCode === null) {
					proc.process.kill("SIGTERM");
				}
				throw new Error(detailed);
			}
			if (proc && proc.process.exitCode === null) proc.process.kill("SIGTERM");
			throw error;
		}
	}

	private async handleSteer(ws: ServerFrameConnection, command: CommandOf<"steer">): Promise<void> {
		const sessionPath = command.sessionPath;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const actor = this.registry.find(sessionPath);
		if (!actor) throw new Error("Session is not attached (agent not running)");
		await actor.enqueue("steer", () => this.sendSteering(actor, command.message));
		this.sendSuccess(ws, command.id, "steer", {});
	}

	private async handleRemoveSteering(ws: ServerFrameConnection, command: CommandOf<"remove_steering">): Promise<void> {
		const sessionPath = command.sessionPath;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const index = command.index;
		if (typeof index !== "number") throw new Error("Missing index");

		const actor = this.registry.find(sessionPath);
		if (actor) await actor.enqueue("remove steering", () => actor.removeSteeringByIndex(index));
		this.sendSuccess(ws, command.id, "remove_steering", {});
	}

	private async handleAbort(ws: ServerFrameConnection, command: CommandOf<"abort">): Promise<void> {
		const sessionPath = command.sessionPath;
		const actor = sessionPath ? this.registry.find(sessionPath) : undefined;
		if (actor) {
			await actor.enqueue("abort", async () => {
				if (actor.isTurnActive && actor.process) {
					await this.pool.sendRpc(actor.process, { type: "abort" });
				}
			});
		}
		this.sendSuccess(ws, command.id, "abort", {});
	}

	private async handleHardKill(ws: ServerFrameConnection, command: CommandOf<"hard_kill">): Promise<void> {
		const sessionPath = command.sessionPath;
		if (!sessionPath) throw new Error("Missing sessionPath");

		const actor = this.registry.find(sessionPath);
		let hadProcess = false;
		let killed = false;
		if (actor) {
			await actor.enqueue("hard kill", () => {
				const proc = actor.process;
				if (!proc) return;
				hadProcess = true;
				killed = this.pool.forceKill(proc);
				actor.markFailed();
				this.releaseActor(actor, false);
			});
		}

		if (hadProcess) this.ensurePool();
		this.sendSuccess(
			ws,
			command.id,
			"hard_kill",
			killed
				? { killed: true }
				: { killed: false, reason: hadProcess ? "signal_failed" : "not_attached" },
		);
	}

	private async handleCompact(ws: ServerFrameConnection, command: CommandOf<"compact">): Promise<void> {
		const sessionPath = this.sessionPaths.resolveExisting(command.sessionPath);
		const actor = this.registry.get(sessionPath);
		const response = await actor.enqueue("compact", async () => {
			actor.assertAvailable("compact");
			const proc = await this.acquireForActor(actor);
			try {
				// Pi returns only after the summarization model call and session write.
				// The generic 30s RPC timeout can expire while compaction is healthy,
				// causing its eventual response and compaction_end event to be orphaned.
				return await this.pool.sendRpc(
					proc,
					{ type: "compact", customInstructions: command.customInstructions },
					COMPACT_RPC_TIMEOUT_MS,
				);
			} finally {
				this.releaseActor(actor);
			}
		});
		if (!response.success) throw new Error(response.error);
		this.sendSuccess(ws, command.id, "compact", { ...response.data });
	}

	private async handleGetAvailableModels(ws: ServerFrameConnection, command: CommandOf<"get_available_models">): Promise<void> {
		const lease = await this.acquireAnyProcess();
		try {
			const response = await this.pool.sendRpcChecked(lease.process, { type: "get_available_models" });
			this.sendSuccess(ws, command.id, "get_available_models", {
				models: response.data.models as unknown as CommandResponseData<"get_available_models">["models"],
			});
		} finally {
			lease.release();
		}
	}

	private async handleGetCommands(ws: ServerFrameConnection, command: CommandOf<"get_commands">): Promise<void> {
		let cwd = command.cwd || this.defaultCwd;
		if (command.sessionPath) {
			const sessionPath = this.sessionPaths.resolveExisting(command.sessionPath);
			const sessionCwd = getSessionCwd(sessionPath);
			cwd = sessionCwd && existsSync(sessionCwd) ? sessionCwd : this.defaultCwd;
		}

		// Project prompts and skills are loaded when Pi starts, so command discovery
		// must use a process for the conversation's cwd rather than any idle worker.
		const lease = await this.acquireProcess(cwd);
		try {
			const response = await this.pool.sendRpcChecked(lease.process, { type: "get_commands" });
			this.sendSuccess(ws, command.id, "get_commands", {
				commands: response.data.commands as unknown as CommandResponseData<"get_commands">["commands"],
			});
		} finally {
			lease.release();
		}
	}

	private async handleReloadProcesses(ws: ServerFrameConnection, command: CommandOf<"reload_processes">): Promise<void> {
		const { killed, draining } = this.pool.decommissionAll();
		this.ensurePool();
		this.sendSuccess(ws, command.id, "reload_processes", { killed, draining });
	}

	private async handleGetDefaultModel(ws: ServerFrameConnection, command: CommandOf<"get_default_model">): Promise<void> {
		const lease = await this.acquireAnyProcess();
		try {
			const stateResp = await this.pool.sendRpcChecked(lease.process, { type: "get_state" });
			const model = stateResp.data.model ?? null;
			const thinkingLevel = stateResp.data.thinkingLevel;
			this.sendSuccess(ws, command.id, "get_default_model", {
				model: model as CommandResponseData<"get_default_model">["model"],
				thinkingLevel,
			});
		} finally {
			lease.release();
		}
	}

	private handleGetSessionStatuses(ws: ServerFrameConnection, command: CommandOf<"get_session_statuses">): void {
		this.sendSuccess(ws, command.id, "get_session_statuses", { statuses: this.registry.getAllStatuses() });
	}

	private async handleGetSessionStats(ws: ServerFrameConnection, command: CommandOf<"get_session_stats">): Promise<void> {
		const sessionPath = this.sessionPaths.resolveExisting(command.sessionPath);
		const actor = this.registry.get(sessionPath);
		const response = await actor.enqueue("get session stats", async () => {
			const wasAttached = actor.process !== undefined;
			const proc = await this.acquireForActor(actor);
			try {
				return await this.pool.sendRpcChecked(proc, { type: "get_session_stats" });
			} finally {
				// A running turn owns its process lease. Only release a lease acquired
				// temporarily to inspect a detached session.
				if (!wasAttached) this.releaseActor(actor);
			}
		});
		this.sendSuccess(ws, command.id, "get_session_stats", {
			...response.data,
			sessionFile: response.data.sessionFile ?? sessionPath,
		});
	}

	private async handleFork(ws: ServerFrameConnection, command: CommandOf<"fork">): Promise<void> {
		const sessionPath = this.sessionPaths.resolveExisting(command.sessionPath);
		const entryId = command.entryId;
		if (!entryId) throw new Error("Missing entryId");

		const actor = this.registry.get(sessionPath);
		const result = await actor.enqueue("fork", async () => {
			actor.assertAvailable("fork");
			const proc = await this.acquireForActor(actor);
			try {
				const response = await this.pool.sendRpcChecked(proc, { type: "fork", entryId });
				const stateResp = await this.pool.sendRpcChecked(proc, { type: "get_state" });
				const returnedPath = stateResp.data.sessionFile;
				return {
					response,
					newSessionPath: returnedPath
						? this.sessionPaths.resolveExisting(returnedPath)
						: undefined,
				};
			} finally {
				this.releaseActor(actor);
			}
		});

		this.sendSuccess(ws, command.id, "fork", {
			text: result.response.data.text,
			cancelled: result.response.data.cancelled,
			newSessionPath: result.newSessionPath ?? null,
		});
	}

	private async handleForkPrompt(ws: ServerFrameConnection, command: CommandOf<"fork_prompt">): Promise<void> {
		const sessionPath = this.sessionPaths.resolveExisting(command.sessionPath);
		const message = command.message;
		if (!message) throw new Error("Missing message");

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const newId = crypto.randomUUID().slice(0, 8);
		let newSessionPath = this.sessionPaths.createPath(`${timestamp}_${newId}.jsonl`);
		const sourceActor = this.registry.get(sessionPath);
		await sourceActor.enqueue("fork prompt source", async () => {
			sourceActor.assertAvailable("fork and prompt");
			await copyFile(sessionPath, newSessionPath, fsConstants.COPYFILE_EXCL);
			newSessionPath = this.sessionPaths.resolveExisting(newSessionPath);
		});

		const forkCwd = getSessionCwd(sessionPath);
		const cwd = (forkCwd && existsSync(forkCwd)) ? forkCwd : this.defaultCwd;
		const actor = this.registry.get(newSessionPath);
		let proc: RpcProcess | undefined;
		let unownedLease: RpcProcessLease | undefined;
		try {
			const start = await actor.enqueue("fork prompt start", async () => {
				actor.assertAvailable("fork and prompt");
				unownedLease = await this.acquireProcess(cwd);
				proc = unownedLease.process;
				await this.pool.waitForReady(proc);
				this.beginPendingExtensionStatusCapture(proc);
				await this.replacePiSession(
					proc,
					{ type: "switch_session", sessionPath: newSessionPath },
					"switch_session",
				);
				actor.attach(unownedLease, this.createSessionState(newSessionPath));
				unownedLease = undefined;
				this.commitPendingExtensionStatuses(proc, newSessionPath);
				this.sendMessage(ws, { type: "session_attached", sessionPath: newSessionPath, cwd, firstMessage: message });

				const generation = actor.beginTurn();
				const observer = this.setupTurnEventForwarding(actor, proc, generation, makeTurnId());
				await this.applyRequestedControlState(proc, actor, ws, command);
				await this.pool.sendRpcChecked(proc, {
					type: "prompt",
					message,
					...(command.images?.length ? { images: command.images } : {}),
				});
				await this.reconcileEffectiveControlState(proc, actor);
				return { observer, generation };
			});

			await this.waitForPromptSettlement(proc!, start.observer);
			await actor.enqueue("fork prompt settlement", async () => {
				if (!actor.owns(proc!, start.generation)) return;
				await this.reconcileEffectiveControlState(proc!, actor);
				this.releaseActor(actor);
			});
			this.sendSuccess(ws, command.id, "fork_prompt", { newSessionPath });
		} catch (error) {
			if (proc) this.pendingExtensionStatuses.delete(proc);
			unownedLease?.release();
			if (proc && actor.process === proc) {
				let detailed = this.buildPromptFailureMessage(error, proc, actor);
				await actor.enqueue("fork prompt failure", () => {
					if (actor.process !== proc) return;
					detailed = this.buildPromptFailureMessage(error, proc!, actor);
					actor.markFailed();
					this.injectSessionError(actor, detailed);
					this.releaseActor(actor);
				});
				const rawMessage = error instanceof Error ? error.message : String(error);
				if (rawMessage.includes("Timeout waiting for RPC response to prompt") && proc.process.exitCode === null) {
					proc.process.kill("SIGTERM");
				}
				throw new Error(detailed);
			}
			if (proc && proc.process.exitCode === null) proc.process.kill("SIGTERM");
			throw error;
		}
	}

	private async handleSetSessionName(ws: ServerFrameConnection, command: CommandOf<"set_session_name">): Promise<void> {
		const sessionPath = this.sessionPaths.resolveExisting(command.sessionPath);
		const actor = this.registry.get(sessionPath);
		const response = await actor.enqueue("set session name", async () => {
			actor.assertAvailable("rename session");
			const proc = await this.acquireForActor(actor);
			try {
				return await this.pool.sendRpc(proc, { type: "set_session_name", name: command.name });
			} finally {
				this.releaseActor(actor);
			}
		});
		if (!response.success) throw new Error(response.error);
		this.sendSuccess(ws, command.id, "set_session_name", {});
	}

	// ── Internal helpers ─────────────────────────────────────────────────

	private async replacePiSession(
		proc: RpcProcess,
		command: { type: "new_session" } | { type: "switch_session"; sessionPath: string },
		operation: string,
	): Promise<void> {
		const response = await this.pool.sendRpcChecked(proc, command);
		if (response.data?.cancelled) {
			throw new Error(`Pi ${operation} was cancelled`);
		}
	}

	/**
	 * Apply a client's requested controls as one ordered RPC transaction, then
	 * publish pi's effective (possibly clamped) state before the prompt starts.
	 */
	private async applyRequestedControlState(
		proc: RpcProcess,
		actor: SessionActor,
		ws: ServerFrameConnection,
		command: ControlCommand,
	): Promise<void> {
		const sessionPath = actor.sessionPath;
		if (!command.model) {
			throw new Error(`BUG: prompt command received without model. sessionPath=${sessionPath}`);
		}

		let stateResponse = await this.pool.sendRpcChecked(proc, { type: "get_state" });
		if (!modelsMatch(stateResponse.data?.model, command.model)) {
			await this.pool.sendRpcChecked(proc, {
				type: "set_model",
				provider: command.model.provider,
				modelId: command.model.modelId,
			});
		}
		if (typeof command.thinkingLevel === "string") {
			await this.pool.sendRpcChecked(proc, {
				type: "set_thinking_level",
				level: command.thinkingLevel,
			});
		}

		// set_thinking_level has no effective value in its response and set_model
		// may clamp effort, so get_state is the authoritative transaction result.
		stateResponse = await this.pool.sendRpcChecked(proc, { type: "get_state" });
		const activeModel = stateResponse.data?.model;
		if (!modelsMatch(activeModel, command.model)) {
			throw new Error(`Failed to switch model to ${command.model.provider}/${command.model.modelId}`);
		}
		this.publishEffectiveControlState(actor, stateResponse.data);

		if (ws.readyState === FRAME_CONNECTION_OPEN) {
			this.sendMessage(ws, {
				type: "control_state",
				sessionPath,
				controlRevision: command.controlRevision,
				model: activeModel as unknown as NonNullable<CommandResponseData<"get_default_model">["model"]>,
				thinkingLevel: stateResponse.data.thinkingLevel,
			});
		}
	}

	private async waitForPromptSettlement(proc: RpcProcess, observer: TurnEventObserver): Promise<void> {
		const state = await this.pool.sendRpcChecked(proc, { type: "get_state" });
		// Pi >= 0.80 acknowledges a prompt only after preflight. Before that
		// acknowledgement is written, a real agent run synchronously marks the
		// session streaming; an extension-handled input remains idle and emits no
		// agent lifecycle. This authoritative state check avoids timing guesses.
		if (!state.data?.isStreaming && !observer.hasStarted()) return;

		let removeExitListener = () => {};
		const exited = new Promise<never>((_resolve, reject) => {
			if (proc.process.exitCode !== null) {
				reject(new Error(`pi process #${proc.id} exited before the turn settled`));
				return;
			}
			const onExit = () => reject(new Error(`pi process #${proc.id} exited before the turn settled`));
			proc.process.once("exit", onExit);
			removeExitListener = () => proc.process.removeListener("exit", onExit);
		});

		try {
			await Promise.race([observer.settled, exited]);
		} finally {
			removeExitListener();
		}
	}

	/** Refresh controls after extensions or model clamps that happened in-turn. */
	private async reconcileEffectiveControlState(proc: RpcProcess, actor: SessionActor): Promise<void> {
		const stateResponse = await this.pool.sendRpcChecked(proc, { type: "get_state" });
		this.publishEffectiveControlState(actor, stateResponse.data);
	}

	private publishEffectiveControlState(actor: SessionActor, rpcState: RpcSessionState): void {
		const session = actor.session;
		if (!session) return;
		const model = toCompactModelRef(rpcState?.model ?? {});
		if (!model) return;
		const changed = session.setControlState(model, rpcState?.thinkingLevel ?? "off");
		if (changed) this.pushUpdateToSubscribers(actor.sessionPath, session);
	}

	private buildPromptFailureMessage(err: unknown, proc: RpcProcess, actor: SessionActor): string {
		const raw = err instanceof Error ? err.message : String(err);
		const sessionError = actor.session?.toState().error;
		const stderrTail = this.pool.getRecentStderr(proc, 12);

		let message = raw;
		if (raw.includes("Timeout waiting for RPC response to prompt")) {
			message = "Prompt timed out waiting for pi RPC response";
		}
		if (sessionError) {
			message += `\nLast agent error: ${sessionError}`;
		}
		if (stderrTail.length > 0) {
			message += `\nRecent pi stderr:\n${stderrTail.join("\n")}`;
		}
		return message;
	}

	private injectSessionError(actor: SessionActor, errorMessage: string): void {
		const session = actor.session;
		if (!session) return;
		session.applyEvent({
			type: "turn_end",
			message: { role: "assistant", errorMessage },
		} as any);
		this.pushUpdateToSubscribers(actor.sessionPath, session);
	}

	private async sendSteering(actor: SessionActor, message: string): Promise<void> {
		if (!actor.isTurnActive || !actor.process) {
			throw new Error("Session is not attached (agent not running)");
		}
		actor.enqueueSteering(message);
		try {
			await this.pool.sendRpc(actor.process, { type: "steer", message });
		} catch (error) {
			actor.dequeueSteering(message);
			throw error;
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Build the active materialized view owned by a SessionActor. */
	private createSessionState(sessionPath: string): SessionJsonl {
		const { state } = readSessionFromDisk(sessionPath);
		return new SessionJsonl({
			messages: state.messages,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			toolCallTimings: state.toolCallTimings,
		});
	}

	/** Acquire, switch, and transfer a process lease to a detached actor. */
	private async acquireForActor(actor: SessionActor): Promise<RpcProcess> {
		if (actor.process) return actor.process;
		const sessionPath = actor.sessionPath;
		const sessionCwd = getSessionCwd(sessionPath);
		const cwd = (sessionCwd && existsSync(sessionCwd)) ? sessionCwd : this.defaultCwd;
		const lease = await this.acquireProcess(cwd);
		const proc = lease.process;
		this.beginPendingExtensionStatusCapture(proc, sessionPath);
		try {
			await this.replacePiSession(
				proc,
				{ type: "switch_session", sessionPath },
				"switch_session",
			);
			actor.attach(lease, this.createSessionState(sessionPath));
			this.commitPendingExtensionStatuses(proc, sessionPath);
		} catch (err) {
			this.pendingExtensionStatuses.delete(proc);
			if (actor.process === proc) actor.detach();
			else lease.release();
			throw err;
		}
		console.log(`[ws] pi#${proc.id} attached to ${path.basename(sessionPath)} (cwd: ${cwd})`);
		return proc;
	}

	/** Acquire an atomically reserved process lease for a cwd. */
	private async acquireProcess(cwd: string): Promise<RpcProcessLease> {
		if (!this.piAvailable) throw new Error(makePiNotFoundMessage(this.piLaunch.command));
		const timeoutMs = 60000;
		const start = Date.now();
		while (true) {
			const lease = this.pool.acquire(cwd);
			if (lease) return lease;
			if (this.pool.evictIdleDifferentCwd(cwd)) {
				await this.sleep(50);
				continue;
			}
			if (Date.now() - start >= timeoutMs) {
				throw new Error(`Timed out waiting for available pi process for cwd: ${cwd}`);
			}
			await this.sleep(100);
		}
	}

	private async acquireAnyProcess(): Promise<RpcProcessLease> {
		const existing = this.pool.acquireAny();
		if (existing) return existing;
		return this.acquireProcess(this.defaultCwd);
	}

	private releaseActor(actor: SessionActor, preserveLiveControls = true): void {
		const sessionPath = actor.sessionPath;
		const proc = actor.process;
		const liveState = actor.session?.toState();
		if (proc) this.pendingExtensionStatuses.delete(proc);
		actor.detach();

		// Read final messages from disk, but preserve the just-reconciled controls.
		// This prevents JSONL flush timing from regressing the detach snapshot.
		const disk = readSessionFromDisk(sessionPath);
		if (liveState) {
			if (preserveLiveControls) {
				disk.state.model = liveState.model;
				disk.state.thinkingLevel = liveState.thinkingLevel;
			}
			disk.state.toolCallTimings = liveState.toolCallTimings;
			disk.state.error = liveState.error;
		}
		const { json, hash } = serializeSessionState(disk.state);
		this.subscribedFileSizes.set(sessionPath, getSessionFileSize(sessionPath));
		this.pushSnapshotToSubscribers(sessionPath, json, hash);
	}

	private revisionForState(sessionPath: string, hash: string): number {
		const current = this.sessionRevisions.get(sessionPath);
		if (current?.hash === hash) return current.revision;
		const revision = (current?.revision ?? 0) + 1;
		this.sessionRevisions.set(sessionPath, { revision, hash });
		return revision;
	}

	private pushSnapshotToSubscribers(sessionPath: string, json: string, hash: string) {
		const revision = this.revisionForState(sessionPath, hash);
		for (const [ws, client] of this.clients) {
			if (client.subscribedSession !== sessionPath || ws.readyState !== FRAME_CONNECTION_OPEN) continue;
			if (client.lastHash === hash) continue;
			const sync = computeSyncOp(client.lastJson, json, client.lastHash, hash);
			this.sendMessage(ws, {
				type: "session_sync",
				sessionPath,
				revision,
				...sync,
			});
			client.lastJson = json;
			client.lastHash = hash;
			client.lastVersion = 0;
		}
	}

	/**
	 * Push an update to all clients subscribed to an attached session.
	 * Uses the hash-verified diff protocol for efficient incremental sync.
	 */
	private pushUpdateToSubscribers(sessionPath: string, session: SessionJsonl) {
		const revision = this.revisionForState(sessionPath, session.hash);
		for (const [ws, client] of this.clients) {
			if (client.subscribedSession !== sessionPath) continue;
			if (ws.readyState !== FRAME_CONNECTION_OPEN) continue;

			const syncOp = session.computeSyncOp(client.lastJson, client.lastHash, client.lastVersion);
			if (!syncOp) continue;

			this.sendMessage(ws, {
				type: "session_sync",
				sessionPath,
				revision,
				...syncOp,
			});

			client.lastJson = session.json;
			client.lastHash = session.hash;
			client.lastVersion = session.version;
		}
	}

	private setupTurnEventForwarding(
		actor: SessionActor,
		proc: RpcProcess,
		generation: number,
		turnId: string,
	): TurnEventObserver {
		const sessionPath = actor.sessionPath;
		if (!actor.session || !actor.owns(proc, generation)) {
			throw new Error(`setupTurnEventForwarding called without actor ownership for ${sessionPath}`);
		}

		let hasStarted = false;
		let hasSettled = false;
		let resolveStarted!: () => void;
		let resolveEnded!: () => void;
		let resolveSettled!: () => void;
		const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
		const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
		const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });

		const eventHandler = (sourceProc: RpcProcess, data: RpcProcessEvent) => {
			if (sourceProc !== proc || data.type === "extension_ui_request") return;
			const replacementMessages = data.type === "compaction_end" && data.result
				? readSessionFromDisk(sessionPath).state.messages
				: undefined;

			void actor.applyProcessEvent(proc, generation, data, replacementMessages).then((result) => {
				if (!result.accepted) return;
				if (result.started) {
					hasStarted = true;
					resolveStarted();
				}
				if (result.ended) resolveEnded();
				if (result.settled) {
					hasSettled = true;
					resolveSettled();
				}

				if (result.changed && actor.session) {
					this.pushUpdateToSubscribers(sessionPath, actor.session);
				}
				if (data.type === "agent_end") {
					debugTurn("agent_end_received", { turnId, procId: proc.id, sessionPath });
				}
			}).catch((error) => {
				console.error(`[session-actor] Failed to apply ${data.type} for ${sessionPath}:`, error);
			});
		};

		const cleanup = this.pool.subscribeEvents(eventHandler);
		actor.setTurnEventCleanup(generation, cleanup);
		return {
			started,
			ended,
			settled,
			hasStarted: () => hasStarted,
			hasSettled: () => hasSettled,
		};
	}
}

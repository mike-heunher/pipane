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

import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SessionRegistry } from "./session-registry.js";
import type { SessionActor } from "./session-actor.js";
import { ProcessPool, type RpcProcess, type RpcProcessLease } from "./process-pool.js";
import {
	SessionJsonl,
	readSessionFromDisk,
	getSessionFileSize,
	serializeSessionState,
	type SessionState,
} from "./session-jsonl.js";
import { getSessionCwd } from "./session-cwd.js";
import { checkCommandAvailable, installPiGlobal, isPiInstallable, makePiNotFoundMessage } from "./pi-runtime.js";
import type { LoadTraceStore } from "./load-trace-store.js";
import { modelsMatch, toCompactModelRef } from "../shared/thinking-levels.js";
import { COMPACT_RPC_TIMEOUT_MS } from "../shared/rpc-timeouts.js";
import type { ExtensionStatusMessage, ProviderUsageMessage } from "../shared/ws-protocol.js";
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
	defaultCwd: string;
	piLaunch: { command: string; baseArgs: string[] };
	ensurePool: () => void;
	isRequestAuthorized: (req: IncomingMessage) => boolean;
	traceStore?: LoadTraceStore;
}

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

function debugTurn(stage: string, data: Record<string, any>) {
	console.log(`[turn] ${stage} ${JSON.stringify(data)}`);
}

export class WsHandler {
	private registry: SessionRegistry;
	private pool: ProcessPool;
	private defaultCwd: string;
	private piLaunch: { command: string; baseArgs: string[] };
	private ensurePool: () => void;
	private isRequestAuthorized: (req: IncomingMessage) => boolean;
	private traceStore?: LoadTraceStore;

	private clients = new Map<WebSocket, ClientState>();
	private wsTraceIds = new Map<WebSocket, string>();
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

	private piAvailable: boolean;
	private piInstalling = false;

	constructor(options: WsHandlerOptions) {
		this.registry = options.registry;
		this.pool = options.pool;
		this.defaultCwd = options.defaultCwd;
		this.piLaunch = options.piLaunch;
		this.ensurePool = options.ensurePool;
		this.isRequestAuthorized = options.isRequestAuthorized;
		this.traceStore = options.traceStore;
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

	private handleProcessEvent(proc: RpcProcess, event: Record<string, any>): void {
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

	private makeExtensionStatusMessage(sessionPath: string): ExtensionStatusMessage {
		return {
			type: "extension_status",
			sessionPath,
			statuses: extensionStatusSnapshot(this.extensionStatusesBySession.get(sessionPath)),
		};
	}

	private makeProviderUsageMessage(): ProviderUsageMessage {
		return {
			type: "provider_usage",
			statuses: Object.fromEntries(this.providerUsageStatuses),
		};
	}

	private pushExtensionStatusesToSubscribers(sessionPath: string): void {
		const message = JSON.stringify(this.makeExtensionStatusMessage(sessionPath));
		for (const [ws, client] of this.clients) {
			if (client.subscribedSession !== sessionPath || ws.readyState !== WebSocket.OPEN) continue;
			ws.send(message);
		}
	}

	private recordTrace(traceId: string | undefined, source: "frontend" | "backend", kind: "instant" | "span", name: string, durationMs?: number, attrs?: Record<string, any>) {
		if (!traceId || !this.traceStore) return;
		this.traceStore.record(traceId, {
			ts: new Date().toISOString(),
			source,
			kind,
			name,
			durationMs,
			attrs,
		});
	}

	private getTraceIdForMessage(ws: WebSocket, command: any): string | undefined {
		const fromCommand = command?.__trace?.traceId;
		if (typeof fromCommand === "string" && fromCommand.length > 0) return fromCommand;
		return this.wsTraceIds.get(ws);
	}

	/**
	 * Called by the file watcher when a JSONL file changes on disk.
	 * For detached sessions with subscribers, re-reads from disk and pushes a snapshot.
	 * Ignores attached sessions (their state comes from streaming events).
	 */
	notifySessionFileChanged(sessionPath: string): void {
		// If the session is attached, ignore — streaming events are authoritative
		if (this.registry.find(sessionPath)?.isAttached) return;

		// Check if any client is subscribed to this session
		let hasSubscribers = false;
		for (const [, client] of this.clients) {
			if (client.subscribedSession === sessionPath) {
				hasSubscribers = true;
				break;
			}
		}
		if (!hasSubscribers) return;

		// Check if the file actually changed
		const oldSize = this.subscribedFileSizes.get(sessionPath) ?? 0;
		const newSize = getSessionFileSize(sessionPath);
		if (newSize === oldSize) return;

		// File changed — read from disk and push snapshot to subscribers
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
			sessionStatuses: this.registry.getAllStatuses(),
			connectedWsOpen: Array.from(this.clients.keys()).filter((ws) => ws.readyState === WebSocket.OPEN).length,
			processes,
		};
	}

	register(wss: WebSocketServer): void {
		wss.on("connection", (ws, req) => this.handleConnection(ws, req));
	}

	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		if (!this.isRequestAuthorized(req)) {
			ws.close(1008, "Unauthorized");
			return;
		}

		const reqUrl = req.url || "/ws";
		const parsed = new URL(reqUrl, "http://localhost");
		const traceId = parsed.searchParams.get("traceId") || undefined;
		if (traceId) {
			this.wsTraceIds.set(ws, traceId);
			this.recordTrace(traceId, "backend", "instant", "ws connection open");
		}

		console.log("WebSocket client connected");
		this.clients.set(ws, {
			subscribedSession: null,
			lastVersion: 0,
			lastJson: "",
			lastHash: "",
		});

		ws.send(JSON.stringify({
			type: "init",
			sessionStatuses: this.registry.getAllStatuses(),
			steeringQueues: this.registry.getAllSteeringQueues(),
			providerUsageStatuses: this.makeProviderUsageMessage().statuses,
		}));

		if (!this.piAvailable) {
			ws.send(JSON.stringify({
				type: "pi_install_required",
				command: this.piLaunch.command,
				installable: isPiInstallable(this.piLaunch.command, this.piLaunch.baseArgs),
				installing: this.piInstalling,
				message: makePiNotFoundMessage(this.piLaunch.command),
			}));
		}

		ws.on("message", (raw) => this.handleMessage(ws, raw.toString()));
		ws.on("close", () => {
			const wsTraceId = this.wsTraceIds.get(ws);
			this.recordTrace(wsTraceId, "backend", "instant", "ws connection close");
			console.log("WebSocket client disconnected");
			this.clients.delete(ws);
			this.wsTraceIds.delete(ws);
		});
	}

	private broadcast(payload: any) {
		for (const ws of this.clients.keys()) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(payload));
			}
		}
	}

	private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
		let command: any;
		try {
			command = JSON.parse(raw);
		} catch {
			ws.send(JSON.stringify({ type: "response", command: "parse", success: false, error: "Invalid JSON" }));
			return;
		}

		const id = command.id;
		const traceId = this.getTraceIdForMessage(ws, command);
		const commandStart = performance.now();
		this.recordTrace(traceId, "backend", "instant", `ws command received: ${command.type}`);
		try {
			if (!this.piAvailable && command.type !== "install_pi" && command.type !== "get_session_statuses") {
				ws.send(JSON.stringify({
					type: "pi_install_required",
					command: this.piLaunch.command,
					installable: isPiInstallable(this.piLaunch.command, this.piLaunch.baseArgs),
					installing: this.piInstalling,
					message: makePiNotFoundMessage(this.piLaunch.command),
				}));
				if (id) {
					ws.send(JSON.stringify({
						id, type: "response", command: command.type, success: false,
						error: makePiNotFoundMessage(this.piLaunch.command),
					}));
				}
				return;
			}

			switch (command.type) {
				case "install_pi":
					await this.handleInstallPi(ws, id);
					break;
				case "subscribe_session":
					this.handleSubscribeSession(ws, id, command);
					break;
				case "prompt":
					await this.handlePrompt(ws, id, command);
					break;
				case "steer":
					await this.handleSteer(ws, id, command);
					break;
				case "remove_steering":
					await this.handleRemoveSteering(ws, id, command);
					break;
				case "abort":
					await this.handleAbort(ws, id, command);
					break;
				case "compact":
					await this.handleCompact(ws, id, command);
					break;
				case "get_available_models":
					await this.handleGetAvailableModels(ws, id);
					break;
				case "get_default_model":
					await this.handleGetDefaultModel(ws, id);
					break;
				case "get_session_statuses":
					this.handleGetSessionStatuses(ws, id);
					break;
				case "fork":
					await this.handleFork(ws, id, command);
					break;
				case "fork_prompt":
					await this.handleForkPrompt(ws, id, command);
					break;
				case "set_session_name":
					await this.handleSetSessionName(ws, id, command);
					break;
				case "get_commands":
					await this.handleGetCommands(ws, id);
					break;
				case "reload_processes":
					await this.handleReloadProcesses(ws, id);
					break;
				default:
					ws.send(JSON.stringify({
						id, type: "response", command: command.type, success: false,
						error: `Unknown command: ${command.type}`,
					}));
			}
		} catch (err: any) {
			debugTurn("command_error", { commandType: command?.type, requestId: id, error: err?.message });
			ws.send(JSON.stringify({ id, type: "response", command: command.type, success: false, error: err.message }));
			this.recordTrace(
				traceId,
				"backend",
				"span",
				`ws command ${command.type}`,
				Number((performance.now() - commandStart).toFixed(2)),
				{ success: false, error: err?.message },
			);
			return;
		}

		this.recordTrace(
			traceId,
			"backend",
			"span",
			`ws command ${command.type}`,
			Number((performance.now() - commandStart).toFixed(2)),
			{ success: true },
		);
	}

	private async handleInstallPi(ws: WebSocket, id: string): Promise<void> {
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
		ws.send(JSON.stringify({ id, type: "response", command: "install_pi", success: true, data: {} }));
	}

	private handleSubscribeSession(ws: WebSocket, id: string, command: any): void {
		const client = this.clients.get(ws);
		if (!client) return;
		const sessionPath = command.sessionPath as string;

		if (!sessionPath) {
			client.subscribedSession = null;
			client.lastVersion = 0;
			client.lastJson = "";
			client.lastHash = "";
			ws.send(JSON.stringify({ id, type: "response", command: "subscribe_session", success: true, data: {} }));
			return;
		}

		client.subscribedSession = sessionPath;

		// If the session is attached, send from its actor-owned in-memory state
		const attached = this.registry.find(sessionPath)?.session;
		if (attached) {
			// Send full sync
			client.lastJson = attached.json;
			client.lastHash = attached.hash;
			client.lastVersion = attached.version;
			ws.send(JSON.stringify({
				type: "session_sync",
				sessionPath,
				op: "full",
				data: attached.json,
				hash: attached.hash,
			}));
		} else {
			// Detached — read from disk
			const { json, hash } = readSessionFromDisk(sessionPath);
			client.lastJson = json;
			client.lastHash = hash;
			client.lastVersion = 0;
			// Track file size for change detection
			this.subscribedFileSizes.set(sessionPath, getSessionFileSize(sessionPath));
			ws.send(JSON.stringify({
				type: "session_sync",
				sessionPath,
				op: "full",
				data: json,
				hash,
			}));
		}

		// Extension status is a separate, authoritative snapshot so reconnects
		// and session switches replace rather than merge stale client state.
		ws.send(JSON.stringify(this.makeExtensionStatusMessage(sessionPath)));
		ws.send(JSON.stringify({ id, type: "response", command: "subscribe_session", success: true, data: {} }));
	}

	private async handlePrompt(ws: WebSocket, id: string, command: any): Promise<void> {
		let sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");

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
				const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
				sessionPath = stateResp.data?.sessionFile;
				if (!sessionPath) throw new Error("Failed to get session path from new session");
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
					ws.send(JSON.stringify({
						type: "session_attached",
						sessionPath,
						cwd: newSessionCwd,
						firstMessage: command.message,
					}));
				} else {
					proc = await this.acquireForActor(actor!);
				}

				generation = actor!.beginTurn();
				const observer = this.setupTurnEventForwarding(actor!, proc!, generation, ws, turnId);
				await this.applyRequestedControlState(proc!, actor!, ws, command);

				const promptCmd: any = { type: "prompt", message: command.message };
				if (command.images?.length > 0) promptCmd.images = command.images;
				const response = await this.pool.sendRpc(proc!, promptCmd);
				await this.reconcileEffectiveControlState(proc!, actor!);
				return { observer, response, generation };
			});

			if (!start) {
				ws.send(JSON.stringify({ id, type: "response", command: "steer", success: true }));
				return;
			}

			await this.waitForPromptSettlement(proc!, start.observer);
			await actor.enqueue("prompt settlement", async () => {
				if (!actor!.owns(proc!, start.generation)) return;
				await this.reconcileEffectiveControlState(proc!, actor!);
				this.releaseActor(actor!);
			});

			const enriched = { ...start.response };
			if (!enriched.data) enriched.data = {};
			enriched.data.newSessionPath = sessionPath;
			ws.send(JSON.stringify({ ...enriched, id, command: "prompt" }));
		} catch (err: any) {
			if (proc) this.pendingExtensionStatuses.delete(proc);
			unownedLease?.release();
			if (actor && proc && actor.process === proc) {
				let detailed = this.buildPromptFailureMessage(err, proc, actor);
				await actor.enqueue("prompt failure", () => {
					if (actor!.process !== proc) return;
					detailed = this.buildPromptFailureMessage(err, proc!, actor!);
					actor!.markFailed();
					this.injectSessionError(actor!, detailed);
					this.releaseActor(actor!);
				});
				if ((err?.message || "").includes("Timeout waiting for RPC response to prompt") && proc.process.exitCode === null) {
					proc.process.kill("SIGTERM");
				}
				throw new Error(detailed);
			}
			if (proc && proc.process.exitCode === null) proc.process.kill("SIGTERM");
			throw err;
		}
	}

	private async handleSteer(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const actor = this.registry.find(sessionPath);
		if (!actor) throw new Error("Session is not attached (agent not running)");
		await actor.enqueue("steer", () => this.sendSteering(actor, command.message));
		ws.send(JSON.stringify({ id, type: "response", command: "steer", success: true }));
	}

	private async handleRemoveSteering(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const index = command.index as number;
		if (typeof index !== "number") throw new Error("Missing index");

		const actor = this.registry.find(sessionPath);
		if (actor) await actor.enqueue("remove steering", () => actor.removeSteeringByIndex(index));
		ws.send(JSON.stringify({ id, type: "response", command: "remove_steering", success: true }));
	}

	private async handleAbort(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		const actor = sessionPath ? this.registry.find(sessionPath) : undefined;
		if (actor) {
			await actor.enqueue("abort", async () => {
				if (actor.isTurnActive && actor.process) {
					await this.pool.sendRpc(actor.process, { type: "abort" });
				}
			});
		}
		ws.send(JSON.stringify({ id, type: "response", command: "abort", success: true }));
	}

	private async handleCompact(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
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
		ws.send(JSON.stringify({ ...response, id, command: "compact" }));
	}

	private async handleGetAvailableModels(ws: WebSocket, id: string): Promise<void> {
		const lease = await this.acquireAnyProcess();
		try {
			const response = await this.pool.sendRpc(lease.process, { type: "get_available_models" });
			ws.send(JSON.stringify({ ...response, id, command: "get_available_models" }));
		} finally {
			lease.release();
		}
	}

	private async handleGetCommands(ws: WebSocket, id: string): Promise<void> {
		const lease = await this.acquireAnyProcess();
		try {
			const response = await this.pool.sendRpc(lease.process, { type: "get_commands" });
			ws.send(JSON.stringify({ ...response, id, command: "get_commands" }));
		} finally {
			lease.release();
		}
	}

	private async handleReloadProcesses(ws: WebSocket, id: string): Promise<void> {
		const { killed, draining } = this.pool.decommissionAll();
		this.ensurePool();
		ws.send(JSON.stringify({
			id,
			type: "response",
			command: "reload_processes",
			success: true,
			data: { killed, draining },
		}));
	}

	private async handleGetDefaultModel(ws: WebSocket, id: string): Promise<void> {
		const lease = await this.acquireAnyProcess();
		try {
			const stateResp = await this.pool.sendRpc(lease.process, { type: "get_state" });
			const model = stateResp.data?.model ?? null;
			const thinkingLevel = stateResp.data?.thinkingLevel ?? "off";
			ws.send(JSON.stringify({ id, type: "response", command: "get_default_model", success: true, data: { model, thinkingLevel } }));
		} finally {
			lease.release();
		}
	}

	private handleGetSessionStatuses(ws: WebSocket, id: string): void {
		ws.send(JSON.stringify({ id, type: "response", command: "get_session_statuses", success: true, data: { statuses: this.registry.getAllStatuses() } }));
	}

	private async handleFork(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const entryId = command.entryId as string;
		if (!entryId) throw new Error("Missing entryId");

		const actor = this.registry.get(sessionPath);
		const result = await actor.enqueue("fork", async () => {
			actor.assertAvailable("fork");
			const proc = await this.acquireForActor(actor);
			try {
				const response = await this.pool.sendRpc(proc, { type: "fork", entryId });
				const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
				return { response, newSessionPath: stateResp.data?.sessionFile };
			} finally {
				this.releaseActor(actor);
			}
		});

		ws.send(JSON.stringify({
			id, type: "response", command: "fork", success: true,
			data: {
				text: result.response.data?.text ?? "",
				cancelled: result.response.data?.cancelled ?? false,
				newSessionPath: result.newSessionPath ?? null,
			},
		}));
	}

	private async handleForkPrompt(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const message = command.message as string;
		if (!message) throw new Error("Missing message");

		const sessionsDir = path.join(getAgentDir(), "sessions");
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const newId = crypto.randomUUID().slice(0, 8);
		const newSessionPath = path.join(sessionsDir, `${timestamp}_${newId}.jsonl`);
		const sourceActor = this.registry.get(sessionPath);
		await sourceActor.enqueue("fork prompt source", async () => {
			sourceActor.assertAvailable("fork and prompt");
			await copyFile(sessionPath, newSessionPath);
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
				ws.send(JSON.stringify({ type: "session_attached", sessionPath: newSessionPath, cwd, firstMessage: message }));

				const generation = actor.beginTurn();
				const observer = this.setupTurnEventForwarding(actor, proc, generation, ws, makeTurnId());
				await this.applyRequestedControlState(proc, actor, ws, command);
				const promptCmd: any = { type: "prompt", message };
				if (command.images?.length > 0) promptCmd.images = command.images;
				await this.pool.sendRpc(proc, promptCmd);
				await this.reconcileEffectiveControlState(proc, actor);
				return { observer, generation };
			});

			await this.waitForPromptSettlement(proc!, start.observer);
			await actor.enqueue("fork prompt settlement", async () => {
				if (!actor.owns(proc!, start.generation)) return;
				await this.reconcileEffectiveControlState(proc!, actor);
				this.releaseActor(actor);
			});
			ws.send(JSON.stringify({ id, type: "response", command: "fork_prompt", success: true, data: { newSessionPath } }));
		} catch (err: any) {
			if (proc) this.pendingExtensionStatuses.delete(proc);
			unownedLease?.release();
			if (proc && actor.process === proc) {
				let detailed = this.buildPromptFailureMessage(err, proc, actor);
				await actor.enqueue("fork prompt failure", () => {
					if (actor.process !== proc) return;
					detailed = this.buildPromptFailureMessage(err, proc!, actor);
					actor.markFailed();
					this.injectSessionError(actor, detailed);
					this.releaseActor(actor);
				});
				if ((err?.message || "").includes("Timeout waiting for RPC response to prompt") && proc.process.exitCode === null) {
					proc.process.kill("SIGTERM");
				}
				throw new Error(detailed);
			}
			if (proc && proc.process.exitCode === null) proc.process.kill("SIGTERM");
			throw err;
		}
	}

	private async handleSetSessionName(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
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
		ws.send(JSON.stringify({ ...response, id, command: "set_session_name" }));
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
		ws: WebSocket,
		command: any,
	): Promise<any> {
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

		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({
				type: "control_state",
				sessionPath,
				controlRevision: command.controlRevision,
				model: activeModel,
				thinkingLevel: stateResponse.data?.thinkingLevel ?? "off",
			}));
		}
		return stateResponse.data;
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

	private publishEffectiveControlState(actor: SessionActor, rpcState: any): void {
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
			disk.state.error = liveState.error;
		}
		const { json, hash } = serializeSessionState(disk.state);
		this.subscribedFileSizes.set(sessionPath, getSessionFileSize(sessionPath));
		this.pushSnapshotToSubscribers(sessionPath, json, hash);
	}

	private pushSnapshotToSubscribers(sessionPath: string, json: string, hash: string) {
		for (const [ws, client] of this.clients) {
			if (client.subscribedSession !== sessionPath) continue;
			if (ws.readyState !== WebSocket.OPEN) continue;
			ws.send(JSON.stringify({
				type: "session_sync",
				sessionPath,
				op: "full",
				data: json,
				hash,
			}));
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
		for (const [ws, client] of this.clients) {
			if (client.subscribedSession !== sessionPath) continue;
			if (ws.readyState !== WebSocket.OPEN) continue;

			const syncOp = session.computeSyncOp(client.lastJson, client.lastHash, client.lastVersion);
			if (!syncOp) continue;

			ws.send(JSON.stringify({
				type: "session_sync",
				sessionPath,
				...syncOp,
			}));

			client.lastJson = session.json;
			client.lastHash = session.hash;
			client.lastVersion = session.version;
		}
	}

	private setupTurnEventForwarding(
		actor: SessionActor,
		proc: RpcProcess,
		generation: number,
		ws: WebSocket,
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

		const eventHandler = (sourceProc: RpcProcess, data: Record<string, any>) => {
			if (sourceProc !== proc || data.type === "extension_ui_request") return;
			const replacementMessages = data.type === "auto_compaction_end" && data.result
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

				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "agent_event", sessionPath, event: data }));
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

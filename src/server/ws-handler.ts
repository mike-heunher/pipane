/**
 * WebSocket handler for pipane.
 *
 * Architecture:
 * - Sessions are either "attached" (pi process running, full state in memory)
 *   or "detached" (no in-memory state, read from JSONL on disk on demand).
 * - Any number of clients can connect simultaneously.
 * - Each client can subscribe to one session at a time.
 * - Attached sessions push stream_delta or snapshot ops to subscribed clients.
 * - Detached sessions are read from disk when a client subscribes.
 */

import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SessionLifecycle } from "./session-lifecycle.js";
import { ProcessPool, type RpcProcess } from "./process-pool.js";
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
	lifecycle: SessionLifecycle;
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
	private lifecycle: SessionLifecycle;
	private pool: ProcessPool;
	private defaultCwd: string;
	private piLaunch: { command: string; baseArgs: string[] };
	private ensurePool: () => void;
	private isRequestAuthorized: (req: IncomingMessage) => boolean;
	private traceStore?: LoadTraceStore;

	private clients = new Map<WebSocket, ClientState>();
	private wsTraceIds = new Map<WebSocket, string>();
	private busyProcesses = new Set<RpcProcess>();
	/** Session paths whose control→prompt→reconcile transaction has one owner. */
	private activePromptSessions = new Set<string>();
	private procEventCleanup = new Map<RpcProcess, () => void>();
	/** Last known extension statuses, retained while a session is detached. */
	private extensionStatusesBySession = new Map<string, Map<string, string>>();
	/** Latest successful account-wide subscription usage from any process. */
	private providerUsageStatuses = new Map<ProviderUsageProvider, string>();
	/** Statuses emitted while a process is switching to a not-yet-attached session. */
	private pendingExtensionStatuses = new WeakMap<RpcProcess, Map<string, string>>();
	/** Processes marked for graceful decommission after current turn ends. */
	private decommissionProcesses = new Set<RpcProcess>();

	/**
	 * In-memory state for sessions with an attached pi process.
	 * Keyed by session path. Created on attach, deleted on detach.
	 */
	private attachedSessions = new Map<string, SessionJsonl>();

	/**
	 * Track file sizes for detached sessions that clients are subscribed to.
	 * Used for change detection when the file watcher fires.
	 */
	private subscribedFileSizes = new Map<string, number>();

	private piAvailable: boolean;
	private piInstalling = false;

	constructor(options: WsHandlerOptions) {
		this.lifecycle = options.lifecycle;
		this.pool = options.pool;
		this.defaultCwd = options.defaultCwd;
		this.piLaunch = options.piLaunch;
		this.ensurePool = options.ensurePool;
		this.isRequestAuthorized = options.isRequestAuthorized;
		this.traceStore = options.traceStore;
		this.piAvailable = checkCommandAvailable(this.piLaunch.command);

		this.pool.subscribeEvents((proc, event) => this.handleProcessEvent(proc, event));

		this.lifecycle.subscribe((event) => {
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
					const session = this.attachedSessions.get(event.sessionPath);
					if (session) {
						session.steeringQueue = [...event.queue];
						this.pushUpdateToSubscribers(event.sessionPath, session);
					}
					break;
				}
			}
		});
	}

	get isPiAvailable(): boolean {
		return this.piAvailable;
	}

	/** Idempotently clean up all session bookkeeping after an RPC process exits. */
	handleProcessExit(proc: RpcProcess): void {
		this.pendingExtensionStatuses.delete(proc);
		const sessionPath = this.lifecycle.getAttachedSessionForProcess(proc);
		if (sessionPath) {
			console.log(`[pool] pi#${proc.id} crashed while attached to ${path.basename(sessionPath)} — marking done`);
			this.activePromptSessions.delete(sessionPath);
			// Without a final get_state, disk is safer than potentially stale
			// in-memory controls (pi may have persisted a model change before crash).
			this.releaseProcess(sessionPath, false);
			return;
		}

		const cleanup = this.procEventCleanup.get(proc);
		if (cleanup) cleanup();
		this.procEventCleanup.delete(proc);
		this.busyProcesses.delete(proc);
		this.decommissionProcesses.delete(proc);
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

		const sessionPath = this.lifecycle.getAttachedSessionForProcess(proc);
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
		if (this.attachedSessions.has(sessionPath)) return;

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
		const processes = this.pool.getAllProcesses().map((p) => ({
			id: p.id,
			pid: p.process.pid ?? null,
			alive: p.process.exitCode === null,
			exitCode: p.process.exitCode,
			cwd: p.cwd,
			busy: this.busyProcesses.has(p),
			decommissioning: this.decommissionProcesses.has(p),
			attachedSession: this.lifecycle.getAttachedSessionForProcess(p) ?? null,
			pendingRequests: p.pendingRequests.size,
		}));

		return {
			now: new Date().toISOString(),
			totalProcesses: this.pool.totalProcesses,
			attachedSessionCount: this.lifecycle.attachedCount,
			sessionStatuses: this.lifecycle.getAllStatuses(),
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
			sessionStatuses: this.lifecycle.getAllStatuses(),
			steeringQueues: this.lifecycle.getAllSteeringQueues(),
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

		// If the session is attached, send from in-memory state
		const attached = this.attachedSessions.get(sessionPath);
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

		let turnLockPath: string | undefined;
		if (sessionPath !== "__new__") {
			// A client can race the running-status broadcast. If the process is
			// already attached, preserve send-during-streaming semantics by steering.
			if (this.lifecycle.getAttachedProcess(sessionPath)) {
				await this.handleSteer(ws, id, command);
				return;
			}
			if (this.activePromptSessions.has(sessionPath)) {
				throw new Error("A turn is already starting for this session; retry as steering");
			}
			this.activePromptSessions.add(sessionPath);
			turnLockPath = sessionPath;
		}

		let proc: RpcProcess | undefined;
		try {
			if (sessionPath === "__new__") {
				const cwd = command.cwd as string || this.defaultCwd;
				proc = await this.acquireProcess(cwd);
				await this.pool.waitForReady(proc);

				// Ignore prewarm/default-session statuses. Only events caused by this
				// replacement session are eligible for attribution to the new path.
				this.beginPendingExtensionStatusCapture(proc);
				await this.replacePiSession(proc, { type: "new_session" }, "new_session");
				const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
				sessionPath = stateResp.data?.sessionFile;
				if (!sessionPath) throw new Error("Failed to get session path from new session");
				this.activePromptSessions.add(sessionPath);
				turnLockPath = sessionPath;

				this.busyProcesses.add(proc);

				// Create attached session with empty state (new session).
				this.createAttachedSession(sessionPath);
				this.lifecycle.attach(sessionPath, proc);
				this.commitPendingExtensionStatuses(proc, sessionPath);

				ws.send(JSON.stringify({
					type: "session_attached",
					sessionPath,
					cwd,
					firstMessage: command.message,
				}));
			} else {
				proc = await this.acquireForSession(sessionPath);
			}

			// Listen before model/thinking mutations so clamp events cannot be lost.
			const turnObserver = this.setupTurnEventForwarding(proc, sessionPath, ws, turnId);
			await this.applyRequestedControlState(proc, sessionPath, ws, command);

			const promptCmd: any = { type: "prompt", message: command.message };
			if (command.images?.length > 0) {
				promptCmd.images = command.images;
			}
			const response = await this.pool.sendRpc(proc, promptCmd);
			// before_agent_start hooks may switch controls after the pre-prompt
			// transaction. Reflect that effective state while the turn is active.
			await this.reconcileEffectiveControlState(proc, sessionPath);
			// `prompt` acknowledges acceptance before the agent finishes. Keep the
			// process attached through agent_settled, but do not hang on extension
			// commands that handle a prompt without starting an agent run.
			await this.waitForPromptSettlement(proc, turnObserver);
			await this.reconcileEffectiveControlState(proc, sessionPath);
			this.releaseProcess(sessionPath);

			const enriched = { ...response };
			if (!enriched.data) enriched.data = {};
			enriched.data.newSessionPath = sessionPath;
			ws.send(JSON.stringify({ ...enriched, id, command: "prompt" }));
		} catch (err: any) {
			if (proc) this.pendingExtensionStatuses.delete(proc);
			if (proc && sessionPath && this.lifecycle.getAttachedProcess(sessionPath) === proc) {
				const detailed = this.buildPromptFailureMessage(err, proc, sessionPath);
				this.injectSessionError(sessionPath, detailed);
				this.releaseProcess(sessionPath);
				if ((err?.message || "").includes("Timeout waiting for RPC response to prompt") && proc.process.exitCode === null) {
					proc.process.kill("SIGTERM");
				}
				throw new Error(detailed);
			}
			if (proc) {
				this.busyProcesses.delete(proc);
				if (proc.process.exitCode === null) proc.process.kill("SIGTERM");
			}
			throw err;
		} finally {
			if (turnLockPath) this.activePromptSessions.delete(turnLockPath);
		}
	}

	private async handleSteer(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const proc = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (!proc) throw new Error("Session is not attached (agent not running)");

		this.lifecycle.enqueueSteering(sessionPath, command.message);
		await this.pool.sendRpc(proc, { type: "steer", message: command.message });
		ws.send(JSON.stringify({ id, type: "response", command: "steer", success: true }));
	}

	private async handleRemoveSteering(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const index = command.index as number;
		if (typeof index !== "number") throw new Error("Missing index");

		this.lifecycle.removeSteeringByIndex(sessionPath, index);
		ws.send(JSON.stringify({ id, type: "response", command: "remove_steering", success: true }));
	}

	private async handleAbort(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		const proc = sessionPath ? this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined : undefined;
		if (proc) {
			await this.pool.sendRpc(proc, { type: "abort" });
		}
		ws.send(JSON.stringify({ id, type: "response", command: "abort", success: true }));
	}

	private async handleCompact(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const proc = await this.acquireForSession(sessionPath);
		const response = await this.pool.sendRpc(proc, { type: "compact", customInstructions: command.customInstructions });
		this.releaseProcess(sessionPath);
		ws.send(JSON.stringify({ ...response, id, command: "compact" }));
	}

	private async handleGetAvailableModels(ws: WebSocket, id: string): Promise<void> {
		const proc = this.getAnyProcess();
		const response = await this.pool.sendRpc(proc, { type: "get_available_models" });
		ws.send(JSON.stringify({ ...response, id, command: "get_available_models" }));
	}

	private async handleGetCommands(ws: WebSocket, id: string): Promise<void> {
		const proc = this.getAnyProcess();
		const response = await this.pool.sendRpc(proc, { type: "get_commands" });
		ws.send(JSON.stringify({ ...response, id, command: "get_commands" }));
	}

	private async handleReloadProcesses(ws: WebSocket, id: string): Promise<void> {
		const all = this.pool.getAllProcesses();
		let killed = 0;
		let draining = 0;

		for (const proc of all) {
			if (proc.process.exitCode !== null) continue;

			const sessionPath = this.lifecycle.getAttachedSessionForProcess(proc);
			if (sessionPath) {
				// Graceful path: keep running turns alive, but decommission the process
				// once the turn ends (releaseProcess will terminate it).
				if (!this.decommissionProcesses.has(proc)) {
					this.decommissionProcesses.add(proc);
					draining += 1;
				}
				continue;
			}

			// Idle/unattached process: terminate immediately.
			const cleanup = this.procEventCleanup.get(proc);
			if (cleanup) {
				cleanup();
				this.procEventCleanup.delete(proc);
			}
			this.busyProcesses.delete(proc);
			this.decommissionProcesses.delete(proc);
			proc.process.kill("SIGTERM");
			killed += 1;
		}

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
		const proc = this.getAnyProcess();
		const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
		const model = stateResp.data?.model ?? null;
		const thinkingLevel = stateResp.data?.thinkingLevel ?? "off";
		ws.send(JSON.stringify({ id, type: "response", command: "get_default_model", success: true, data: { model, thinkingLevel } }));
	}

	private handleGetSessionStatuses(ws: WebSocket, id: string): void {
		ws.send(JSON.stringify({ id, type: "response", command: "get_session_statuses", success: true, data: { statuses: this.lifecycle.getAllStatuses() } }));
	}

	private async handleFork(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const entryId = command.entryId as string;
		if (!entryId) throw new Error("Missing entryId");

		const proc = await this.acquireForSession(sessionPath);
		const response = await this.pool.sendRpc(proc, { type: "fork", entryId });
		const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
		const newSessionPath = stateResp.data?.sessionFile;
		this.releaseProcess(sessionPath);

		ws.send(JSON.stringify({
			id, type: "response", command: "fork", success: true,
			data: {
				text: response.data?.text ?? "",
				cancelled: response.data?.cancelled ?? false,
				newSessionPath: newSessionPath ?? null,
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
		const newFilename = `${timestamp}_${newId}.jsonl`;
		const newSessionPath = path.join(sessionsDir, newFilename);
		await copyFile(sessionPath, newSessionPath);

		const forkCwd = getSessionCwd(sessionPath);
		const cwd = (forkCwd && existsSync(forkCwd)) ? forkCwd : this.defaultCwd;
		const proc = await this.acquireProcess(cwd);
		await this.pool.waitForReady(proc);
		this.busyProcesses.add(proc);
		this.activePromptSessions.add(newSessionPath);

		try {
			// Create attached session, seeded from the forked file. Capture only
			// statuses emitted while Pi switches to this fork.
			this.createAttachedSession(newSessionPath);
			this.beginPendingExtensionStatusCapture(proc);
			await this.replacePiSession(
				proc,
				{ type: "switch_session", sessionPath: newSessionPath },
				"switch_session",
			);
			this.lifecycle.attach(newSessionPath, proc);
			this.commitPendingExtensionStatuses(proc, newSessionPath);

			ws.send(JSON.stringify({ type: "session_attached", sessionPath: newSessionPath, cwd, firstMessage: message }));

			const turnId = makeTurnId();
			const turnObserver = this.setupTurnEventForwarding(proc, newSessionPath, ws, turnId);
			await this.applyRequestedControlState(proc, newSessionPath, ws, command);

			const promptCmd: any = { type: "prompt", message };
			if (command.images?.length > 0) {
				promptCmd.images = command.images;
			}
			await this.pool.sendRpc(proc, promptCmd);
			await this.reconcileEffectiveControlState(proc, newSessionPath);
			await this.waitForPromptSettlement(proc, turnObserver);
			await this.reconcileEffectiveControlState(proc, newSessionPath);
			this.releaseProcess(newSessionPath);

			ws.send(JSON.stringify({ id, type: "response", command: "fork_prompt", success: true, data: { newSessionPath } }));
		} catch (err: any) {
			this.pendingExtensionStatuses.delete(proc);
			if (this.lifecycle.getAttachedProcess(newSessionPath) === proc) {
				const detailed = this.buildPromptFailureMessage(err, proc, newSessionPath);
				this.injectSessionError(newSessionPath, detailed);
				this.releaseProcess(newSessionPath);
				if ((err?.message || "").includes("Timeout waiting for RPC response to prompt") && proc.process.exitCode === null) {
					proc.process.kill("SIGTERM");
				}
				throw new Error(detailed);
			}
			this.busyProcesses.delete(proc);
			if (proc.process.exitCode === null) proc.process.kill("SIGTERM");
			throw err;
		} finally {
			this.activePromptSessions.delete(newSessionPath);
		}
	}

	private async handleSetSessionName(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const proc = await this.acquireForSession(sessionPath);
		const response = await this.pool.sendRpc(proc, { type: "set_session_name", name: command.name });
		this.releaseProcess(sessionPath);
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
		sessionPath: string,
		ws: WebSocket,
		command: any,
	): Promise<any> {
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
		this.publishEffectiveControlState(sessionPath, stateResponse.data);

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
	private async reconcileEffectiveControlState(proc: RpcProcess, sessionPath: string): Promise<void> {
		const stateResponse = await this.pool.sendRpcChecked(proc, { type: "get_state" });
		this.publishEffectiveControlState(sessionPath, stateResponse.data);
	}

	private publishEffectiveControlState(sessionPath: string, rpcState: any): void {
		const session = this.attachedSessions.get(sessionPath);
		if (!session) return;
		const model = toCompactModelRef(rpcState?.model ?? {});
		if (!model) return;
		const changed = session.setControlState(model, rpcState?.thinkingLevel ?? "off");
		if (changed) this.pushUpdateToSubscribers(sessionPath, session);
	}

	private buildPromptFailureMessage(err: unknown, proc: RpcProcess, sessionPath: string): string {
		const raw = err instanceof Error ? err.message : String(err);
		const session = this.attachedSessions.get(sessionPath);
		const sessionError = session?.toState().error;
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

	private injectSessionError(sessionPath: string, errorMessage: string): void {
		const session = this.attachedSessions.get(sessionPath);
		if (!session) return;
		session.applyEvent({
			type: "turn_end",
			message: { role: "assistant", errorMessage },
		} as any);
		this.pushUpdateToSubscribers(sessionPath, session);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Busy + decommissioned processes are unavailable for reuse. */
	private getUnavailableProcesses(): Set<RpcProcess> {
		return new Set([...this.busyProcesses, ...this.decommissionProcesses]);
	}

	/**
	 * Create a SessionJsonl for a session path.
	 * Reads existing JSONL from disk to seed the initial messages.
	 */
	private createAttachedSession(sessionPath: string): SessionJsonl {
		const { state } = readSessionFromDisk(sessionPath);
		const session = new SessionJsonl({
			messages: state.messages,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
		});
		this.attachedSessions.set(sessionPath, session);
		return session;
	}

	/**
	 * Acquire a process for an existing session. Resolves the session's cwd
	 * from its JSONL header and gets a process from the matching pool.
	 */
	private async acquireForSession(sessionPath: string): Promise<RpcProcess> {
		const existing = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (existing) return existing;

		const sessionCwd = getSessionCwd(sessionPath);
		const cwd = (sessionCwd && existsSync(sessionCwd)) ? sessionCwd : this.defaultCwd;
		const proc = await this.acquireProcess(cwd);
		this.busyProcesses.add(proc);

		// Create attached session if it doesn't exist yet.
		if (!this.attachedSessions.has(sessionPath)) {
			this.createAttachedSession(sessionPath);
		}

		// Keep the process unattributed while switch_session tears down its old
		// extension runtime. The final pending snapshot is committed only after
		// the target session has started, preventing cross-session status leaks.
		this.beginPendingExtensionStatusCapture(proc, sessionPath);
		try {
			await this.replacePiSession(
				proc,
				{ type: "switch_session", sessionPath },
				"switch_session",
			);
			this.lifecycle.attach(sessionPath, proc);
			this.commitPendingExtensionStatuses(proc, sessionPath);
		} catch (err) {
			this.pendingExtensionStatuses.delete(proc);
			this.busyProcesses.delete(proc);
			this.attachedSessions.delete(sessionPath);
			throw err;
		}
		console.log(`[ws] pi#${proc.id} attached to ${path.basename(sessionPath)} (cwd: ${cwd})`);
		return proc;
	}

	/**
	 * Acquire a process for a given cwd. Spawns if needed.
	 */
	private async acquireProcess(cwd: string): Promise<RpcProcess> {
		if (!this.piAvailable) {
			throw new Error(makePiNotFoundMessage(this.piLaunch.command));
		}

		const timeoutMs = 60000;
		const start = Date.now();

		while (true) {
			const unavailable = this.getUnavailableProcesses();
			const proc = this.pool.acquire(cwd, unavailable);
			if (proc) {
				// Reserve before yielding to the caller. Without this, two concurrent
				// acquisitions can both receive the same idle process.
				this.busyProcesses.add(proc);
				return proc;
			}

			const evicted = this.pool.evictIdleDifferentCwd(cwd, unavailable);
			if (evicted) {
				await this.sleep(50);
				continue;
			}

			if (Date.now() - start >= timeoutMs) {
				throw new Error(`Timed out waiting for available pi process for cwd: ${cwd}`);
			}

			await this.sleep(100);
		}
	}

	private releaseProcess(sessionPath: string, preserveLiveControls = true): void {
		const proc = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		const liveState = this.attachedSessions.get(sessionPath)?.toState();
		if (proc) {
			this.pendingExtensionStatuses.delete(proc);
			const cleanup = this.procEventCleanup.get(proc);
			if (cleanup) {
				cleanup();
				this.procEventCleanup.delete(proc);
			}
		}

		// Delete the attached session — no more in-memory state.
		this.attachedSessions.delete(sessionPath);
		this.lifecycle.detach(sessionPath);

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

		if (proc) {
			const shouldDecommission = this.decommissionProcesses.has(proc);
			if (shouldDecommission) {
				this.decommissionProcesses.delete(proc);
				if (proc.process.exitCode === null) {
					console.log(`[pool] Decommissioning pi#${proc.id} after completed turn`);
					proc.process.kill("SIGTERM");
				}
			}
			this.busyProcesses.delete(proc);
		}
	}

	private getAnyProcess(): RpcProcess {
		let proc = this.pool.getAny(this.getUnavailableProcesses());
		if (!proc) {
			proc = this.pool.spawn(this.defaultCwd);
		}
		return proc;
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

	private setupTurnEventForwarding(proc: RpcProcess, sessionPath: string, ws: WebSocket, turnId: string): TurnEventObserver {
		const existingCleanup = this.procEventCleanup.get(proc);
		if (existingCleanup) {
			existingCleanup();
			this.procEventCleanup.delete(proc);
		}

		// Capture the SessionJsonl object — if it gets deleted (detach),
		// the handler becomes a no-op because we check for it.
		const sessionRef = this.attachedSessions.get(sessionPath);
		if (!sessionRef) {
			throw new Error(`setupTurnEventForwarding called without attached state for ${sessionPath}`);
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
			if (sourceProc !== proc) return;
			// Extension UI is a distinct protocol. Never feed it into AgentEvent
			// state or expose it as a lifecycle event to the browser.
			if (data.type === "extension_ui_request") return;

			// Guard: if the attached session was deleted (turn ended),
			// this handler is stale — skip.
			const currentSession = this.attachedSessions.get(sessionPath);
			if (currentSession !== sessionRef) return;

			if (data.type === "agent_start") {
				hasStarted = true;
				resolveStarted();
			}
			if (data.type === "agent_settled") {
				hasStarted = true;
				hasSettled = true;
				resolveStarted();
				resolveEnded();
				resolveSettled();
			}

			// Apply event to the in-memory attached session.
			let changed = currentSession.applyEvent(data as any);

			// After auto-compaction, the pi process rewrites the JSONL and calls
			// replaceMessages() internally. SessionJsonl doesn't know about this,
			// so re-read the session from disk to pick up the compacted state.
			if (data.type === "auto_compaction_end" && data.result) {
				const { state } = readSessionFromDisk(sessionPath);
				currentSession.replaceMessages(state.messages);
				changed = true;
			}

			// Side-channel raw event for UI hooks (canvas/jsonl), not state updates.
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "agent_event", sessionPath, event: data }));
			}

			if (data.type === "message_end" && data.message?.role === "user") {
				const text = typeof data.message.content === "string"
					? data.message.content
					: (data.message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
				this.lifecycle.dequeueSteering(sessionPath, text);
			}

			// Push update to all subscribed clients.
			if (changed) {
				this.pushUpdateToSubscribers(sessionPath, currentSession);
			}

			if (data.type === "agent_end") {
				resolveEnded();
				debugTurn("agent_end_received", { turnId, procId: proc.id, sessionPath });
				this.lifecycle.clearSteering(sessionPath);
				// The owning prompt handler releases only after its response and a
				// final get_state, so effective controls cannot be lost at detach.
			}
		};

		const cleanup = this.pool.subscribeEvents(eventHandler);
		this.procEventCleanup.set(proc, cleanup);
		return {
			started,
			ended,
			settled,
			hasStarted: () => hasStarted,
			hasSettled: () => hasSettled,
		};
	}
}

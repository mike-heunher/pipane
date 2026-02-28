/**
 * WebSocket handler for pi-web.
 *
 * Routes incoming WS commands to the session lifecycle and process pool.
 * Subscribes to lifecycle events and forwards them to the connected client.
 */

import { WebSocket, type WebSocketServer } from "ws";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { SessionLifecycle } from "./session-lifecycle.js";
import { ProcessPool, type RpcProcess } from "./process-pool.js";
import { getSessionCwd } from "./session-cwd.js";
import { SessionMessageCache } from "./session-message-cache.js";
import { checkCommandAvailable, installPiGlobal, isPiInstallable, makePiNotFoundMessage } from "./pi-runtime.js";

export interface WsHandlerOptions {
	lifecycle: SessionLifecycle;
	pool: ProcessPool;
	messageCache: SessionMessageCache;
	defaultCwd: string;
	piLaunch: { command: string; baseArgs: string[] };
	ensurePool: () => void;
}

interface TurnState {
	/** The process handling this turn */
	proc: RpcProcess;
	/** The session path */
	sessionPath: string;
	/** WebSocket to forward events to */
	ws: WebSocket;
	/** Correlation id for debug logging */
	turnId: string;
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
	private messageCache: SessionMessageCache;
	private defaultCwd: string;
	private piLaunch: { command: string; baseArgs: string[] };
	private ensurePool: () => void;

	/** Currently connected WS client (single-client model) */
	private connectedWs: WebSocket | null = null;

	/** Set of processes currently busy with a turn */
	private busyProcesses = new Set<RpcProcess>();

	/** Active turns: sessionPath → TurnState */
	private activeTurns = new Map<string, TurnState>();

	/** Per-process event listener cleanup */
	private procEventCleanup = new Map<RpcProcess, () => void>();

	/** Session the connected client is subscribed to (for push updates) */
	private subscribedSession: string | null = null;

	private piAvailable: boolean;
	private piInstalling = false;

	constructor(options: WsHandlerOptions) {
		this.lifecycle = options.lifecycle;
		this.pool = options.pool;
		this.messageCache = options.messageCache;
		this.defaultCwd = options.defaultCwd;
		this.piLaunch = options.piLaunch;
		this.ensurePool = options.ensurePool;
		this.piAvailable = checkCommandAvailable(this.piLaunch.command);

		// Subscribe to lifecycle events and forward to WS client
		this.lifecycle.subscribe((event) => {
			if (!this.connectedWs || this.connectedWs.readyState !== WebSocket.OPEN) return;

			switch (event.type) {
				case "session_attached":
					this.connectedWs.send(JSON.stringify({
						type: "session_attached",
						sessionPath: event.sessionPath,
					}));
					break;
				case "session_detached":
					this.connectedWs.send(JSON.stringify({
						type: "session_detached",
						sessionPath: event.sessionPath,
					}));
					break;
				case "steering_queue_update":
					this.connectedWs.send(JSON.stringify({
						type: "steering_queue_update",
						sessionPath: event.sessionPath,
						queue: event.queue,
					}));
					break;
			}
		});

		// Subscribe to cache events and forward to WS client
		this.messageCache.subscribe((event) => {
			if (!this.connectedWs || this.connectedWs.readyState !== WebSocket.OPEN) return;

			// Only push session_messages if the client is subscribed to this session
			if (event.type === "session_messages" && event.sessionPath === this.subscribedSession) {
				this.connectedWs.send(JSON.stringify({
					type: "session_messages",
					sessionPath: event.sessionPath,
					messages: event.messages,
					model: event.model,
					thinkingLevel: event.thinkingLevel,
				}));
			}
		});
	}

	get isPiAvailable(): boolean {
		return this.piAvailable;
	}

	/** Notify the cache that a session file changed on disk (from file watcher). */
	notifySessionFileChanged(sessionPath: string): void {
		this.messageCache.refreshIfChanged(sessionPath);
	}

	getDebugState() {
		const processes = this.pool.getAllProcesses().map((p) => ({
			id: p.id,
			pid: p.process.pid ?? null,
			alive: p.process.exitCode === null,
			exitCode: p.process.exitCode,
			cwd: p.cwd,
			busy: this.busyProcesses.has(p),
			attachedSession: this.lifecycle.getAttachedSessionForProcess(p) ?? null,
			pendingRequests: p.pendingRequests.size,
		}));

		return {
			now: new Date().toISOString(),
			totalProcesses: this.pool.totalProcesses,
			attachedSessionCount: this.lifecycle.attachedCount,
			sessionStatuses: this.lifecycle.getAllStatuses(),
			connectedWsOpen: !!this.connectedWs && this.connectedWs.readyState === WebSocket.OPEN,
			processes,
		};
	}

	/**
	 * Register the WS handler on a WebSocketServer.
	 */
	register(wss: WebSocketServer): void {
		wss.on("connection", (ws) => this.handleConnection(ws));
	}

	private handleConnection(ws: WebSocket): void {
		console.log("WebSocket client connected");

		if (this.connectedWs && this.connectedWs.readyState === WebSocket.OPEN) {
			this.connectedWs.close(1000, "Replaced by new connection");
		}
		this.connectedWs = ws;

		// Send initial state
		ws.send(JSON.stringify({
			type: "init",
			sessionStatuses: this.lifecycle.getAllStatuses(),
			steeringQueues: this.lifecycle.getAllSteeringQueues(),
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
			console.log("WebSocket client disconnected");
			if (this.connectedWs === ws) this.connectedWs = null;
		});
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
				default:
					ws.send(JSON.stringify({
						id, type: "response", command: command.type, success: false,
						error: `Unknown command: ${command.type}`,
					}));
			}
		} catch (err: any) {
			debugTurn("command_error", { commandType: command?.type, requestId: id, error: err?.message });
			ws.send(JSON.stringify({
				id, type: "response", command: command.type, success: false, error: err.message,
			}));
		}
	}

	// ── Command handlers ─────────────────────────────────────────────────

	private async handleInstallPi(ws: WebSocket, id: string): Promise<void> {
		const installable = isPiInstallable(this.piLaunch.command, this.piLaunch.baseArgs);
		if (!installable) {
			throw new Error(`Automatic install not supported for command '${this.piLaunch.command}'. Set PI_CLI or install manually.`);
		}
		if (!this.piInstalling) {
			this.piInstalling = true;
			if (this.connectedWs && this.connectedWs.readyState === WebSocket.OPEN) {
				this.connectedWs.send(JSON.stringify({
					type: "pi_install_required",
					command: this.piLaunch.command,
					installable: true,
					installing: true,
					message: "Installing pi...",
				}));
			}
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
		const sessionPath = command.sessionPath as string;

		if (!sessionPath) {
			// Unsubscribe (e.g., new virtual session)
			this.subscribedSession = null;
			ws.send(JSON.stringify({ id, type: "response", command: "subscribe_session", success: true, data: {} }));
			return;
		}

		this.subscribedSession = sessionPath;

		// Load from cache (reads from disk if not cached)
		const cached = this.messageCache.load(sessionPath);

		// Push the full message state to the client
		ws.send(JSON.stringify({
			type: "session_messages",
			sessionPath,
			messages: cached.messages,
			model: cached.model,
			thinkingLevel: cached.thinkingLevel,
		}));

		ws.send(JSON.stringify({ id, type: "response", command: "subscribe_session", success: true, data: {} }));
	}

	private async handlePrompt(ws: WebSocket, id: string, command: any): Promise<void> {
		let sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");

		const turnId = makeTurnId();
		debugTurn("prompt_start", { turnId, sessionPath, hasModel: !!command.model });

		let proc: RpcProcess;

		if (sessionPath === "__new__") {
			const cwd = command.cwd as string || this.defaultCwd;
			proc = await this.acquireProcess(cwd);
			await this.pool.waitForReady(proc);

			await this.pool.sendRpc(proc, { type: "new_session" });
			const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
			sessionPath = stateResp.data?.sessionFile;
			if (!sessionPath) throw new Error("Failed to get session path from new session");

			this.busyProcesses.add(proc);
			this.messageCache.setStreaming(sessionPath, true);

			// Send enriched session_attached with cwd + firstMessage for optimistic sidebar.
			// Must be sent BEFORE lifecycle.attach() which emits a bare session_attached
			// via the lifecycle subscriber (without cwd/firstMessage). The client
			// deduplicates by sessionPath, so the first one wins.
			ws.send(JSON.stringify({
				type: "session_attached",
				sessionPath,
				cwd,
				firstMessage: command.message,
			}));
			this.lifecycle.attach(sessionPath, proc);
		} else {
			proc = await this.acquireForSession(sessionPath, ws);
		}

		// Apply model/thinking level
		if (command.model) {
			await this.pool.sendRpcChecked(proc, {
				type: "set_model",
				provider: command.model.provider,
				modelId: command.model.modelId,
			});
			const modelState = await this.pool.sendRpcChecked(proc, { type: "get_state" });
			const activeModel = modelState.data?.model;
			if (!activeModel || activeModel.provider !== command.model.provider || activeModel.id !== command.model.modelId) {
				throw new Error(`Failed to switch model to ${command.model.provider}/${command.model.modelId}`);
			}
		}
		if (command.thinkingLevel) {
			await this.pool.sendRpcChecked(proc, { type: "set_thinking_level", level: command.thinkingLevel });
		}

		// Set up event forwarding for this turn
		this.setupTurnEventForwarding(proc, sessionPath, ws, turnId);

		// Register turn
		this.activeTurns.set(sessionPath, { proc, sessionPath, ws, turnId });

		debugTurn("prompt_rpc_send", { turnId, procId: proc.id, sessionPath });
		const promptCmd: any = { type: "prompt", message: command.message };
		if (command.images && command.images.length > 0) {
			promptCmd.images = command.images;
		}
		const response = await this.pool.sendRpc(proc, promptCmd);
		debugTurn("prompt_rpc_response", { turnId, procId: proc.id, sessionPath, success: !!response?.success });
		ws.send(JSON.stringify({ ...response, id, command: "prompt" }));
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

		const proc = await this.acquireForSession(sessionPath, ws);

		// Compact sends its own session_attached — the lifecycle already emitted it
		const response = await this.pool.sendRpc(proc, {
			type: "compact",
			customInstructions: command.customInstructions,
		});

		this.releaseProcess(sessionPath);
		ws.send(JSON.stringify({ ...response, id, command: "compact" }));
	}

	private async handleGetAvailableModels(ws: WebSocket, id: string): Promise<void> {
		const proc = this.getAnyProcess();
		const response = await this.pool.sendRpc(proc, { type: "get_available_models" });
		ws.send(JSON.stringify({ ...response, id, command: "get_available_models" }));
	}

	private async handleGetDefaultModel(ws: WebSocket, id: string): Promise<void> {
		const proc = this.getAnyProcess();
		const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
		const model = stateResp.data?.model ?? null;
		const thinkingLevel = stateResp.data?.thinkingLevel ?? "off";
		ws.send(JSON.stringify({
			id, type: "response", command: "get_default_model",
			success: true, data: { model, thinkingLevel },
		}));
	}

	private handleGetSessionStatuses(ws: WebSocket, id: string): void {
		ws.send(JSON.stringify({
			id, type: "response", command: "get_session_statuses",
			success: true, data: { statuses: this.lifecycle.getAllStatuses() },
		}));
	}

	private async handleFork(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");
		const entryId = command.entryId as string;
		if (!entryId) throw new Error("Missing entryId");

		const proc = await this.acquireForSession(sessionPath, ws);
		const response = await this.pool.sendRpc(proc, { type: "fork", entryId });

		const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
		const newSessionPath = stateResp.data?.sessionFile;

		this.releaseProcess(sessionPath);

		ws.send(JSON.stringify({
			id, type: "response", command: "fork",
			success: true,
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

		// Copy the JSONL file to create a new session
		const sessionsDir = path.join(getAgentDir(), "sessions");
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const newId = crypto.randomUUID().slice(0, 8);
		const newFilename = `${timestamp}_${newId}.jsonl`;
		const newSessionPath = path.join(sessionsDir, newFilename);
		await copyFile(sessionPath, newSessionPath);

		// Resolve cwd from the source session
		const cwd = getSessionCwd(sessionPath) || this.defaultCwd;

		const proc = await this.acquireProcess(cwd);
		await this.pool.waitForReady(proc);

		this.busyProcesses.add(proc);
		this.messageCache.setStreaming(newSessionPath, true);

		// Send enriched session_attached BEFORE lifecycle.attach() so the client
		// receives cwd + firstMessage before the bare lifecycle event.
		ws.send(JSON.stringify({
			type: "session_attached",
			sessionPath: newSessionPath,
			cwd,
			firstMessage: message,
		}));
		this.lifecycle.attach(newSessionPath, proc);

		await this.pool.sendRpc(proc, { type: "switch_session", sessionPath: newSessionPath });

		// Apply model/thinking level
		if (command.model) {
			await this.pool.sendRpcChecked(proc, {
				type: "set_model",
				provider: command.model.provider,
				modelId: command.model.modelId,
			});
			const modelState = await this.pool.sendRpcChecked(proc, { type: "get_state" });
			const activeModel = modelState.data?.model;
			if (!activeModel || activeModel.provider !== command.model.provider || activeModel.id !== command.model.modelId) {
				throw new Error(`Failed to switch model to ${command.model.provider}/${command.model.modelId}`);
			}
		}
		if (command.thinkingLevel) {
			await this.pool.sendRpcChecked(proc, { type: "set_thinking_level", level: command.thinkingLevel });
		}

		// Set up event forwarding
		this.setupTurnEventForwarding(proc, newSessionPath, ws, makeTurnId());
		this.activeTurns.set(newSessionPath, { proc, sessionPath: newSessionPath, ws, turnId: makeTurnId() });

		// Send the prompt
		const promptCmd: any = { type: "prompt", message };
		if (command.images && command.images.length > 0) {
			promptCmd.images = command.images;
		}
		await this.pool.sendRpc(proc, promptCmd);

		ws.send(JSON.stringify({
			id, type: "response", command: "fork_prompt",
			success: true,
			data: { newSessionPath },
		}));
	}

	private async handleSetSessionName(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");

		const proc = await this.acquireForSession(sessionPath, ws);
		const response = await this.pool.sendRpc(proc, { type: "set_session_name", name: command.name });
		this.releaseProcess(sessionPath);
		ws.send(JSON.stringify({ ...response, id, command: "set_session_name" }));
	}

	// ── Internal helpers ─────────────────────────────────────────────────

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Acquire a process for an existing session. Resolves the session's cwd
	 * from its JSONL header and gets a process from the matching pool.
	 */
	private async acquireForSession(sessionPath: string, ws: WebSocket): Promise<RpcProcess> {
		// Already attached?
		const existing = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (existing) return existing;

		const cwd = getSessionCwd(sessionPath) || this.defaultCwd;
		const proc = await this.acquireProcess(cwd);

		this.busyProcesses.add(proc);
		this.lifecycle.attach(sessionPath, proc);

		// Mark session as streaming in the cache
		this.messageCache.setStreaming(sessionPath, true);

		// Switch to the target session — must await to ensure subsequent RPCs
		// (prompt, compact, fork, etc.) operate on the correct session.
		await this.pool.sendRpc(proc, { type: "switch_session", sessionPath });

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
			const proc = this.pool.acquire(cwd, this.busyProcesses);
			if (proc) return proc;

			// We're at capacity and have no process for this cwd.
			// Try to evict one idle process from another cwd to free a slot.
			const evicted = this.pool.evictIdleDifferentCwd(cwd, this.busyProcesses);
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

	/**
	 * Release a process from a session.
	 */
	private releaseProcess(sessionPath: string): void {
		const proc = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (proc) {
			this.busyProcesses.delete(proc);
			// Clean up event listener
			const cleanup = this.procEventCleanup.get(proc);
			if (cleanup) {
				cleanup();
				this.procEventCleanup.delete(proc);
			}
		}
		this.messageCache.setStreaming(sessionPath, false);
		this.lifecycle.detach(sessionPath);
		this.activeTurns.delete(sessionPath);

		// Push final messages to client after detach (authoritative disk state)
		if (this.connectedWs && this.connectedWs.readyState === WebSocket.OPEN && this.subscribedSession === sessionPath) {
			const cached = this.messageCache.load(sessionPath);
			this.connectedWs.send(JSON.stringify({
				type: "session_messages",
				sessionPath,
				messages: cached.messages,
				model: cached.model,
				thinkingLevel: cached.thinkingLevel,
			}));
		}
	}

	/**
	 * Get any live process for read-only operations (model queries, etc).
	 */
	private getAnyProcess(): RpcProcess {
		let proc = this.pool.getAny(this.busyProcesses);
		if (!proc) {
			proc = this.pool.spawn(this.defaultCwd);
		}
		return proc;
	}

	/**
	 * Set up event forwarding from a pi process to a WS client for a turn.
	 * Also handles agent_end to release the process.
	 */
	private setupTurnEventForwarding(
		proc: RpcProcess,
		sessionPath: string,
		ws: WebSocket,
		turnId: string,
	): void {
		// Clean up any existing listener for this process
		const existingCleanup = this.procEventCleanup.get(proc);
		if (existingCleanup) {
			existingCleanup();
			this.procEventCleanup.delete(proc);
		}

		const lineHandler = (line: string) => {
			let data: any;
			try {
				data = JSON.parse(line);
			} catch {
				return;
			}

			// Skip RPC responses — those are handled by the pool's pendingRequests
			if (data.type === "response" && data.id) return;

			// Update the server-side message cache
			this.messageCache.applyEvent(sessionPath, data);

			// Forward agent event to WS client, tagged with session path
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ ...data, sessionPath }));
			}

			// Dequeue steering on user message confirmation
			if (data.type === "message_end" && data.message?.role === "user") {
				const text = typeof data.message.content === "string"
					? data.message.content
					: (data.message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
				this.lifecycle.dequeueSteering(sessionPath, text);
			}

			// On agent_end: release process
			if (data.type === "agent_end") {
				debugTurn("agent_end_received", { turnId, procId: proc.id, sessionPath });
				this.lifecycle.clearSteering(sessionPath);
				this.releaseProcess(sessionPath);
			}
		};

		proc.rl.on("line", lineHandler);

		const cleanup = () => {
			proc.rl.removeListener("line", lineHandler);
		};
		this.procEventCleanup.set(proc, cleanup);
	}
}

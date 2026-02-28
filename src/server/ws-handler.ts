/**
 * WebSocket handler for pi-web.
 *
 * Multi-client model:
 * - Any number of clients can connect simultaneously
 * - Each client can subscribe to one session at a time
 * - Server compiles JSONL + streaming into canonical state and sends deltas
 */

import { WebSocket, type WebSocketServer } from "ws";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { SessionLifecycle } from "./session-lifecycle.js";
import { ProcessPool, type RpcProcess } from "./process-pool.js";
import { getSessionCwd } from "./session-cwd.js";
import { CompiledSessionStore } from "./compiled-session.js";
import { checkCommandAvailable, installPiGlobal, isPiInstallable, makePiNotFoundMessage } from "./pi-runtime.js";

export interface WsHandlerOptions {
	lifecycle: SessionLifecycle;
	pool: ProcessPool;
	compiledStore: CompiledSessionStore;
	defaultCwd: string;
	piLaunch: { command: string; baseArgs: string[] };
	ensurePool: () => void;
}

interface TurnState {
	proc: RpcProcess;
	sessionPath: string;
	ws: WebSocket;
	turnId: string;
}

interface ClientState {
	subscribedSession: string | null;
	lastVersion: number;
	lastMessageCount: number;
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
	private compiledStore: CompiledSessionStore;
	private defaultCwd: string;
	private piLaunch: { command: string; baseArgs: string[] };
	private ensurePool: () => void;

	private clients = new Map<WebSocket, ClientState>();
	private busyProcesses = new Set<RpcProcess>();
	private activeTurns = new Map<string, TurnState>();
	private procEventCleanup = new Map<RpcProcess, () => void>();

	private piAvailable: boolean;
	private piInstalling = false;

	constructor(options: WsHandlerOptions) {
		this.lifecycle = options.lifecycle;
		this.pool = options.pool;
		this.compiledStore = options.compiledStore;
		this.defaultCwd = options.defaultCwd;
		this.piLaunch = options.piLaunch;
		this.ensurePool = options.ensurePool;
		this.piAvailable = checkCommandAvailable(this.piLaunch.command);

		this.lifecycle.subscribe((event) => {
			switch (event.type) {
				case "session_attached":
					this.compiledStore.setStreaming(event.sessionPath, true);
					this.broadcast({
						type: "session_status_change",
						sessionPath: event.sessionPath,
						status: "running",
					});
					break;
				case "session_detached":
					this.compiledStore.setStreaming(event.sessionPath, false);
					this.broadcast({
						type: "session_status_change",
						sessionPath: event.sessionPath,
						status: "done",
					});
					break;
				case "steering_queue_update":
					this.compiledStore.setSteeringQueue(event.sessionPath, event.queue);
					break;
			}
		});

		this.compiledStore.subscribe(({ sessionPath }) => {
			for (const [ws, client] of this.clients) {
				if (client.subscribedSession !== sessionPath) continue;
				if (ws.readyState !== WebSocket.OPEN) continue;

				const op = this.compiledStore.computeUpdateOp(
					sessionPath,
					client.lastVersion,
					client.lastMessageCount,
				);
				if (!op) continue;

				ws.send(JSON.stringify({
					type: "session_update",
					sessionPath,
					...op,
				}));

				const latest = this.compiledStore.get(sessionPath);
				if (latest) {
					client.lastVersion = latest.version;
					client.lastMessageCount = latest.messages.length;
				}
			}
		});
	}

	get isPiAvailable(): boolean {
		return this.piAvailable;
	}

	notifySessionFileChanged(sessionPath: string): void {
		this.compiledStore.refreshIfChanged(sessionPath);
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
			connectedWsOpen: Array.from(this.clients.keys()).filter((ws) => ws.readyState === WebSocket.OPEN).length,
			processes,
		};
	}

	register(wss: WebSocketServer): void {
		wss.on("connection", (ws) => this.handleConnection(ws));
	}

	private handleConnection(ws: WebSocket): void {
		console.log("WebSocket client connected");
		this.clients.set(ws, {
			subscribedSession: null,
			lastVersion: 0,
			lastMessageCount: 0,
		});

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
			this.clients.delete(ws);
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
			ws.send(JSON.stringify({ id, type: "response", command: command.type, success: false, error: err.message }));
		}
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
			client.lastMessageCount = 0;
			ws.send(JSON.stringify({ id, type: "response", command: "subscribe_session", success: true, data: {} }));
			return;
		}

		client.subscribedSession = sessionPath;
		const state = this.compiledStore.load(sessionPath);
		client.lastVersion = state.version;
		client.lastMessageCount = state.messages.length;

		ws.send(JSON.stringify({
			type: "session_update",
			sessionPath,
			op: "snapshot",
			state,
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
			this.compiledStore.setStreaming(sessionPath, true);

			ws.send(JSON.stringify({
				type: "session_attached",
				sessionPath,
				cwd,
				firstMessage: command.message,
			}));
			this.lifecycle.attach(sessionPath, proc);
		} else {
			proc = await this.acquireForSession(sessionPath);
		}

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

		this.setupTurnEventForwarding(proc, sessionPath, ws, turnId);
		this.activeTurns.set(sessionPath, { proc, sessionPath, ws, turnId });

		const promptCmd: any = { type: "prompt", message: command.message };
		if (command.images?.length > 0) {
			promptCmd.images = command.images;
		}
		const response = await this.pool.sendRpc(proc, promptCmd);
		const enriched = { ...response };
		if (!enriched.data) enriched.data = {};
		enriched.data.newSessionPath = sessionPath;
		ws.send(JSON.stringify({ ...enriched, id, command: "prompt" }));
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

		const cwd = getSessionCwd(sessionPath) || this.defaultCwd;
		const proc = await this.acquireProcess(cwd);
		await this.pool.waitForReady(proc);
		this.busyProcesses.add(proc);
		this.compiledStore.setStreaming(newSessionPath, true);

		ws.send(JSON.stringify({ type: "session_attached", sessionPath: newSessionPath, cwd, firstMessage: message }));
		this.lifecycle.attach(newSessionPath, proc);
		await this.pool.sendRpc(proc, { type: "switch_session", sessionPath: newSessionPath });

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

		this.setupTurnEventForwarding(proc, newSessionPath, ws, makeTurnId());
		this.activeTurns.set(newSessionPath, { proc, sessionPath: newSessionPath, ws, turnId: makeTurnId() });

		const promptCmd: any = { type: "prompt", message };
		if (command.images?.length > 0) {
			promptCmd.images = command.images;
		}
		await this.pool.sendRpc(proc, promptCmd);

		ws.send(JSON.stringify({ id, type: "response", command: "fork_prompt", success: true, data: { newSessionPath } }));
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

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Acquire a process for an existing session. Resolves the session's cwd
	 * from its JSONL header and gets a process from the matching pool.
	 */
	private async acquireForSession(sessionPath: string): Promise<RpcProcess> {
		const existing = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (existing) return existing;

		const cwd = getSessionCwd(sessionPath) || this.defaultCwd;
		const proc = await this.acquireProcess(cwd);
		this.busyProcesses.add(proc);
		this.lifecycle.attach(sessionPath, proc);
		this.compiledStore.setStreaming(sessionPath, true);
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

	private releaseProcess(sessionPath: string): void {
		const proc = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (proc) {
			this.busyProcesses.delete(proc);
			const cleanup = this.procEventCleanup.get(proc);
			if (cleanup) {
				cleanup();
				this.procEventCleanup.delete(proc);
			}
		}
		this.compiledStore.setStreaming(sessionPath, false);
		this.lifecycle.detach(sessionPath);
		this.activeTurns.delete(sessionPath);
		this.pushSnapshotToSubscribers(sessionPath);
	}

	private getAnyProcess(): RpcProcess {
		let proc = this.pool.getAny(this.busyProcesses);
		if (!proc) {
			proc = this.pool.spawn(this.defaultCwd);
		}
		return proc;
	}

	private pushSnapshotToSubscribers(sessionPath: string) {
		const state = this.compiledStore.load(sessionPath);
		for (const [ws, client] of this.clients) {
			if (client.subscribedSession !== sessionPath) continue;
			if (ws.readyState !== WebSocket.OPEN) continue;
			ws.send(JSON.stringify({
				type: "session_update",
				sessionPath,
				op: "snapshot",
				state,
			}));
			client.lastVersion = state.version;
			client.lastMessageCount = state.messages.length;
		}
	}

	private setupTurnEventForwarding(proc: RpcProcess, sessionPath: string, ws: WebSocket, turnId: string): void {
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
			if (data.type === "response" && data.id) return;

			this.compiledStore.applyEvent(sessionPath, data);

			// Side-channel raw event for UI hooks (canvas/jsonl), not state updates
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "agent_event", sessionPath, event: data }));
			}

			if (data.type === "message_end" && data.message?.role === "user") {
				const text = typeof data.message.content === "string"
					? data.message.content
					: (data.message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
				this.lifecycle.dequeueSteering(sessionPath, text);
			}

			if (data.type === "agent_end") {
				debugTurn("agent_end_received", { turnId, procId: proc.id, sessionPath });
				this.lifecycle.clearSteering(sessionPath);
				this.releaseProcess(sessionPath);
			}
		};

		proc.rl.on("line", lineHandler);
		const cleanup = () => proc.rl.removeListener("line", lineHandler);
		this.procEventCleanup.set(proc, cleanup);
	}
}

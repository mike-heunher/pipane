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
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { SessionLifecycle } from "./session-lifecycle.js";
import { ProcessPool, type RpcProcess } from "./process-pool.js";
import {
	SessionJsonl,
	readSessionFromDisk,
	getSessionFileSize,
	type SessionState,
} from "./session-jsonl.js";
import { getSessionCwd } from "./session-cwd.js";
import { checkCommandAvailable, installPiGlobal, isPiInstallable, makePiNotFoundMessage } from "./pi-runtime.js";
import type { LoadTraceStore } from "./load-trace-store.js";

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
	private procEventCleanup = new Map<RpcProcess, () => void>();
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
				case "hard_kill":
					await this.handleHardKill(ws, id, command);
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

		ws.send(JSON.stringify({ id, type: "response", command: "subscribe_session", success: true, data: {} }));
	}

	private async handlePrompt(ws: WebSocket, id: string, command: any): Promise<void> {
		let sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");

		const turnId = makeTurnId();
		debugTurn("prompt_start", { turnId, sessionPath, hasModel: !!command.model });

		let proc: RpcProcess | undefined;
		try {
			if (sessionPath === "__new__") {
				const cwd = command.cwd as string || this.defaultCwd;
				proc = await this.acquireProcess(cwd);
				await this.pool.waitForReady(proc);

				await this.pool.sendRpc(proc, { type: "new_session" });
				const stateResp = await this.pool.sendRpc(proc, { type: "get_state" });
				sessionPath = stateResp.data?.sessionFile;
				if (!sessionPath) throw new Error("Failed to get session path from new session");

				this.busyProcesses.add(proc);

				// Create attached session with empty state (new session)
				this.createAttachedSession(sessionPath);

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

			if (!command.model) {
				throw new Error(`BUG: prompt command received without model. sessionPath=${sessionPath}`);
			}
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

			if (command.thinkingLevel) {
				await this.pool.sendRpcChecked(proc, { type: "set_thinking_level", level: command.thinkingLevel });
			}

			this.setupTurnEventForwarding(proc, sessionPath, ws, turnId);

			const promptCmd: any = { type: "prompt", message: command.message };
			if (command.images?.length > 0) {
				promptCmd.images = command.images;
			}
			const response = await this.pool.sendRpc(proc, promptCmd);
			const enriched = { ...response };
			if (!enriched.data) enriched.data = {};
			enriched.data.newSessionPath = sessionPath;
			ws.send(JSON.stringify({ ...enriched, id, command: "prompt" }));
		} catch (err: any) {
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

	private async handleHardKill(ws: WebSocket, id: string, command: any): Promise<void> {
		const sessionPath = command.sessionPath as string;
		if (!sessionPath) throw new Error("Missing sessionPath");

		const proc = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (!proc) {
			ws.send(JSON.stringify({
				id,
				type: "response",
				command: "hard_kill",
				success: true,
				data: { killed: false, reason: "not_attached" },
			}));
			return;
		}

		const cleanup = this.procEventCleanup.get(proc);
		if (cleanup) {
			cleanup();
			this.procEventCleanup.delete(proc);
		}

		this.attachedSessions.delete(sessionPath);
		this.lifecycle.clearSteering(sessionPath);
		this.lifecycle.detach(sessionPath);
		this.busyProcesses.delete(proc);
		this.decommissionProcesses.delete(proc);

		if (proc.process.exitCode === null) {
			proc.process.kill("SIGKILL");
		}

		if (existsSync(sessionPath)) {
			const { json, hash } = readSessionFromDisk(sessionPath);
			this.subscribedFileSizes.set(sessionPath, getSessionFileSize(sessionPath));
			this.pushSnapshotToSubscribers(sessionPath, json, hash);
		}

		this.ensurePool();
		ws.send(JSON.stringify({ id, type: "response", command: "hard_kill", success: true, data: { killed: true } }));
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

		try {
			// Create attached session, seeded from the forked file
			this.createAttachedSession(newSessionPath);

			ws.send(JSON.stringify({ type: "session_attached", sessionPath: newSessionPath, cwd, firstMessage: message }));
			this.lifecycle.attach(newSessionPath, proc);
			await this.pool.sendRpc(proc, { type: "switch_session", sessionPath: newSessionPath });

			if (!command.model) {
				throw new Error(`BUG: fork_prompt command received without model. sessionPath=${newSessionPath}`);
			}
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

			if (command.thinkingLevel) {
				await this.pool.sendRpcChecked(proc, { type: "set_thinking_level", level: command.thinkingLevel });
			}

			const turnId = makeTurnId();
			this.setupTurnEventForwarding(proc, newSessionPath, ws, turnId);

			const promptCmd: any = { type: "prompt", message };
			if (command.images?.length > 0) {
				promptCmd.images = command.images;
			}
			await this.pool.sendRpc(proc, promptCmd);

			ws.send(JSON.stringify({ id, type: "response", command: "fork_prompt", success: true, data: { newSessionPath } }));
		} catch (err: any) {
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
		this.lifecycle.attach(sessionPath, proc);

		// Create attached session if it doesn't exist yet
		if (!this.attachedSessions.has(sessionPath)) {
			this.createAttachedSession(sessionPath);
		}

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
			const unavailable = this.getUnavailableProcesses();
			const proc = this.pool.acquire(cwd, unavailable);
			if (proc) return proc;

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

	private releaseProcess(sessionPath: string): void {
		const proc = this.lifecycle.getAttachedProcess(sessionPath) as RpcProcess | undefined;
		if (proc) {
			const cleanup = this.procEventCleanup.get(proc);
			if (cleanup) {
				cleanup();
				this.procEventCleanup.delete(proc);
			}
		}

		// Delete the attached session — no more in-memory state
		this.attachedSessions.delete(sessionPath);

		this.lifecycle.detach(sessionPath);

		// Read final state from disk and push to subscribers
		const { json, hash } = readSessionFromDisk(sessionPath);
		this.subscribedFileSizes.set(sessionPath, getSessionFileSize(sessionPath));
		this.pushSnapshotToSubscribers(sessionPath, json, hash);

		if (proc) {
			const shouldDecommission = this.decommissionProcesses.has(proc);
			if (shouldDecommission) {
				this.decommissionProcesses.delete(proc);
				console.log(`[pool] Decommissioning pi#${proc.id} after completed turn`);
				proc.process.kill("SIGTERM");
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

	private setupTurnEventForwarding(proc: RpcProcess, sessionPath: string, ws: WebSocket, turnId: string): void {
		const existingCleanup = this.procEventCleanup.get(proc);
		if (existingCleanup) {
			existingCleanup();
			this.procEventCleanup.delete(proc);
		}

		// Capture the SessionJsonl object — if it gets deleted (detach),
		// the handler becomes a no-op because we check for it.
		const sessionRef = this.attachedSessions.get(sessionPath);
		if (!sessionRef) {
			console.error(`[turn] setupTurnEventForwarding called but no SessionJsonl for ${sessionPath}`);
			return;
		}

		const lineHandler = (line: string) => {
			let data: any;
			try {
				data = JSON.parse(line);
			} catch {
				return;
			}
			if (data.type === "response" && data.id) return;

			// Guard: if the attached session was deleted (turn ended),
			// this handler is stale — skip.
			const currentSession = this.attachedSessions.get(sessionPath);
			if (currentSession !== sessionRef) return;

			// Apply event to the in-memory attached session
			let changed = currentSession.applyEvent(data);

			// After auto-compaction, the pi process rewrites the JSONL and calls
			// replaceMessages() internally.  SessionJsonl doesn't know about this,
			// so re-read the session from disk to pick up the compacted state.
			if (data.type === "auto_compaction_end" && data.result) {
				const { state } = readSessionFromDisk(sessionPath);
				currentSession.replaceMessages(state.messages);
				changed = true;
			}

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

			// Push update to all subscribed clients
			if (changed) {
				this.pushUpdateToSubscribers(sessionPath, currentSession);
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

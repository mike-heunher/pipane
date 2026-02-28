/**
 * pi-web backend server.
 *
 * Architecture: sessions are either "detached" (read from JSONL on disk)
 * or "attached" (a pi RPC process is running a turn for them).
 *
 * A pool of pi RPC processes is maintained. When a user sends a message,
 * a free pi is acquired from the pool, switched to that session, and runs
 * one turn. After the turn completes, pi is released back to the pool.
 * Multiple sessions can be attached simultaneously (parallel turns).
 *
 * Messages for detached sessions are read directly from JSONL files
 * using the SessionManager utilities (no pi process needed).
 */

import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { unlink, copyFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { WebSocketServer, WebSocket } from "ws";
import {
	SessionManager,
	getAgentDir,
	buildSessionContext,
	parseSessionEntries,
} from "@mariozechner/pi-coding-agent";
import { resolvePiLaunch } from "./pi-launch";
import { checkCommandAvailable, installPiGlobal, isPiInstallable, makePiNotFoundMessage } from "./pi-runtime";
const PORT = parseInt(process.env.PORT || "18111", 10);
const PI_CWD = process.env.PI_CWD || process.cwd();

const PI_CLI = process.env.PI_CLI;
const PI_LAUNCH = resolvePiLaunch(PI_CLI);
let PI_AVAILABLE = checkCommandAvailable(PI_LAUNCH.command);
let PI_INSTALLING = false;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Serve static files in production
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../client");
app.use(express.static(clientDist));

// ============================================================================
// REST API
// ============================================================================

app.get("/api/sessions", async (_req, res) => {
	try {
		const sessions = await SessionManager.listAll();
		const result = sessions.map((s) => {
			// Extract last user prompt timestamp from the session file
			let lastUserPromptTime: string | undefined;
			try {
				if (existsSync(s.path)) {
					const content = readFileSync(s.path, "utf8");
					const entries = parseSessionEntries(content);
					let latestUserTs = 0;
					for (const entry of entries) {
						if ((entry as any).type !== "message") continue;
						const msg = (entry as any).message;
						if (!msg || msg.role !== "user") continue;
						// Check message timestamp first (epoch ms), then entry timestamp (ISO string)
						if (typeof msg.timestamp === "number" && msg.timestamp > latestUserTs) {
							latestUserTs = msg.timestamp;
						} else if (typeof (entry as any).timestamp === "string") {
							const t = new Date((entry as any).timestamp).getTime();
							if (!Number.isNaN(t) && t > latestUserTs) {
								latestUserTs = t;
							}
						}
					}
					if (latestUserTs > 0) {
						lastUserPromptTime = new Date(latestUserTs).toISOString();
					}
				}
			} catch {
				// Ignore errors - lastUserPromptTime will be undefined
			}

			return {
				id: s.id,
				path: s.path,
				cwd: s.cwd,
				name: s.name,
				created: s.created.toISOString(),
				modified: s.modified.toISOString(),
				lastUserPromptTime,
				messageCount: s.messageCount,
				firstMessage: s.firstMessage,
			};
		});
		res.json(result);
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

app.delete("/api/sessions", async (req, res) => {
	try {
		// Manually parse JSON body to avoid express.json() / body-parser dependency issues
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());

		const { path: sessionPath } = body;
		if (!sessionPath || typeof sessionPath !== "string") {
			res.status(400).json({ error: "Missing session path" });
			return;
		}
		if (!sessionPath.endsWith(".jsonl") || !existsSync(sessionPath)) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		await unlink(sessionPath);
		res.json({ success: true });
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

/**
 * Read messages from a session JSONL file directly (no pi process needed).
 */
app.get("/api/sessions/messages", (req, res) => {
	try {
		const sessionPath = req.query.path as string;
		if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
			res.status(400).json({ error: "Missing or invalid session path" });
			return;
		}
		if (!existsSync(sessionPath)) {
			res.status(404).json({ error: "Session file not found" });
			return;
		}

		const content = readFileSync(sessionPath, "utf8");
		const entries = parseSessionEntries(content);
		const context = buildSessionContext(entries as any);

		res.json({
			messages: context.messages,
			model: context.model,
			thinkingLevel: context.thinkingLevel,
		});
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

/**
 * Browse directories on disk (for folder picker).
 */
app.get("/api/browse", (req, res) => {
	try {
		const requestedPath = (req.query.path as string) || process.env.HOME || "/";
		const resolved = path.resolve(requestedPath.replace(/^~/, process.env.HOME || "/"));

		if (!existsSync(resolved)) {
			res.status(404).json({ error: "Path not found" });
			return;
		}

		const entries = readdirSync(resolved, { withFileTypes: true });
		const dirs = entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => ({
				name: e.name,
				path: path.join(resolved, e.name),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));

		res.json({ path: resolved, dirs });
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

/**
 * Debug view of pi process pool and session attachments.
 */
app.get("/api/debug/pool", (_req, res) => {
	try {
		const attachedBySession: Record<string, number> = {};
		for (const [sessionPath, proc] of attachedSessions) {
			attachedBySession[sessionPath] = proc.id;
		}

		const processes = pool.map((p) => ({
			id: p.id,
			pid: p.process.pid ?? null,
			alive: p.process.exitCode === null,
			exitCode: p.process.exitCode,
			attachedSession: p.attachedSession,
			sessionStatus: p.attachedSession ? sessionStatus.get(p.attachedSession) ?? null : null,
			pendingRequests: p.pendingRequests.size,
		}));

		res.json({
			now: new Date().toISOString(),
			poolSize: POOL_SIZE,
			liveProcesses: processes.filter((p) => p.alive).length,
			attachedSessionCount: attachedSessions.size,
			sessionStatus: getSessionStatuses(),
			attachedBySession,
			connectedWsOpen: !!connectedWs && connectedWs.readyState === WebSocket.OPEN,
			processes,
		});
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/debug/pool", (_req, res) => {
	res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>pi-web pool debug</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 16px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 12px; text-align: left; }
    th { background: #f6f6f6; }
    .ok { color: #0a7d22; }
    .bad { color: #b42318; }
  </style>
</head>
<body>
  <h3>pi-web pool debug</h3>
  <div id="meta">loading…</div>
  <table>
    <thead>
      <tr>
        <th>proc</th><th>pid</th><th>alive</th><th>attachedSession</th><th>sessionStatus</th><th>pendingRequests</th><th>exitCode</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <pre id="raw"></pre>
<script>
async function tick(){
  const r = await fetch('/api/debug/pool');
  const d = await r.json();
  document.getElementById('meta').textContent =
    'now=' + d.now + ' live=' + d.liveProcesses + '/' + d.poolSize + ' attached=' + d.attachedSessionCount + ' wsOpen=' + d.connectedWsOpen;
  const rows = (d.processes || []).map(p =>
    '<tr><td>' + p.id + '</td><td>' + (p.pid ?? '') + '</td><td class="' + (p.alive ? 'ok':'bad') + '">' + p.alive + '</td><td>' + (p.attachedSession ?? '') + '</td><td>' + (p.sessionStatus ?? '') + '</td><td>' + p.pendingRequests + '</td><td>' + (p.exitCode ?? '') + '</td></tr>'
  ).join('');
  document.getElementById('rows').innerHTML = rows;
  document.getElementById('raw').textContent = JSON.stringify({ sessionStatus: d.sessionStatus, attachedBySession: d.attachedBySession }, null, 2);
}
setInterval(tick, 1000); tick();
</script>
</body>
</html>`);
});

// ============================================================================
// Pi Process Pool
// ============================================================================

interface RpcProcess {
	id: number;
	process: ChildProcess;
	rl: readline.Interface;
	pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>;
	requestId: number;
	/** Which session this process is currently attached to (null = idle in pool) */
	attachedSession: string | null;
	/** Forward agent events to this WS client */
	eventTarget: WebSocket | null;
	/** Session path for tagging events */
	sessionPath: string | null;
	/** Called when agent_end is received */
	onAgentEnd: (() => void) | null;
	/** Correlation id for the currently running prompt turn (debug logging) */
	currentTurnId: string | null;
}

const POOL_SIZE = 3;
let nextProcId = 0;
let nextTurnId = 0;
const pool: RpcProcess[] = [];
/** Map from session path → attached RPC process */
const attachedSessions = new Map<string, RpcProcess>();

function makeTurnId(): string {
	return `turn_${Date.now()}_${++nextTurnId}`;
}

function debugTurn(stage: string, data: Record<string, any>) {
	console.log(`[turn] ${stage} ${JSON.stringify(data)}`);
}

/** Server-side steering queue: queued messages per session. */
const steeringQueues = new Map<string, string[]>();

function getSteeringQueue(sessionPath: string): string[] {
	let q = steeringQueues.get(sessionPath);
	if (!q) {
		q = [];
		steeringQueues.set(sessionPath, q);
	}
	return q;
}

function broadcastSteeringQueue(sessionPath: string) {
	if (!connectedWs || connectedWs.readyState !== WebSocket.OPEN) return;
	const queue = steeringQueues.get(sessionPath) ?? [];
	connectedWs.send(JSON.stringify({
		type: "steering_queue_update",
		sessionPath,
		queue,
	}));
}

/**
 * Persistent (for server lifetime) session status tracking.
 * "running" = pi process currently attached and executing a turn.
 * "done"    = pi process was attached at some point and has since detached.
 * Absent    = never had a pi process attached during this server run.
 */
const sessionStatus = new Map<string, "running" | "done">();

/** Get all session statuses as a plain object for sending over WS. */
function getSessionStatuses(): Record<string, "running" | "done"> {
	const result: Record<string, "running" | "done"> = {};
	for (const [k, v] of sessionStatus) result[k] = v;
	return result;
}

function spawnRpcProcess(cwd?: string): RpcProcess {
	if (!PI_AVAILABLE) {
		throw new Error(makePiNotFoundMessage(PI_LAUNCH.command));
	}
	const procId = ++nextProcId;
	const useCwd = cwd || PI_CWD;
	console.log(`[pool] Spawning pi process #${procId} (cwd: ${useCwd})...`);

	// Resolve canvas extension relative to project root (2 dirs up from src/server or dist/server)
	const canvasExtension = path.resolve(__dirname, "../../extensions/canvas.ts");

	const child = spawn(PI_LAUNCH.command, [
		...PI_LAUNCH.baseArgs,
		"--mode", "rpc",
		"-e", canvasExtension,
	], {
		cwd: useCwd,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	});

	child.stderr?.on("data", (data: Buffer) => {
		process.stderr.write(`[pi#${procId}] ${data.toString()}`);
	});

	const rl = readline.createInterface({ input: child.stdout!, terminal: false });

	const proc: RpcProcess = {
		id: procId,
		process: child,
		rl,
		pendingRequests: new Map(),
		requestId: 0,
		attachedSession: null,
		eventTarget: null,
		sessionPath: null,
		onAgentEnd: null,
		currentTurnId: null,
	};

	child.on("exit", (code) => {
		console.log(`[pool] pi#${proc.id} exited (code ${code})`);
		// Remove from pool
		const idx = pool.indexOf(proc);
		if (idx !== -1) pool.splice(idx, 1);

		// If the process was attached to a session, clean up properly:
		// update sessionStatus and notify the WS client so the frontend
		// doesn't show a permanently-wedged "running" badge.
		if (proc.attachedSession) {
			const sessionPath = proc.attachedSession;
			attachedSessions.delete(sessionPath);
			sessionStatus.set(sessionPath, "done");
			debugTurn("status_done_set_on_exit", {
				turnId: proc.currentTurnId,
				procId: proc.id,
				sessionPath,
				exitCode: code,
			});
			console.log(`[pool] pi#${proc.id} crashed while attached to ${path.basename(sessionPath)} — marking done`);

			// Notify connected WebSocket client
			if (connectedWs && connectedWs.readyState === WebSocket.OPEN) {
				connectedWs.send(JSON.stringify({ type: "session_detached", sessionPath }));
				debugTurn("session_detached_sent_on_exit", {
					turnId: proc.currentTurnId,
					procId: proc.id,
					sessionPath,
				});
			}

			// Reject any pending RPC requests so callers don't hang
			for (const [reqId, pending] of proc.pendingRequests) {
				pending.reject(new Error(`pi process #${proc.id} exited unexpectedly (code ${code})`));
			}
			proc.pendingRequests.clear();

			proc.attachedSession = null;
			proc.eventTarget = null;
			proc.sessionPath = null;
			proc.currentTurnId = null;
		}

		// Replenish the pool
		ensurePoolSize();
	});

	rl.on("line", (line: string) => {
		let data: any;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}

		// Response to a pending RPC request
		if (data.type === "response" && data.id && proc.pendingRequests.has(data.id)) {
			const pending = proc.pendingRequests.get(data.id)!;
			proc.pendingRequests.delete(data.id);
			pending.resolve(data);
			return;
		}

		// Agent event — forward to the WS client, tagged with session path
		if (proc.eventTarget && proc.eventTarget.readyState === WebSocket.OPEN && proc.sessionPath) {
			proc.eventTarget.send(JSON.stringify({
				...data,
				sessionPath: proc.sessionPath,
			}));
		}

		// Dequeue steering messages when user message is confirmed by the agent
		if (data.type === "message_end" && data.message?.role === "user" && proc.sessionPath) {
			const queue = steeringQueues.get(proc.sessionPath);
			if (queue && queue.length > 0) {
				const text = typeof data.message.content === "string"
					? data.message.content
					: (data.message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
				const idx = queue.indexOf(text);
				if (idx !== -1) {
					queue.splice(idx, 1);
					if (queue.length === 0) steeringQueues.delete(proc.sessionPath);
					broadcastSteeringQueue(proc.sessionPath);
				}
			}
		}

		// Clear steering queue on agent_end and auto-release the process
		if (data.type === "agent_end") {
			debugTurn("agent_end_received", {
				turnId: proc.currentTurnId,
				procId: proc.id,
				sessionPath: proc.sessionPath,
			});
			if (proc.sessionPath) {
				steeringQueues.delete(proc.sessionPath);
				broadcastSteeringQueue(proc.sessionPath);
			}
			if (proc.onAgentEnd) {
				const cb = proc.onAgentEnd;
				proc.onAgentEnd = null;
				cb();
			}
		}
	});

	pool.push(proc);
	console.log(`[pool] pi#${procId} ready (pool size: ${pool.length})`);
	return proc;
}

function sendRpc(proc: RpcProcess, command: any): Promise<any> {
	if (!proc.process || proc.process.exitCode !== null) {
		return Promise.reject(new Error("RPC process is dead"));
	}

	const id = `req_${++proc.requestId}`;
	const fullCommand = { ...command, id };

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			proc.pendingRequests.delete(id);
			reject(new Error(`Timeout waiting for RPC response to ${command.type}`));
		}, 30000);

		proc.pendingRequests.set(id, {
			resolve: (data: any) => {
				clearTimeout(timeout);
				resolve(data);
			},
			reject: (err: Error) => {
				clearTimeout(timeout);
				reject(err);
			},
		});

		proc.process.stdin!.write(JSON.stringify(fullCommand) + "\n");
	});
}

async function sendRpcChecked(proc: RpcProcess, command: any): Promise<any> {
	const response = await sendRpc(proc, command);
	if (!response?.success) {
		throw new Error(response?.error || `RPC command failed: ${command.type}`);
	}
	return response;
}

/**
 * Acquire a pi process from the pool. If none are idle, spawn a new one.
 * Switches it to the target session.
 */
async function acquirePi(sessionPath: string, ws: WebSocket): Promise<RpcProcess> {
	// Already attached?
	const existing = attachedSessions.get(sessionPath);
	if (existing) {
		existing.eventTarget = ws;
		return existing;
	}

	// Find an idle process
	let proc = pool.find((p) => !p.attachedSession && p.process.exitCode === null);

	if (!proc) {
		proc = spawnRpcProcess();
		// Wait for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	// Switch to the target session
	proc.attachedSession = sessionPath;
	proc.eventTarget = ws;
	proc.sessionPath = sessionPath;
	attachedSessions.set(sessionPath, proc);
	sessionStatus.set(sessionPath, "running");
	debugTurn("status_running_set", {
		turnId: proc.currentTurnId,
		procId: proc.id,
		sessionPath,
		reason: "acquire_existing_session",
	});

	await sendRpc(proc, { type: "switch_session", sessionPath });

	console.log(`[pool] pi#${proc.id} attached to ${path.basename(sessionPath)}`);
	return proc;
}

/**
 * Release a pi process back to the pool after a turn completes.
 */
function releasePi(proc: RpcProcess) {
	const sessionPath = proc.attachedSession;
	debugTurn("release_called", {
		turnId: proc.currentTurnId,
		procId: proc.id,
		sessionPath,
	});
	console.log(`[pool] pi#${proc.id} released from ${sessionPath ? path.basename(sessionPath) : "?"}`);
	if (sessionPath) {
		attachedSessions.delete(sessionPath);
		sessionStatus.set(sessionPath, "done");
		debugTurn("status_done_set", {
			turnId: proc.currentTurnId,
			procId: proc.id,
			sessionPath,
		});
	}
	proc.attachedSession = null;
	proc.eventTarget = null;
	proc.sessionPath = null;
	proc.currentTurnId = null;
	// Replenish pool if a process died while attached
	ensurePoolSize();
}

/**
 * Ensure the pool has at least POOL_SIZE live processes.
 * Spawns new ones if needed (non-blocking).
 */
function ensurePoolSize() {
	if (!PI_AVAILABLE) return;
	const alive = pool.filter((p) => p.process.exitCode === null).length;
	const needed = POOL_SIZE - alive;
	for (let i = 0; i < needed; i++) {
		spawnRpcProcess();
	}
}

/**
 * Get any live pi process (idle preferred), or spawn one.
 */
async function getOrSpawnIdlePi(): Promise<RpcProcess> {
	let proc = pool.find((p) => !p.attachedSession && p.process.exitCode === null);
	if (!proc) {
		proc = pool.find((p) => p.process.exitCode === null);
	}
	if (!proc) {
		proc = spawnRpcProcess();
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return proc;
}

/**
 * Get user messages from a session JSONL file (for fork selector).
 * Reads the file directly without needing a pi process.
 */
app.get("/api/sessions/fork-messages", (req, res) => {
	try {
		const sessionPath = req.query.path as string;
		if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
			res.status(400).json({ error: "Missing or invalid session path" });
			return;
		}
		if (!existsSync(sessionPath)) {
			res.status(404).json({ error: "Session file not found" });
			return;
		}

		const content = readFileSync(sessionPath, "utf8");
		const entries = parseSessionEntries(content);
		const messages: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if ((entry as any).type !== "message") continue;
			const msg = (entry as any).message;
			if (!msg || msg.role !== "user") continue;

			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				text = msg.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
			}

			if (text && (entry as any).id) {
				messages.push({ entryId: (entry as any).id, text });
			}
		}

		res.json({ messages });
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

// ============================================================================
// Slash Command Handling
// ============================================================================

function mapSlashCommand(text: string): { rpc: any } | { response: any } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;

	const spaceIdx = trimmed.indexOf(" ");
	const cmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
	const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

	switch (cmd) {
		case "help":
			return {
				response: {
					type: "event",
					event: "system_message",
					data: {
						message: [
							"Available commands:",
							"  /help              — Show this help",
							"  /model [search]    — List or search available models",
							"  /model:provider/id — Switch to a specific model",
							"  /compact [instr]   — Compact conversation history",
							"  /new               — Start a new session",
							"  /name [name]       — Set session name",
							"  /resume            — List sessions to resume",
							"  /export [path]     — Export session as HTML",
							"  /debug             — Show debug info",
							"",
							"Extension and skill commands are also available.",
							"Use /commands to list them.",
						].join("\n"),
					},
				},
			};

		case "name":
			if (args) return { rpc: { type: "set_session_name", name: args } };
			return { rpc: { type: "get_state" } };

		case "export":
			return { rpc: { type: "export_html", outputPath: args || undefined } };

		case "debug":
			return { rpc: { type: "get_session_stats" } };

		case "resume":
			return {
				response: {
					type: "event",
					event: "system_message",
					data: { message: "Use the session picker in the sidebar to switch sessions." },
				},
			};

		case "commands":
			return { rpc: { type: "get_commands" } };

		default:
			if (cmd.startsWith("model:")) {
				const modelSpec = cmd.slice(6);
				const slashIdx = modelSpec.indexOf("/");
				if (slashIdx !== -1) {
					return {
						rpc: {
							type: "set_model",
							provider: modelSpec.slice(0, slashIdx),
							modelId: modelSpec.slice(slashIdx + 1),
						},
					};
				}
			}

			if (cmd === "model") {
				return { rpc: { type: "get_available_models" } };
			}

			return null;
	}
}

// ============================================================================
// WebSocket Handler
// ============================================================================

let connectedWs: WebSocket | null = null;

wss.on("connection", async (ws) => {
	console.log("WebSocket client connected");

	if (connectedWs && connectedWs.readyState === WebSocket.OPEN) {
		connectedWs.close(1000, "Replaced by new connection");
	}
	connectedWs = ws;

	// Send initial state: all session statuses (running/done) tracked this server lifetime
	// Include steering queues so client picks up any pending steers on reconnect
	const steeringQueuesObj: Record<string, string[]> = {};
	for (const [k, v] of steeringQueues) {
		if (v.length > 0) steeringQueuesObj[k] = [...v];
	}
	ws.send(JSON.stringify({
		type: "init",
		sessionStatuses: getSessionStatuses(),
		steeringQueues: steeringQueuesObj,
	}));

	if (!PI_AVAILABLE) {
		ws.send(JSON.stringify({
			type: "pi_install_required",
			command: PI_LAUNCH.command,
			installable: isPiInstallable(PI_LAUNCH.command, PI_LAUNCH.baseArgs),
			installing: PI_INSTALLING,
			message: makePiNotFoundMessage(PI_LAUNCH.command),
		}));
	}

	ws.on("message", async (raw) => {
		let command: any;
		try {
			command = JSON.parse(raw.toString());
		} catch {
			ws.send(JSON.stringify({ type: "response", command: "parse", success: false, error: "Invalid JSON" }));
			return;
		}

		const id = command.id;

		try {
			if (!PI_AVAILABLE && command.type !== "install_pi" && command.type !== "get_session_statuses") {
				ws.send(JSON.stringify({
					type: "pi_install_required",
					command: PI_LAUNCH.command,
					installable: isPiInstallable(PI_LAUNCH.command, PI_LAUNCH.baseArgs),
					installing: PI_INSTALLING,
					message: makePiNotFoundMessage(PI_LAUNCH.command),
				}));
				if (id) {
					ws.send(JSON.stringify({
						id, type: "response", command: command.type, success: false,
						error: makePiNotFoundMessage(PI_LAUNCH.command),
					}));
				}
				return;
			}

			switch (command.type) {
				case "install_pi": {
					const installable = isPiInstallable(PI_LAUNCH.command, PI_LAUNCH.baseArgs);
					if (!installable) {
						throw new Error(`Automatic install not supported for command '${PI_LAUNCH.command}'. Set PI_CLI or install manually.`);
					}
					if (!PI_INSTALLING) {
						PI_INSTALLING = true;
						if (connectedWs && connectedWs.readyState === WebSocket.OPEN) {
							connectedWs.send(JSON.stringify({
								type: "pi_install_required",
								command: PI_LAUNCH.command,
								installable: true,
								installing: true,
								message: "Installing pi...",
							}));
						}
						const ok = await installPiGlobal();
						PI_INSTALLING = false;
						PI_AVAILABLE = checkCommandAvailable(PI_LAUNCH.command);
						if (!ok || !PI_AVAILABLE) {
							throw new Error("pi installation failed. Please install manually and restart the server.");
						}
						console.log("[pi] pi installed successfully");
						console.log(`[pool] Starting ${POOL_SIZE} pi processes...`);
						ensurePoolSize();
					}
					ws.send(JSON.stringify({ id, type: "response", command: "install_pi", success: true, data: {} }));
					break;
				}
				// ── Prompt: attach pi, run one turn ──────────────────────
				case "prompt": {
					let sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");

					const turnId = makeTurnId();
					debugTurn("prompt_start", {
						turnId,
						incomingSessionPath: sessionPath,
						hasModel: !!command.model,
						hasThinkingLevel: !!command.thinkingLevel,
						hasImages: !!(command.images && command.images.length > 0),
					});

					let proc: RpcProcess;

					if (sessionPath === "__new__") {
						const cwd = command.cwd as string | undefined;
						// For new sessions with a specific CWD, spawn a dedicated pi process
						if (cwd) {
							proc = spawnRpcProcess(cwd);
							await new Promise((resolve) => setTimeout(resolve, 500));
						} else {
							proc = pool.find((p) => !p.attachedSession && p.process.exitCode === null) || spawnRpcProcess();
							if (proc.process.exitCode !== null) {
								proc = spawnRpcProcess();
							}
							await new Promise((resolve) => setTimeout(resolve, 500));
						}

						// Ask pi to create a new session and get the session path
						await sendRpc(proc, { type: "new_session" });
						const stateResp = await sendRpc(proc, { type: "get_state" });
						sessionPath = stateResp.data?.sessionFile;
						if (!sessionPath) throw new Error("Failed to get session path from new session");

						proc.attachedSession = sessionPath;
						proc.eventTarget = ws;
						proc.sessionPath = sessionPath;
						attachedSessions.set(sessionPath, proc);
						sessionStatus.set(sessionPath, "running");
						debugTurn("status_running_set", {
							turnId,
							procId: proc.id,
							sessionPath,
							reason: "new_session",
						});
					} else {
						proc = await acquirePi(sessionPath, ws);
					}

					proc.currentTurnId = turnId;
					debugTurn("prompt_proc_acquired", {
						turnId,
						procId: proc.id,
						sessionPath,
					});

					// Apply model/thinking level if provided
					if (command.model) {
						await sendRpcChecked(proc, {
							type: "set_model",
							provider: command.model.provider,
							modelId: command.model.modelId,
						});
						// Verify model actually changed; otherwise we'd silently continue with
						// the previous model from session context.
						const modelState = await sendRpcChecked(proc, { type: "get_state" });
						const activeModel = modelState.data?.model;
						if (!activeModel || activeModel.provider !== command.model.provider || activeModel.id !== command.model.modelId) {
							throw new Error(`Failed to switch model to ${command.model.provider}/${command.model.modelId}`);
						}
					}
					if (command.thinkingLevel) {
						await sendRpcChecked(proc, { type: "set_thinking_level", level: command.thinkingLevel });
					}

					// Notify client that session is now attached (with resolved path).
					// Include cwd + firstMessage so the client can optimistically
					// show the session in the sidebar before the JSONL scan catches up.
					ws.send(JSON.stringify({
						type: "session_attached",
						sessionPath,
						cwd: command.cwd || PI_CWD,
						firstMessage: command.message,
					}));
					debugTurn("session_attached_sent", {
						turnId,
						procId: proc.id,
						sessionPath,
						wsOpen: ws.readyState === WebSocket.OPEN,
					});

					// Set up agent_end callback to release pi after turn
					proc.onAgentEnd = () => {
						const endedTurnId = proc.currentTurnId;
						debugTurn("on_agent_end_callback", {
							turnId: endedTurnId,
							procId: proc.id,
							sessionPath,
							wsOpen: ws.readyState === WebSocket.OPEN,
						});
						releasePi(proc);
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({ type: "session_detached", sessionPath }));
							debugTurn("session_detached_sent", {
								turnId: endedTurnId,
								procId: proc.id,
								sessionPath,
							});
						}
					};
					debugTurn("on_agent_end_registered", {
						turnId,
						procId: proc.id,
						sessionPath,
					});

					// Send the prompt (returns immediately, events stream async)
					const promptCmd: any = { type: "prompt", message: command.message };
					if (command.images && command.images.length > 0) {
						promptCmd.images = command.images;
					}
					debugTurn("prompt_rpc_send", {
						turnId,
						procId: proc.id,
						sessionPath,
					});
					const response = await sendRpc(proc, promptCmd);
					debugTurn("prompt_rpc_response", {
						turnId,
						procId: proc.id,
						sessionPath,
						success: !!response?.success,
					});
					ws.send(JSON.stringify({ ...response, id, command: "prompt" }));
					break;
				}

				// ── Steer: inject a message while agent is running ───────
				case "steer": {
					const sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");
					const proc = attachedSessions.get(sessionPath);
					if (!proc) throw new Error("Session is not attached (agent not running)");
					// Track in server-side queue
					getSteeringQueue(sessionPath).push(command.message);
					broadcastSteeringQueue(sessionPath);
					await sendRpc(proc, { type: "steer", message: command.message });
					ws.send(JSON.stringify({ id, type: "response", command: "steer", success: true }));
					break;
				}

				// ── Remove a queued steering message by index ──────────
				case "remove_steering": {
					const sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");
					const index = command.index as number;
					if (typeof index !== "number") throw new Error("Missing index");
					const queue = steeringQueues.get(sessionPath);
					if (queue && index >= 0 && index < queue.length) {
						queue.splice(index, 1);
						if (queue.length === 0) steeringQueues.delete(sessionPath);
						broadcastSteeringQueue(sessionPath);
					}
					ws.send(JSON.stringify({ id, type: "response", command: "remove_steering", success: true }));
					break;
				}

				// ── Abort current turn ───────────────────────────────────
				case "abort": {
					const sessionPath = command.sessionPath as string;
					const proc = sessionPath ? attachedSessions.get(sessionPath) : undefined;
					if (proc) {
						await sendRpc(proc, { type: "abort" });
					}
					ws.send(JSON.stringify({ id, type: "response", command: "abort", success: true }));
					break;
				}

				// ── Compact (needs attached pi) ─────────────────────────
				case "compact": {
					const sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");

					const proc = await acquirePi(sessionPath, ws);
					ws.send(JSON.stringify({ type: "session_attached", sessionPath }));

					const response = await sendRpc(proc, {
						type: "compact",
						customInstructions: command.customInstructions,
					});

					releasePi(proc);
					ws.send(JSON.stringify({ type: "session_detached", sessionPath }));
					ws.send(JSON.stringify({ ...response, id, command: "compact" }));
					break;
				}

				// ── Get available models (needs any pi process) ─────────
				case "get_available_models": {
					const proc = await getOrSpawnIdlePi();
					const response = await sendRpc(proc, { type: "get_available_models" });
					ws.send(JSON.stringify({ ...response, id, command: "get_available_models" }));
					break;
				}

				// ── Get default model and thinking level from pi's config ─
				case "get_default_model": {
					const proc = await getOrSpawnIdlePi();
					const stateResp = await sendRpc(proc, { type: "get_state" });
					const model = stateResp.data?.model ?? null;
					const thinkingLevel = stateResp.data?.thinkingLevel ?? "off";
					ws.send(JSON.stringify({
						id, type: "response", command: "get_default_model",
						success: true, data: { model, thinkingLevel },
					}));
					break;
				}

				// ── Get session statuses (no pi needed) ─────────────────
				case "get_session_statuses": {
					ws.send(JSON.stringify({
						id, type: "response", command: "get_session_statuses",
						success: true, data: { statuses: getSessionStatuses() },
					}));
					break;
				}

				// ── Fork session (needs attached pi) ────────────────────
				case "fork": {
					const sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");
					const entryId = command.entryId as string;
					if (!entryId) throw new Error("Missing entryId");

					const proc = await acquirePi(sessionPath, ws);

					const response = await sendRpc(proc, { type: "fork", entryId });

					// After fork, the pi process is now on a new session file.
					// Get the new session path from state.
					const stateResp = await sendRpc(proc, { type: "get_state" });
					const newSessionPath = stateResp.data?.sessionFile;

					releasePi(proc);

					ws.send(JSON.stringify({
						id, type: "response", command: "fork",
						success: true,
						data: {
							text: response.data?.text ?? "",
							cancelled: response.data?.cancelled ?? false,
							newSessionPath: newSessionPath ?? null,
						},
					}));
					break;
				}

				// ── Fork entire session state and prompt in the fork ────
				case "fork_prompt": {
					const sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");
					const message = command.message as string;
					if (!message) throw new Error("Missing message");

					// 1. Copy the JSONL file to create a new session with full history
					const sessionsDir = path.join(getAgentDir(), "sessions");
					const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
					const newId = crypto.randomUUID().slice(0, 8);
					const newFilename = `${timestamp}_${newId}.jsonl`;
					const newSessionPath = path.join(sessionsDir, newFilename);
					await copyFile(sessionPath, newSessionPath);

					// 2. Acquire a pi process and switch to the new session
					const proc = await acquirePi(newSessionPath, ws);

					// 3. Apply model/thinking level if provided
					if (command.model) {
						await sendRpcChecked(proc, {
							type: "set_model",
							provider: command.model.provider,
							modelId: command.model.modelId,
						});
						const modelState = await sendRpcChecked(proc, { type: "get_state" });
						const activeModel = modelState.data?.model;
						if (!activeModel || activeModel.provider !== command.model.provider || activeModel.id !== command.model.modelId) {
							throw new Error(`Failed to switch model to ${command.model.provider}/${command.model.modelId}`);
						}
					}
					if (command.thinkingLevel) {
						await sendRpcChecked(proc, { type: "set_thinking_level", level: command.thinkingLevel });
					}

					// 4. Notify client that session is attached
					ws.send(JSON.stringify({
						type: "session_attached",
						sessionPath: newSessionPath,
						cwd: PI_CWD,
						firstMessage: message,
					}));

					// 5. Set up agent_end callback to release pi after turn
					proc.onAgentEnd = () => {
						releasePi(proc);
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({ type: "session_detached", sessionPath: newSessionPath }));
						}
					};

					// 6. Send the prompt
					const promptCmd2: any = { type: "prompt", message };
					if (command.images && command.images.length > 0) {
						promptCmd2.images = command.images;
					}
					const response2 = await sendRpc(proc, promptCmd2);

					ws.send(JSON.stringify({
						id, type: "response", command: "fork_prompt",
						success: true,
						data: { newSessionPath },
					}));
					break;
				}

				// ── Set session name (needs attached pi) ────────────────
				case "set_session_name": {
					const sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");

					const proc = await acquirePi(sessionPath, ws);
					const response = await sendRpc(proc, { type: "set_session_name", name: command.name });
					releasePi(proc);
					ws.send(JSON.stringify({ ...response, id, command: "set_session_name" }));
					break;
				}

				default:
					ws.send(JSON.stringify({
						id, type: "response", command: command.type, success: false,
						error: `Unknown command: ${command.type}`,
					}));
			}
		} catch (err: any) {
			debugTurn("command_error", {
				commandType: command?.type,
				requestId: id,
				error: err?.message || String(err),
			});
			ws.send(JSON.stringify({
				id, type: "response", command: command.type, success: false, error: err.message,
			}));
		}
	});

	ws.on("close", () => {
		console.log("WebSocket client disconnected");
		if (connectedWs === ws) connectedWs = null;
	});
});

// ============================================================================
// Sessions Directory Watcher
// ============================================================================

const SESSIONS_DIR = path.join(getAgentDir(), "sessions");

function startSessionsWatcher(): FSWatcher | null {
	if (!existsSync(SESSIONS_DIR)) {
		console.log(`Sessions dir does not exist yet: ${SESSIONS_DIR}`);
		return null;
	}

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let lastChangedFile: string | null = null;

	const watcher = watch(SESSIONS_DIR, { recursive: true }, (_event, filename) => {
		if (!filename || !filename.endsWith(".jsonl")) return;

		lastChangedFile = filename;

		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			if (!connectedWs || connectedWs.readyState !== WebSocket.OPEN) return;

			const fullPath = path.join(SESSIONS_DIR, lastChangedFile!);

			connectedWs.send(JSON.stringify({
				type: "sessions_changed",
				file: fullPath,
			}));
		}, 300);
	});

	console.log(`Watching sessions directory: ${SESSIONS_DIR}`);
	return watcher;
}

startSessionsWatcher();

// Eagerly start pi process pool if pi is available
if (PI_AVAILABLE) {
	console.log(`[pool] Starting ${POOL_SIZE} pi processes...`);
	ensurePoolSize();
} else {
	console.log(`[pi] ${makePiNotFoundMessage(PI_LAUNCH.command)}`);
}

server.listen(PORT, () => {
	console.log(`pi-web server listening on http://localhost:${PORT}`);
});

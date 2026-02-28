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
import { unlink, appendFile } from "node:fs/promises";
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
import { completeSimple, getModel } from "@mariozechner/pi-ai";

const PORT = parseInt(process.env.PORT || "18111", 10);
const PI_CWD = process.env.PI_CWD || process.cwd();

const PI_CLI = process.env.PI_CLI || path.resolve(
	fileURLToPath(import.meta.url),
	"../../../../pi-mono/packages/coding-agent/dist/cli.js",
);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ============================================================================
// Auto-Title Generation
// ============================================================================

/** Map from provider to a cheap/fast model suitable for summarization. */
const CHEAP_MODELS: Record<string, { provider: string; modelId: string }> = {
	anthropic: { provider: "anthropic", modelId: "claude-haiku-4-5" },
	openai: { provider: "openai", modelId: "gpt-4o-mini" },
	google: { provider: "google", modelId: "gemini-2.0-flash-lite" },
	"google-vertex": { provider: "google-vertex", modelId: "gemini-2.0-flash-lite" },
	"google-gemini-cli": { provider: "google", modelId: "gemini-2.0-flash-lite" },
	"google-antigravity": { provider: "google", modelId: "gemini-2.0-flash-lite" },
	xai: { provider: "xai", modelId: "grok-2" },
	groq: { provider: "groq", modelId: "gemma2-9b-it" },
	"amazon-bedrock": { provider: "amazon-bedrock", modelId: "anthropic.claude-haiku-4-5-20251001-v1:0" },
	openrouter: { provider: "openrouter", modelId: "anthropic/claude-haiku-4-5" },
};

/**
 * After a turn ends, generate or update the session title.
 * Uses a cheap model from the same provider the session is already using.
 * If a title already exists, it's provided to the model with instructions
 * to keep it unless the conversation's trajectory has changed significantly.
 * Appends a session_info entry to the JSONL and notifies the WS client.
 */
async function autoTitleSession(sessionPath: string, ws: WebSocket | null): Promise<void> {
	try {
		if (!existsSync(sessionPath)) return;

		const content = readFileSync(sessionPath, "utf8");
		const entries = parseSessionEntries(content);

		// Find existing name (latest session_info with a name)
		let currentName: string | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			if ((entries[i] as any).type === "session_info" && (entries[i] as any).name) {
				currentName = (entries[i] as any).name;
				break;
			}
		}

		const context = buildSessionContext(entries as any);
		if (!context.messages || context.messages.length === 0) return;

		// Find the provider from the session's model_change entries
		let provider: string | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as any;
			if (entry.type === "model_change" && entry.provider) {
				provider = entry.provider;
				break;
			}
		}
		if (!provider) return;

		// Resolve cheap model
		const cheapSpec = CHEAP_MODELS[provider];
		if (!cheapSpec) {
			console.log(`[auto-title] No cheap model mapping for provider "${provider}", skipping`);
			return;
		}

		const model = getModel(cheapSpec.provider as any, cheapSpec.modelId as any);
		if (!model) {
			console.log(`[auto-title] Model ${cheapSpec.provider}/${cheapSpec.modelId} not found, skipping`);
			return;
		}

		// Build a condensed transcript: only user and assistant text messages (skip tool calls/results)
		const transcript: string[] = [];
		for (const msg of context.messages) {
			if (msg.role === "user") {
				const text = typeof msg.content === "string"
					? msg.content
					: msg.content.filter((c) => c.type === "text").map((c) => (c as any).text).join(" ");
				if (text) transcript.push(`User: ${text}`);
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text")
					.map((c) => (c as any).text)
					.join(" ");
				if (text) transcript.push(`Assistant: ${text}`);
			}
		}

		if (transcript.length === 0) return;

		// Truncate to avoid sending too much to the cheap model
		const truncated = transcript.join("\n").slice(0, 4000);

		console.log(`[auto-title] Generating title for ${path.basename(sessionPath)} via ${cheapSpec.provider}/${cheapSpec.modelId}${currentName ? ` (current: "${currentName}")` : ""}...`);

		// Build the prompt: if there's an existing name, instruct the model to keep it unless trajectory changed
		let userPrompt: string;
		if (currentName) {
			userPrompt = `The current title of this conversation is: "${currentName}"\n\nSummarize this conversation in 12 words or less. If the current title still accurately describes the conversation, respond with the EXACT same title. Only change it if the conversation's trajectory has shifted significantly.\n\n${truncated}`;
		} else {
			userPrompt = `Summarize this conversation in 12 words or less. Be specific and descriptive about what was discussed or accomplished.\n\n${truncated}`;
		}

		const result = await completeSimple(model, {
			systemPrompt: "You are a helpful assistant that summarizes conversations. Respond with ONLY the summary, nothing else. No quotes, no punctuation at the end, no prefixes.\n\nGood examples:\n- Added a prompt summarization feature\n- Debugging issue with input\n\nBad examples:\n- The user asked to debug an issue with input.\n- We discussed adding a prompt summarization feature to the system.",
			messages: [
				{
					role: "user",
					content: userPrompt,
					timestamp: Date.now(),
				},
			],
		}, {
			maxTokens: 30,
			temperature: 0,
		});

		// Extract text from the response
		const title = result.content
			.filter((c) => c.type === "text")
			.map((c) => (c as any).text)
			.join("")
			.trim()
			.replace(/^["']|["']$/g, "")  // strip wrapping quotes
			.replace(/\.+$/, "");           // strip trailing periods

		if (!title || title.length === 0) return;

		// Skip writing if the title hasn't changed
		if (currentName && title === currentName) {
			console.log(`[auto-title] Title unchanged: "${title}"`);
			return;
		}

		console.log(`[auto-title] ${currentName ? "Updated" : "Generated"}: "${title}"`);

		// Generate a unique ID for the entry
		const id = Math.random().toString(36).slice(2, 10);

		// Find the last entry's id to use as parentId
		let parentId: string | null = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			if ((entries[i] as any).id) {
				parentId = (entries[i] as any).id;
				break;
			}
		}

		// Append session_info entry to the JSONL file
		const infoEntry = {
			type: "session_info",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			name: title,
		};

		await appendFile(sessionPath, "\n" + JSON.stringify(infoEntry) + "\n");

		// Notify the connected WS client about the title update
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({
				type: "session_auto_titled",
				sessionPath,
				title,
			}));
		}
	} catch (err: any) {
		console.error(`[auto-title] Failed for ${path.basename(sessionPath)}: ${err.message}`);
	}
}

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
		const result = sessions.map((s) => ({
			id: s.id,
			path: s.path,
			cwd: s.cwd,
			name: s.name,
			created: s.created.toISOString(),
			modified: s.modified.toISOString(),
			messageCount: s.messageCount,
			firstMessage: s.firstMessage,
		}));
		res.json(result);
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

app.delete("/api/sessions", express.json(), async (req, res) => {
	try {
		const { path: sessionPath } = req.body;
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
}

const POOL_SIZE = 3;
let nextProcId = 0;
const pool: RpcProcess[] = [];
/** Map from session path → attached RPC process */
const attachedSessions = new Map<string, RpcProcess>();

function spawnRpcProcess(cwd?: string): RpcProcess {
	const procId = ++nextProcId;
	const useCwd = cwd || PI_CWD;
	console.log(`[pool] Spawning pi process #${procId} (cwd: ${useCwd})...`);

	const child = spawn("node", [PI_CLI, "--mode", "rpc"], {
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
	};

	child.on("exit", (code) => {
		console.log(`[pool] pi#${proc.id} exited (code ${code})`);
		// Remove from pool and attached map
		const idx = pool.indexOf(proc);
		if (idx !== -1) pool.splice(idx, 1);
		if (proc.attachedSession) {
			attachedSessions.delete(proc.attachedSession);
		}
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

		// Detect agent_end to auto-release the process
		if (data.type === "agent_end" && proc.onAgentEnd) {
			const cb = proc.onAgentEnd;
			proc.onAgentEnd = null;
			cb();
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

	await sendRpc(proc, { type: "switch_session", sessionPath });

	console.log(`[pool] pi#${proc.id} attached to ${path.basename(sessionPath)}`);
	return proc;
}

/**
 * Release a pi process back to the pool after a turn completes.
 */
function releasePi(proc: RpcProcess) {
	const sessionPath = proc.attachedSession;
	console.log(`[pool] pi#${proc.id} released from ${sessionPath ? path.basename(sessionPath) : "?"}`);
	if (sessionPath) {
		attachedSessions.delete(sessionPath);
	}
	proc.attachedSession = null;
	proc.eventTarget = null;
	proc.sessionPath = null;
	// Replenish pool if a process died while attached
	ensurePoolSize();
}

/**
 * Ensure the pool has at least POOL_SIZE live processes.
 * Spawns new ones if needed (non-blocking).
 */
function ensurePoolSize() {
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
 * Get the list of currently attached session paths.
 */
function getAttachedSessions(): string[] {
	return Array.from(attachedSessions.keys());
}

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

	// Send initial state: which sessions are attached
	ws.send(JSON.stringify({
		type: "init",
		attachedSessions: getAttachedSessions(),
	}));

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
			switch (command.type) {
				// ── Prompt: attach pi, run one turn ──────────────────────
				case "prompt": {
					let sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");

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
					} else {
						proc = await acquirePi(sessionPath, ws);
					}

					// Apply model/thinking level if provided
					if (command.model) {
						await sendRpc(proc, {
							type: "set_model",
							provider: command.model.provider,
							modelId: command.model.modelId,
						});
					}
					if (command.thinkingLevel) {
						await sendRpc(proc, { type: "set_thinking_level", level: command.thinkingLevel });
					}

					// Notify client that session is now attached (with resolved path)
					ws.send(JSON.stringify({ type: "session_attached", sessionPath }));

					// Set up agent_end callback to release pi after turn
					proc.onAgentEnd = () => {
						releasePi(proc);
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({ type: "session_detached", sessionPath }));
						}
						// Auto-generate a title for untitled sessions (fire-and-forget)
						autoTitleSession(sessionPath, ws);
					};

					// Send the prompt (returns immediately, events stream async)
					const response = await sendRpc(proc, { type: "prompt", message: command.message });
					ws.send(JSON.stringify({ ...response, id, command: "prompt" }));
					break;
				}

				// ── Steer: inject a message while agent is running ───────
				case "steer": {
					const sessionPath = command.sessionPath as string;
					if (!sessionPath) throw new Error("Missing sessionPath");
					const proc = attachedSessions.get(sessionPath);
					if (!proc) throw new Error("Session is not attached (agent not running)");
					await sendRpc(proc, { type: "steer", message: command.message });
					ws.send(JSON.stringify({ id, type: "response", command: "steer", success: true }));
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

// Eagerly start pi process pool
console.log(`[pool] Starting ${POOL_SIZE} pi processes...`);
ensurePoolSize();

server.listen(PORT, () => {
	console.log(`pi-web server listening on http://localhost:${PORT}`);
});

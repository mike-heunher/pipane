/**
 * pi-web backend server.
 *
 * Spawns pi coding agent in RPC mode and relays commands/events
 * between WebSocket clients and the RPC process.
 */

import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const PORT = parseInt(process.env.PORT || "18111", 10);
const PI_CWD = process.env.PI_CWD || process.cwd();

// Resolve the pi CLI entry point
const PI_CLI = process.env.PI_CLI || path.resolve(
	fileURLToPath(import.meta.url),
	"../../../../pi-mono/packages/coding-agent/dist/cli.js"
);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Serve static files in production
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../client");
app.use(express.static(clientDist));

// ============================================================================
// REST API: Session listing
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

// ============================================================================
// RPC Process Management
// ============================================================================

interface RpcProcess {
	process: ChildProcess;
	rl: readline.Interface;
	pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>;
	requestId: number;
}

let rpcProc: RpcProcess | null = null;
let connectedWs: WebSocket | null = null;

function startRpcProcess(): RpcProcess {
	console.log(`Starting pi coding agent in RPC mode...`);
	console.log(`  CLI: ${PI_CLI}`);
	console.log(`  CWD: ${PI_CWD}`);

	const child = spawn("node", [PI_CLI, "--mode", "rpc"], {
		cwd: PI_CWD,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	});

	child.stderr?.on("data", (data: Buffer) => {
		process.stderr.write(`[pi] ${data.toString()}`);
	});

	child.on("exit", (code) => {
		console.log(`pi agent exited with code ${code}`);
		rpcProc = null;
	});

	const rl = readline.createInterface({
		input: child.stdout!,
		terminal: false,
	});

	const proc: RpcProcess = {
		process: child,
		rl,
		pendingRequests: new Map(),
		requestId: 0,
	};

	rl.on("line", (line: string) => {
		let data: any;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}

		// Check if it's a response to a pending request
		if (data.type === "response" && data.id && proc.pendingRequests.has(data.id)) {
			const pending = proc.pendingRequests.get(data.id)!;
			proc.pendingRequests.delete(data.id);
			pending.resolve(data);
			return;
		}

		// Otherwise it's an agent event — forward to connected WS client
		if (connectedWs && connectedWs.readyState === WebSocket.OPEN) {
			connectedWs.send(JSON.stringify(data));
		}
	});

	console.log("pi coding agent started.");
	return proc;
}

function sendRpcCommand(command: any): Promise<any> {
	if (!rpcProc) throw new Error("RPC process not running");

	const id = `req_${++rpcProc.requestId}`;
	const fullCommand = { ...command, id };

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			rpcProc?.pendingRequests.delete(id);
			reject(new Error(`Timeout waiting for RPC response to ${command.type}`));
		}, 30000);

		rpcProc!.pendingRequests.set(id, {
			resolve: (data: any) => {
				clearTimeout(timeout);
				resolve(data);
			},
			reject: (err: Error) => {
				clearTimeout(timeout);
				reject(err);
			},
		});

		rpcProc!.process.stdin!.write(JSON.stringify(fullCommand) + "\n");
	});
}

// ============================================================================
// Slash Command → RPC Mapping
// ============================================================================

/**
 * Map TUI-only slash commands to RPC equivalents.
 * Returns an RPC command object, or a direct response for client-only commands.
 * Returns null if the text is not a known slash command (pass through to RPC prompt).
 */
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

		// /new and /compact are handled client-side (need state refresh)

		case "name":
			if (args) return { rpc: { type: "set_session_name", name: args } };
			return { rpc: { type: "get_state" } }; // return current state (includes name)

		case "export":
			return { rpc: { type: "export_html", outputPath: args || undefined } };

		case "debug":
			return { rpc: { type: "get_session_stats" } };

		case "resume":
			// No direct RPC equivalent — client handles session switching
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
			// Check for /model:provider/id shorthand
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

			// /model with optional search — get available models
			if (cmd === "model") {
				return { rpc: { type: "get_available_models" } };
			}

			return null; // Not a known built-in — let RPC prompt handle it
	}
}

// ============================================================================
// WebSocket Handler
// ============================================================================

wss.on("connection", async (ws) => {
	console.log("WebSocket client connected");

	// Single-user: only one connection at a time
	if (connectedWs && connectedWs.readyState === WebSocket.OPEN) {
		connectedWs.close(1000, "Replaced by new connection");
	}
	connectedWs = ws;

	// Ensure RPC process is running
	if (!rpcProc) {
		try {
			rpcProc = startRpcProcess();
			// Wait for process to initialize
			await new Promise((resolve) => setTimeout(resolve, 500));
		} catch (err: any) {
			ws.send(JSON.stringify({
				type: "response",
				command: "connect",
				success: false,
				error: `Failed to start pi agent: ${err.message}`,
			}));
			ws.close();
			return;
		}
	}

	ws.on("message", async (raw) => {
		let command: any;
		try {
			command = JSON.parse(raw.toString());
		} catch {
			ws.send(JSON.stringify({
				type: "response",
				command: "parse",
				success: false,
				error: "Invalid JSON",
			}));
			return;
		}

		const id = command.id;

		try {
			// For prompt_message, extract text and check for slash commands
			if (command.type === "prompt_message") {
				const msg = command.message;
				const text = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
						: "";

				// Check if it's a slash command we need to intercept
				const mapped = mapSlashCommand(text);
				if (mapped) {
					if ("response" in mapped) {
						// Client-only command — emit as assistant message sequence
						const msg = {
							role: "assistant",
							content: [{ type: "text", text: mapped.response.data.message }],
							timestamp: Date.now(),
						};
						ws.send(JSON.stringify({ type: "agent_start" }));
						ws.send(JSON.stringify({ type: "message_start", message: msg }));
						ws.send(JSON.stringify({ type: "message_end", message: msg }));
						ws.send(JSON.stringify({ type: "agent_end", messages: [] }));
						return;
					}
					// Map to RPC command
					const response = await sendRpcCommand(mapped.rpc);
					ws.send(JSON.stringify({ ...response, id, command: "prompt_message" }));
					return;
				}

				const response = await sendRpcCommand({ type: "prompt", message: text });
				ws.send(JSON.stringify({ ...response, id, command: "prompt_message" }));
				return;
			}

			// Forward all other commands directly to RPC
			const response = await sendRpcCommand(command);
			// Override the id with the WS request id
			ws.send(JSON.stringify({ ...response, id }));
		} catch (err: any) {
			ws.send(JSON.stringify({
				id,
				type: "response",
				command: command.type,
				success: false,
				error: err.message,
			}));
		}
	});

	ws.on("close", () => {
		console.log("WebSocket client disconnected");
		if (connectedWs === ws) {
			connectedWs = null;
		}
	});
});

server.listen(PORT, () => {
	console.log(`pi-web server listening on http://localhost:${PORT}`);
});

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

const PORT = parseInt(process.env.PORT || "3001", 10);
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
			// For prompt_message, extract text content
			if (command.type === "prompt_message") {
				const msg = command.message;
				const text = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
						: "";
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

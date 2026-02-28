/**
 * pi-web backend server.
 *
 * Architecture: sessions are either "detached" (read from JSONL on disk)
 * or "attached" (a pi RPC process is running a turn for them).
 *
 * A CWD-aware pool of pi RPC processes is maintained. When a user sends
 * a message, a process matching the session's project directory is acquired,
 * switched to that session, and runs one turn. After the turn completes,
 * the process is released back to the pool.
 *
 * Session lifecycle is managed by SessionLifecycle (single source of truth
 * for session→process mappings and status). Process spawning and pooling
 * is handled by ProcessPool. The WsHandler routes WebSocket commands to
 * these modules.
 */

import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { resolvePiLaunch } from "./pi-launch.js";
import { checkCommandAvailable, makePiNotFoundMessage } from "./pi-runtime.js";
import { registerRestApi } from "./rest-api.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { ProcessPool } from "./process-pool.js";
import { WsHandler } from "./ws-handler.js";

const PORT = parseInt(process.env.PORT || "18111", 10);
const PI_CWD = process.env.PI_CWD || process.cwd();
const PI_CLI = process.env.PI_CLI;
const PI_LAUNCH = resolvePiLaunch(PI_CLI);
const PI_AVAILABLE = checkCommandAvailable(PI_LAUNCH.command);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Express + HTTP server
// ============================================================================

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Serve static files in production
const clientDist = path.resolve(__dirname, "../client");
app.use(express.static(clientDist));

// Register REST endpoints
registerRestApi(app);

// ============================================================================
// Core modules
// ============================================================================

const lifecycle = new SessionLifecycle();

// Resolve canvas extension path relative to project root
const canvasExtension = path.resolve(__dirname, "../../extensions/canvas.ts");

const pool = new ProcessPool(
	{
		command: PI_LAUNCH.command,
		baseArgs: [...PI_LAUNCH.baseArgs, "--mode", "rpc", "-e", canvasExtension],
	},
	{
		maxProcesses: 6,
		prewarmCount: 2,
		onProcessExit: (proc) => {
			// If the process was attached to a session, handle the crash
			const sessionPath = lifecycle.getAttachedSessionForProcess(proc);
			if (sessionPath) {
				console.log(`[pool] pi#${proc.id} crashed while attached to ${path.basename(sessionPath)} — marking done`);
				lifecycle.crash(sessionPath);
			}
			// Replenish the pool for the default cwd
			if (PI_AVAILABLE) {
				pool.prewarm(PI_CWD);
			}
		},
	},
);

const wsHandler = new WsHandler({
	lifecycle,
	pool,
	defaultCwd: PI_CWD,
	piLaunch: PI_LAUNCH,
	ensurePool: () => {
		if (wsHandler.isPiAvailable) {
			pool.prewarm(PI_CWD);
		}
	},
});

// Register WS handler
wsHandler.register(wss);

// ============================================================================
// Debug endpoints
// ============================================================================

app.get("/api/debug/pool", (_req, res) => {
	try {
		res.json(wsHandler.getDebugState());
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
        <th>proc</th><th>pid</th><th>alive</th><th>cwd</th><th>busy</th><th>attachedSession</th><th>pendingRequests</th><th>exitCode</th>
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
    'now=' + d.now + ' total=' + d.totalProcesses + ' attached=' + d.attachedSessionCount + ' wsOpen=' + d.connectedWsOpen;
  const rows = (d.processes || []).map(p =>
    '<tr><td>' + p.id + '</td><td>' + (p.pid ?? '') + '</td><td class="' + (p.alive ? 'ok':'bad') + '">' + p.alive + '</td><td>' + (p.cwd || '') + '</td><td>' + p.busy + '</td><td>' + (p.attachedSession ?? '') + '</td><td>' + p.pendingRequests + '</td><td>' + (p.exitCode ?? '') + '</td></tr>'
  ).join('');
  document.getElementById('rows').innerHTML = rows;
  document.getElementById('raw').textContent = JSON.stringify({ sessionStatuses: d.sessionStatuses }, null, 2);
}
setInterval(tick, 1000); tick();
</script>
</body>
</html>`);
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
			// Get the connected WS from the debug state (not ideal but avoids exposing internals)
			const debug = wsHandler.getDebugState();
			if (!debug.connectedWsOpen) return;

			const fullPath = path.join(SESSIONS_DIR, lastChangedFile!);

			// We need to access the WS — let's expose a broadcast method on the handler
			wss.clients.forEach((client) => {
				if (client.readyState === WebSocket.OPEN) {
					client.send(JSON.stringify({
						type: "sessions_changed",
						file: fullPath,
					}));
				}
			});
		}, 300);
	});

	console.log(`Watching sessions directory: ${SESSIONS_DIR}`);
	return watcher;
}

startSessionsWatcher();

// ============================================================================
// Startup
// ============================================================================

if (PI_AVAILABLE) {
	console.log(`[pool] Pre-warming process pool for ${PI_CWD}...`);
	pool.prewarm(PI_CWD);
} else {
	console.log(`[pi] ${makePiNotFoundMessage(PI_LAUNCH.command)}`);
}

server.listen(PORT, () => {
	console.log(`pi-web server listening on http://localhost:${PORT}`);
});

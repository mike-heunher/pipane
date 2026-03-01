/**
 * pipane backend server.
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

import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { resolvePiLaunch } from "./pi-launch.js";
import { checkCommandAvailable, makePiNotFoundMessage } from "./pi-runtime.js";
import { registerRestApi } from "./rest-api.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { ProcessPool } from "./process-pool.js";
import { WsHandler } from "./ws-handler.js";
import { LoadTraceStore } from "./load-trace-store.js";
import { LocalSettingsStore } from "./local-settings.js";

const DEFAULT_PORT = process.env.NODE_ENV === "production" ? "8222" : "18111";
const PORT = parseInt(process.env.PORT || DEFAULT_PORT, 10);
const PI_CWD = process.env.PI_CWD || process.cwd();

// Quiet mode: only show URLs unless --verbose or PIPANE_VERBOSE=1
const VERBOSE = process.argv.includes("--verbose") || process.env.PIPANE_VERBOSE === "1";
if (!VERBOSE) {
	const origLog = console.log;
	const origError = console.error;
	const origWarn = console.warn;
	// Suppress all console output; we'll use _log for the few lines we want
	console.log = () => {};
	console.error = () => {};
	console.warn = () => {};
	(globalThis as any)._pipaneLog = origLog;
} else {
	(globalThis as any)._pipaneLog = console.log;
}
/** Always prints, even in quiet mode */
function log(...args: any[]) {
	(globalThis as any)._pipaneLog(...args);
}
const PI_CLI = process.env.PI_CLI;
const PI_LAUNCH = resolvePiLaunch(PI_CLI);
const PI_AVAILABLE = checkCommandAvailable(PI_LAUNCH.command);
const PI_MAX_PROCESSES = parseInt(process.env.PI_MAX_PROCESSES || "24", 10);
const PI_PREWARM_COUNT = parseInt(process.env.PI_PREWARM_COUNT || "2", 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUTH_COOKIE_NAME = "pipane_auth";
const AUTH_TOKEN = process.env.PIPANE_AUTH_TOKEN || randomBytes(24).toString("base64url");
const PUBLIC_HOSTNAME = process.env.PI_PUBLIC_HOSTNAME || hostname();
const AUTH_URL = `http://${PUBLIC_HOSTNAME}:${PORT}/auth?token=${encodeURIComponent(AUTH_TOKEN)}`;

function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		out[k] = decodeURIComponent(v);
	}
	return out;
}

function isLocalAddress(addr: string | undefined | null): boolean {
	if (!addr) return false;
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function isLocalRequest(req: Pick<IncomingMessage, "socket">): boolean {
	if (process.env.PIPANE_DISABLE_LOCAL_BYPASS === "1") return false;
	return isLocalAddress(req.socket.remoteAddress);
}

function setAuthCookie(res: Response): void {
	const secure = process.env.PIPANE_SECURE_COOKIE === "1" ? "; Secure" : "";
	const maxAgeSeconds = 60 * 60 * 24 * 30;
	res.setHeader("Set-Cookie", `${AUTH_COOKIE_NAME}=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

function isAuthorizedRequest(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
	if (isLocalRequest(req)) return true;
	const cookies = parseCookies(req.headers.cookie);
	return cookies[AUTH_COOKIE_NAME] === AUTH_TOKEN;
}

// ============================================================================
// Express + HTTP server
// ============================================================================

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ── WebSocket keep-alive via ping/pong ────────────────────────────────
// Ping all connected clients every 30s. If a client doesn't respond with
// a pong within the interval, the connection is considered dead and terminated.
// This prevents silent disconnects (e.g. from network changes, sleep, etc.)
// from leaving zombie connections on the server side, and ensures the client's
// onclose handler fires so auto-reconnect kicks in.
const WS_PING_INTERVAL = 30_000;
const wsAliveMap = new WeakMap<import("ws").WebSocket, boolean>();

wss.on("connection", (ws) => {
	wsAliveMap.set(ws, true);
	ws.on("pong", () => { wsAliveMap.set(ws, true); });
});

const pingInterval = setInterval(() => {
	for (const ws of wss.clients) {
		if (wsAliveMap.get(ws) === false) {
			// Didn't respond to last ping — terminate
			ws.terminate();
			continue;
		}
		wsAliveMap.set(ws, false);
		ws.ping();
	}
}, WS_PING_INTERVAL);

wss.on("close", () => { clearInterval(pingInterval); });

app.get("/auth", (req: Request, res: Response) => {
	const token = typeof req.query.token === "string" ? req.query.token : undefined;
	if (isLocalRequest(req) || token === AUTH_TOKEN) {
		setAuthCookie(res);
		res.redirect("/");
		return;
	}
	res.status(401).type("html").send("<h3>Unauthorized</h3><p>Invalid auth token.</p>");
});

app.use((req: Request, res: Response, next: NextFunction) => {
	if (isAuthorizedRequest(req)) {
		if (isLocalRequest(req)) {
			setAuthCookie(res);
		}
		next();
		return;
	}
	res.status(401).type("html").send("<h3>Unauthorized</h3><p>Open the one-time auth URL shown in the pipane terminal.</p>");
});

const traceStore = new LoadTraceStore();
const localSettingsStore = new LocalSettingsStore();

app.use((req: Request, res: Response, next: NextFunction) => {
	const traceId = typeof req.headers["x-pi-trace-id"] === "string" ? req.headers["x-pi-trace-id"] : "";
	if (!traceId) {
		next();
		return;
	}
	const start = performance.now();
	res.on("finish", () => {
		traceStore.record(traceId, {
			ts: new Date().toISOString(),
			source: "backend",
			kind: "span",
			name: `http ${req.method} ${req.path}`,
			durationMs: Number((performance.now() - start).toFixed(2)),
			attrs: {
				statusCode: res.statusCode,
			},
		});
	});
	next();
});

// Serve static files in production
const clientDist = path.resolve(__dirname, "../../client");
app.use(express.static(clientDist));

// Register REST endpoints
registerRestApi(app, {
	traceStore,
	localSettingsStore,
	onLocalSettingsReloaded: () => {
		wss.clients.forEach((client) => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify({
					type: "sessions_changed",
					file: "__local_settings__",
				}));
			}
		});
	},
});

// ============================================================================
// Core modules
// ============================================================================

const lifecycle = new SessionLifecycle();

// Resolve canvas extension path relative to project root
const canvasExtension = path.resolve(__dirname, "../../../extensions/canvas.ts");

const pool = new ProcessPool(
	{
		command: PI_LAUNCH.command,
		baseArgs: () => {
			const args = [...PI_LAUNCH.baseArgs, "--mode", "rpc"];
			if (localSettingsStore.canvasEnabled) {
				args.push("-e", canvasExtension);
			}
			return args;
		},
	},
	{
		maxProcesses: PI_MAX_PROCESSES,
		prewarmCount: PI_PREWARM_COUNT,
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
	isRequestAuthorized: (req) => isAuthorizedRequest(req),
	traceStore,
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
  <title>pipane pool debug</title>
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
  <h3>pipane pool debug</h3>
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
			const fullPath = path.join(SESSIONS_DIR, lastChangedFile!);

			// Notify the message cache — it will re-read from disk if changed
			// and push session_messages to the subscribed client if needed.
			wsHandler.notifySessionFileChanged(fullPath);

			// Also notify all WS clients about the file change (for sidebar refresh)
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
	log("");
	log("        _                        ");
	log("  _ __ (_)_ __   __ _ _ __   ___ ");
	log(" | '_ \\| | '_ \\ / _` | '_ \\ / _ \\");
	log(" | |_) | | |_) | (_| | | | |  __/");
	log(" | .__/|_| .__/ \\__,_|_| |_|\\___|");
	log(" |_|     |_|                      ");
	log("");
	log(`  Local:  http://localhost:${PORT}`);
	log(`  Remote: ${AUTH_URL}`);
	if (!process.env.PIPANE_AUTH_TOKEN) {
		log(`\n  Auth token is random and changes on restart.`);
		log(`  Set PIPANE_AUTH_TOKEN to use a fixed token.`);
	}
	log("");
});

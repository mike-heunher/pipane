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
 * Each session is owned by a serialized SessionActor registered in
 * SessionRegistry. ProcessPool owns exclusive process leases, and WsHandler
 * only routes transport commands and publishes actor state.
 */

import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { WebSocketServer } from "ws";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WS_PROTOCOL_VERSION } from "../shared/ws-protocol.js";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import { resolvePiLaunch } from "./pi-launch.js";
import { checkCommandAvailable, makePiNotFoundMessage } from "./pi-runtime.js";
import { registerRestApi } from "./rest-api.js";
import { SessionRegistry } from "./session-registry.js";
import { ProcessPool } from "./process-pool.js";
import { WsHandler } from "./ws-handler.js";
import { LocalSettingsStore } from "./local-settings.js";
import { resolveUsageExtensionPath } from "./bundled-extensions.js";
import { UpdateManager } from "./update-manager.js";
import { isDevelopmentCommit } from "./build-info.js";
import { registerUpdateApi } from "./update-api.js";
import { SessionPathGuard } from "./session-path.js";
import { AuthGuard } from "./auth-guard.js";
import { loadOrCreateBackendIdentity } from "./backend-identity.js";
import { BackendRendezvousClient } from "./rendezvous-client.js";
import { BackendWebRtcManager } from "./backend-webrtc.js";
import { BackendTrustStore } from "./backend-trust-store.js";
import { BackendConnectionAuthorizer } from "./backend-connection-authorizer.js";
import { DataChannelFrameConnection } from "./frame-connection.js";
import { routeFrameConnection } from "./frame-router.js";
import { BackendProtocolHandler } from "./backend-protocol-handler.js";
import { LocalBackendApi } from "./local-backend-api.js";
import { resolveBackendName, resolveRendezvousUrl } from "./backend-registration-config.js";
import qrcode from "qrcode-terminal";

const DEFAULT_PORT = process.env.NODE_ENV === "production" ? "8222" : "18111";
const REQUESTED_PORT = parseInt(process.env.PORT || DEFAULT_PORT, 10);
const INSTANCE_ID = process.env.PIPANE_INSTANCE_ID || null;
const PI_CWD = process.env.PI_CWD || process.cwd();

// Quiet mode: only show URLs unless --verbose or PIPANE_VERBOSE=1
const VERBOSE = process.argv.includes("--verbose") || process.env.PIPANE_VERBOSE === "1";
if (!VERBOSE) {
	const origLog = console.log;
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
const USAGE_EXTENSION_ENABLED = process.env.PIPANE_USAGE_EXTENSION !== "0";
const RENDEZVOUS_URL = resolveRendezvousUrl(process.env.PIPANE_RENDEZVOUS_URL);
let rendezvousPairingRuntime: { createPairingUrl(): Promise<string> } | undefined;
let registeredBackendId: string | undefined;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read own version from package.json
const PKG_JSON_PATH = path.resolve(__dirname, "../../../package.json");
const PKG_VERSION: string = (() => {
	try {
		return JSON.parse(readFileSync(PKG_JSON_PATH, "utf-8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
})();
const PKG_NAME = "pipane";
const IS_DEVELOPMENT_COMMIT = process.env.NODE_ENV !== "production"
	|| isDevelopmentCommit(path.resolve(path.dirname(PKG_JSON_PATH), "dist/build-info.json"), PKG_VERSION);

async function startRendezvousRegistration(): Promise<void> {
	if (!RENDEZVOUS_URL) return;
	const identity = loadOrCreateBackendIdentity(process.env.PIPANE_BACKEND_IDENTITY_FILE);
	const trustStore = new BackendTrustStore({ filePath: process.env.PIPANE_BACKEND_TRUST_FILE });
	registeredBackendId = identity.backendId;
	const client = new BackendRendezvousClient({
		url: RENDEZVOUS_URL,
		identity,
		metadata: {
			name: resolveBackendName(process.env.PIPANE_BACKEND_NAME, hostname()),
			softwareVersion: PKG_VERSION,
			protocolVersions: [WS_PROTOCOL_VERSION, BACKEND_PROTOCOL_VERSION],
		},
	});
	client.onError((error) => {
		console.warn("[rendezvous]", error instanceof Error ? error.message : error.message);
	});
	let peers: BackendWebRtcManager | undefined;
	client.onAuthorizationRevoked(({ accountId, deviceId }) => {
		trustStore.applyRevocation(accountId, deviceId);
		peers?.closeAuthorization(accountId, deviceId);
	});
	const backendId = await client.start();
	const authorizer = new BackendConnectionAuthorizer(trustStore, client);
	peers = new BackendWebRtcManager({
		signaling: client,
		identity,
		ticketPublicKey: () => client.ticketPublicKey,
		authorize: (context) => authorizer.authorize(context),
		iceTransportPolicy: process.env.PIPANE_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all",
	});
	peers.onDataChannel(({ channel, deviceId }) => {
		const routes = routeFrameConnection(new DataChannelFrameConnection(channel));
		wsHandler.acceptAuthenticatedConnection(routes.application);
		backendProtocolHandler.accept(routes.semantic, deviceId);
	});
	peers.onError((_connectionId, error) => console.warn("[webrtc]", error.message));

	const appUrl = new URL(process.env.PIPANE_APP_URL || RENDEZVOUS_URL);
	if (appUrl.protocol === "ws:") appUrl.protocol = "http:";
	if (appUrl.protocol === "wss:") appUrl.protocol = "https:";
	appUrl.pathname = `/backend/${backendId}`;
	appUrl.search = "";
	appUrl.hash = "";
	log(`  Backend: ${backendId}`);
	log(`  Web:     ${appUrl.toString()}`);

	const createPairingUrl = async (): Promise<string> => {
		const pairing = trustStore.createPairing();
		await client.openPairing(pairing.pairId, pairing.expiresAt);
		const pairingUrl = new URL(appUrl);
		pairingUrl.pathname = `/pair/${encodeURIComponent(pairing.pairId)}`;
		pairingUrl.hash = new URLSearchParams({ backend: backendId, secret: pairing.secret }).toString();
		return pairingUrl.toString();
	};
	rendezvousPairingRuntime = { createPairingUrl };
	for (const pairing of trustStore.listActivePairings()) {
		void client.openPairing(pairing.pairId, pairing.expiresAt).catch((error) => console.warn("[pairing]", error.message));
	}
	if (!trustStore.ownerAccountId || process.argv.includes("--pair")) {
		const pairingUrl = await createPairingUrl();
		log(`  Pair:    ${pairingUrl}`);
		qrcode.generate(pairingUrl, { small: true }, (code) => log(code));
	}
}

const AUTH_TOKEN = process.env.PIPANE_AUTH_TOKEN || randomBytes(24).toString("base64url");
const PUBLIC_HOSTNAME = process.env.PI_PUBLIC_HOSTNAME || hostname();
const authGuard = new AuthGuard({
	token: AUTH_TOKEN,
	disableLocalBypass: process.env.PIPANE_DISABLE_LOCAL_BYPASS === "1",
	secureCookie: process.env.PIPANE_SECURE_COOKIE === "1",
});

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

authGuard.register(app);

// A harness can provide a unique ID and verify that it reached the child it
// launched, rather than an unrelated process that happened to acquire a port.
app.get("/api/debug/health", (_req, res) => {
	res.json({ ok: true, instanceId: INSTANCE_ID, pid: process.pid });
});
app.post("/api/pairing", async (_req, res) => {
	res.setHeader("Cache-Control", "no-store");
	if (!rendezvousPairingRuntime) {
		res.status(503).json({ error: "Backend is not registered with rendezvous" });
		return;
	}
	try {
		res.json({ url: await rendezvousPairingRuntime.createPairingUrl() });
	} catch (error) {
		res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
	}
});

const localSettingsStore = new LocalSettingsStore();
const registry = new SessionRegistry();
const SESSIONS_DIR = path.join(getAgentDir(), "sessions");
const sessionPaths = new SessionPathGuard(SESSIONS_DIR);

// Serve static files in production
const clientDist = path.resolve(__dirname, "../../client");
app.use(express.static(clientDist));

// ============================================================================
// Core modules
// ============================================================================

// Resolve bundled extension entrypoints once at startup.
const canvasExtension = path.resolve(__dirname, "../../../extensions/canvas.ts");
const usageExtension = resolveUsageExtensionPath();

const pool = new ProcessPool(
	{
		command: PI_LAUNCH.command,
		baseArgs: () => {
			const args = [...PI_LAUNCH.baseArgs, "--mode", "rpc"];
			if (USAGE_EXTENSION_ENABLED) {
				args.push("-e", usageExtension);
			}
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
			// WsHandler owns attached-session snapshots and listener bookkeeping.
			wsHandler.handleProcessExit(proc);
			// Replenish the pool for the default cwd
			if (PI_AVAILABLE) {
				pool.prewarm(PI_CWD);
			}
		},
	},
);

const wsHandler = new WsHandler({
	registry,
	pool,
	sessionPaths,
	defaultCwd: PI_CWD,
	piLaunch: PI_LAUNCH,
	ensurePool: () => {
		if (wsHandler.isPiAvailable) {
			pool.prewarm(PI_CWD);
		}
	},
	isRequestAuthorized: (req) => authGuard.isAuthorizedRequest(req),
	materializeUploadedImage: (uploadedPath, mimeType) => backendApi.materializeUploadedImage(uploadedPath, mimeType),
});

// Register WS handler
wsHandler.register(wss);

const updateManager = new UpdateManager({
	pipaneVersion: PKG_VERSION,
	pipanePackageName: PKG_NAME,
	piLaunch: PI_LAUNCH,
	skipPipaneCheck: IS_DEVELOPMENT_COMMIT,
	cwd: PI_CWD,
	onPiRuntimeChanged: async () => {
		pool.decommissionAll();
		if (wsHandler.isPiAvailable) await pool.prewarm(PI_CWD);
	},
});
registerUpdateApi(app, updateManager);

const backendApi = new LocalBackendApi({
	localSettingsStore,
	sessionPaths,
	backendId: () => registeredBackendId,
	updateManager,
	runSessionMutation: (sessionPath, operation, mutation) => {
		const actor = registry.get(sessionPath);
		return actor.enqueue(operation, async () => {
			actor.assertAvailable(operation);
			await mutation();
		});
	},
	onLocalSettingsReloaded: () => wsHandler.notifySessionsChanged("__local_settings__"),
});
registerRestApi(app, { api: backendApi });
const backendProtocolHandler = new BackendProtocolHandler(backendApi);

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

function startSessionsWatcher(): FSWatcher | null {
	if (!existsSync(SESSIONS_DIR)) {
		console.log(`Sessions dir does not exist yet: ${SESSIONS_DIR}`);
		return null;
	}

	const sessionListTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const watcher = watch(SESSIONS_DIR, { recursive: true }, (_event, filename) => {
		if (!filename || !filename.endsWith(".jsonl")) return;
		const fullPath = path.join(SESSIONS_DIR, filename);

		// WsHandler coalesces detached state per file on a short trailing edge.
		wsHandler.notifySessionFileChanged(fullPath);

		// Sidebar notifications remain less frequent, but no longer let a change
		// in one session overwrite another session's pending watcher event.
		const pending = sessionListTimers.get(fullPath);
		if (pending) clearTimeout(pending);
		const timer = setTimeout(() => {
			sessionListTimers.delete(fullPath);
			wsHandler.notifySessionsChanged(fullPath);
		}, 300);
		timer.unref?.();
		sessionListTimers.set(fullPath, timer);
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

server.listen(REQUESTED_PORT, () => {
	void startRendezvousRegistration().catch((error) => {
		console.warn("[rendezvous] registration stopped:", error);
	});
	const address = server.address();
	const port = address && typeof address !== "string" ? address.port : REQUESTED_PORT;
	const authUrl = `http://${PUBLIC_HOSTNAME}:${port}/auth?token=${encodeURIComponent(AUTH_TOKEN)}`;
	log("");
	log("        _                        ");
	log("  _ __ (_)_ __   __ _ _ __   ___ ");
	log(" | '_ \\| | '_ \\ / _` | '_ \\ / _ \\");
	log(" | |_) | | |_) | (_| | | | |  __/");
	log(" | .__/|_| .__/ \\__,_|_| |_|\\___|");
	log(" |_|     |_|                      ");
	log(`  v${PKG_VERSION}`);
	log("");
	log(`  Local:  http://localhost:${port}`);
	log(`  Remote: ${authUrl}`);
	if (!process.env.PIPANE_AUTH_TOKEN) {
		log(`\n  Auth token is random and changes on restart.`);
		log(`  Set PIPANE_AUTH_TOKEN to use a fixed token.`);
	}
	log("");

	// The same asynchronous check feeds the web UI and preserves terminal hints.
	void updateManager.check().then(({ notices }) => {
		for (const notice of notices) {
			if (notice.target === "pipane") {
				log(`  Update available: v${notice.currentVersion} → v${notice.latestVersion}`);
				log(`  Open pipane in the browser to install it, or run \`npm install -g ${PKG_NAME}\`.`);
			} else if (notice.target === "pi") {
				log(`  Pi update available: v${notice.currentVersion} → v${notice.latestVersion}`);
				log("  Open pipane in the browser to install it, or run `pi update --self`.");
			} else if (notice.packages?.length) {
				log(`  Pi package updates available: ${notice.packages.join(", ")}`);
				log("  Open pipane in the browser to install them, or run `pi update --extensions`.");
			}
			log("");
		}
	}).catch((error) => {
		console.warn("[updates] Update check failed:", error);
	});
});

import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { RendezvousHub, type RendezvousHubOptions } from "./rendezvous-hub.js";

const BACKEND_PATH = "/v1/rendezvous/backend";
const BROWSER_PATH = "/v1/rendezvous/browser";
const MAX_SIGNAL_MESSAGE_BYTES = 256 * 1024;
const PING_INTERVAL_MS = 30_000;

export interface CreateRendezvousServerOptions extends RendezvousHubOptions {
	pingIntervalMs?: number;
}

export interface PipaneRendezvousServer {
	app: Express;
	server: Server;
	hub: RendezvousHub;
	listen(port?: number, host?: string): Promise<number>;
	close(): Promise<void>;
}

export function createRendezvousServer(
	options: CreateRendezvousServerOptions = {},
): PipaneRendezvousServer {
	const app = express();
	const server = createServer(app);
	const hub = new RendezvousHub(options);
	const backendWss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_MESSAGE_BYTES });
	const browserWss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_MESSAGE_BYTES });
	const alive = new WeakMap<WebSocket, boolean>();

	const track = (socket: WebSocket): void => {
		alive.set(socket, true);
		socket.on("pong", () => alive.set(socket, true));
	};
	backendWss.on("connection", (socket) => {
		track(socket);
		hub.acceptBackend(socket);
	});
	browserWss.on("connection", (socket) => {
		track(socket);
		hub.acceptBrowser(socket);
	});

	server.on("upgrade", (request, socket, head) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		const target = pathname === BACKEND_PATH
			? backendWss
			: pathname === BROWSER_PATH
				? browserWss
				: undefined;
		if (!target) {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		target.handleUpgrade(request, socket, head, (webSocket) => {
			target.emit("connection", webSocket, request);
		});
	});

	app.get("/health", (_request, response) => {
		response.json({ ok: true });
	});
	app.get("/api/rendezvous/backends/:backendId", (request, response) => {
		const backendId = request.params.backendId;
		const online = hub.isBackendOnline(backendId);
		const metadata = hub.getBackendMetadata(backendId);
		response.status(online ? 200 : 404).json({ backendId, online, ...(metadata ? { metadata } : {}) });
	});

	const pingInterval = setInterval(() => {
		for (const wss of [backendWss, browserWss]) {
			for (const socket of wss.clients) {
				if (alive.get(socket) === false) {
					socket.terminate();
					continue;
				}
				alive.set(socket, false);
				socket.ping();
			}
		}
	}, options.pingIntervalMs ?? PING_INTERVAL_MS);
	pingInterval.unref?.();

	return {
		app,
		server,
		hub,
		listen(port = 0, host = "127.0.0.1") {
			return new Promise<number>((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				server.once("error", onError);
				server.listen(port, host, () => {
					server.off("error", onError);
					const address = server.address();
					if (!address || typeof address === "string") {
						reject(new Error("Rendezvous server did not bind a TCP port"));
						return;
					}
					resolve(address.port);
				});
			});
		},
		async close() {
			clearInterval(pingInterval);
			hub.close();
			for (const wss of [backendWss, browserWss]) {
				for (const socket of wss.clients) socket.terminate();
			}
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}

const isMain = process.argv[1]
	&& path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const port = Number.parseInt(process.env.PORT || "8787", 10);
	const host = process.env.HOST || "0.0.0.0";
	const rendezvous = createRendezvousServer();
	void rendezvous.listen(port, host).then((boundPort) => {
		console.log(`pipane rendezvous listening on http://${host}:${boundPort}`);
	}).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

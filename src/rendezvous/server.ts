import express, { type Express, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { RENDEZVOUS_PROTOCOL_VERSION } from "../shared/rendezvous-protocol.js";
import type {
	AuthorizedBackendDescriptor,
	DeviceChallengeRequest,
	IceServerConfiguration,
} from "../shared/trust-protocol.js";
import { RendezvousHub } from "./rendezvous-hub.js";
import {
	IceServerProvider,
	RendezvousTrustStore,
	type RendezvousTrustStoreOptions,
	type TurnCredentialOptions,
} from "./trust-store.js";

const BACKEND_PATH = `/v${RENDEZVOUS_PROTOCOL_VERSION}/rendezvous/backend`;
const BROWSER_PATH = `/v${RENDEZVOUS_PROTOCOL_VERSION}/rendezvous/browser`;
const MAX_SIGNAL_MESSAGE_BYTES = 256 * 1024;
const PING_INTERVAL_MS = 30_000;

export interface CreateRendezvousServerOptions extends RendezvousTrustStoreOptions {
	trustStore?: RendezvousTrustStore;
	iceServers?: IceServerConfiguration[];
	turn?: TurnCredentialOptions;
	/** Built browser app directory. Production resolves the packaged client automatically. */
	clientDist?: string | false;
	pingIntervalMs?: number;
	registrationTimeoutMs?: number;
}

export interface PipaneRendezvousServer {
	app: Express;
	server: Server;
	hub: RendezvousHub;
	trustStore: RendezvousTrustStore;
	listen(port?: number, host?: string): Promise<number>;
	close(): Promise<void>;
}

export function createRendezvousServer(
	options: CreateRendezvousServerOptions = {},
): PipaneRendezvousServer {
	const app = express();
	const server = createServer(app);
	const trustStore = options.trustStore ?? new RendezvousTrustStore(options);
	const iceServerProvider = new IceServerProvider(options.iceServers, options.turn, options.now);
	const hub = new RendezvousHub({
		trustStore,
		iceServerProvider,
		registrationTimeoutMs: options.registrationTimeoutMs,
		now: options.now,
	});
	const backendWss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_MESSAGE_BYTES });
	const browserWss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_MESSAGE_BYTES });
	const alive = new WeakMap<WebSocket, boolean>();

	app.use(express.json({ limit: "32kb" }));
	app.use("/v1", (_request, response, next) => {
		response.setHeader("Cache-Control", "no-store");
		next();
	});

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
		target.handleUpgrade(request, socket, head, (webSocket) => target.emit("connection", webSocket, request));
	});

	app.get("/health", (_request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.json({ ok: true });
	});
	app.get("/api/rendezvous/backends/:backendId", (request, response) => {
		const backendId = request.params.backendId;
		const online = hub.isBackendOnline(backendId);
		const metadata = hub.getBackendMetadata(backendId);
		response.status(online ? 200 : 404).json({ backendId, online, ...(metadata ? { metadata } : {}) });
	});
	app.get("/v1/pairings/:pairId", route((request, response) => {
		const pairing = hub.getOpenPairing(param(request, "pairId"));
		if (!pairing) {
			response.status(404).json({ error: "Pairing capability is missing or expired" });
			return;
		}
		response.json(pairing);
	}));
	app.post("/v1/auth/challenges", route((request, response) => {
		const challengeRequest = request.body as DeviceChallengeRequest;
		if (challengeRequest?.purpose === "pair") {
			const pairing = challengeRequest.pairId ? hub.getOpenPairing(challengeRequest.pairId) : undefined;
			if (!pairing || pairing.backendId !== challengeRequest.backendId) {
				response.status(404).json({ error: "Pairing capability is missing or expired" });
				return;
			}
		} else if (challengeRequest?.purpose === "connect"
			&& challengeRequest.backendId
			&& !hub.isBackendOnline(challengeRequest.backendId)) {
			response.status(404).json({ error: "Backend is offline" });
			return;
		}
		response.json(trustStore.createChallenge(challengeRequest));
	}));
	app.post("/v1/pairings/:pairId/tickets", route((request, response) => {
		const pairing = hub.getOpenPairing(param(request, "pairId"));
		if (!pairing) {
			response.status(404).json({ error: "Pairing capability is missing or expired" });
			return;
		}
		const { challengeId, signature } = requireSignatureBody(request.body);
		const issued = trustStore.issuePairingTicket(challengeId, signature);
		if (issued.claims.pairId !== pairing.pairId || issued.claims.backendId !== pairing.backendId) {
			throw new Error("Device challenge does not match this pairing capability");
		}
		response.json({ ticket: issued.ticket, iceServers: iceServerProvider.issue(issued.claims.deviceId) });
	}));
	app.post("/v1/connections/tickets", route((request, response) => {
		const { challengeId, signature } = requireSignatureBody(request.body);
		const issued = trustStore.issueConnectionTicket(challengeId, signature);
		response.json({ ticket: issued.ticket, iceServers: iceServerProvider.issue(issued.claims.deviceId) });
	}));
	app.post("/v1/accounts/backends", route((request, response) => {
		const { challengeId, signature } = requireSignatureBody(request.body);
		const backends: AuthorizedBackendDescriptor[] = trustStore
			.listAuthorizedBackendIds(challengeId, signature)
			.map((backendId) => {
				const metadata = hub.getBackendMetadata(backendId);
				return {
					backendId,
					...(metadata?.name ? { name: metadata.name } : {}),
					...(metadata?.softwareVersion ? { softwareVersion: metadata.softwareVersion } : {}),
					protocolVersions: metadata?.protocolVersions ?? [],
					online: hub.isBackendOnline(backendId),
				};
			});
		response.json({ backends });
	}));
	app.post("/v1/device-invites", route((request, response) => {
		const { challengeId, signature } = requireSignatureBody(request.body);
		response.json(trustStore.createDeviceInvite(challengeId, signature));
	}));
	app.post("/v1/device-invites/:inviteId/accept", route((request, response) => {
		const { challengeId, signature } = requireSignatureBody(request.body);
		const secret = requireBodyString(request.body, "secret");
		response.json(trustStore.acceptDeviceInvite(
			challengeId,
			signature,
			param(request, "inviteId"),
			secret,
		));
	}));
	app.post("/v1/revocations/devices", route((request, response) => {
		const { challengeId, signature } = requireSignatureBody(request.body);
		const result = trustStore.revokeDevice(challengeId, signature);
		hub.notifyRevocation(result);
		response.json({ ok: true });
	}));
	app.post("/v1/revocations/backends", route((request, response) => {
		const { challengeId, signature } = requireSignatureBody(request.body);
		const result = trustStore.revokeBackend(challengeId, signature);
		hub.notifyRevocation(result);
		response.json({ ok: true });
	}));

	const packagedClientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client");
	const clientDist = options.clientDist === false
		? undefined
		: options.clientDist ?? (process.env.NODE_ENV === "production" ? packagedClientDist : undefined);
	if (clientDist && existsSync(path.join(clientDist, "index.html"))) {
		app.use(express.static(clientDist));
		app.use((request, response, next) => {
			if (request.method === "GET" && (/^\/(?:pair|invite)\/[^/]+$/u.test(request.path) || /^\/backend\/[^/]+$/u.test(request.path) || /^\/settings\/?$/u.test(request.path))) {
				response.sendFile(path.join(clientDist, "index.html"));
				return;
			}
			next();
		});
	}

	// Translate expected trust failures into stable JSON without exposing stacks.
	app.use((error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => {
		response.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
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
		trustStore,
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

function route(handler: (request: Request, response: Response) => void | Promise<void>) {
	return (request: Request, response: Response, next: (error?: unknown) => void): void => {
		Promise.resolve(handler(request, response)).catch(next);
	};
}

function param(request: Request, name: string): string {
	const value = request.params[name];
	if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`);
	return value;
}

function requireSignatureBody(value: unknown): { challengeId: string; signature: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
	const body = value as Record<string, unknown>;
	if (typeof body.challengeId !== "string" || !body.challengeId || typeof body.signature !== "string" || !body.signature) {
		throw new Error("challengeId and signature are required");
	}
	return { challengeId: body.challengeId, signature: body.signature };
}

function requireBodyString(value: unknown, name: string): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
	const result = (value as Record<string, unknown>)[name];
	if (typeof result !== "string" || !result) throw new Error(`${name} is required`);
	return result;
}

function envUrls(name: string): string[] {
	return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

const isMain = process.argv[1]
	&& path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const port = Number.parseInt(process.env.PORT || "8787", 10);
	const host = process.env.HOST || "0.0.0.0";
	const stunUrls = envUrls("PIPANE_STUN_URLS");
	const turnUrls = envUrls("PIPANE_TURN_URLS");
	const turnSecret = process.env.PIPANE_TURN_SECRET;
	const rendezvous = createRendezvousServer({
		iceServers: stunUrls.length > 0 ? [{ urls: stunUrls }] : [],
		turn: turnUrls.length > 0 && turnSecret ? { urls: turnUrls, secret: turnSecret } : undefined,
	});
	void rendezvous.listen(port, host).then((boundPort) => {
		console.log(`pipane rendezvous listening on http://${host}:${boundPort}`);
	}).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

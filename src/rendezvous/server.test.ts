// @vitest-environment node

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
	RENDEZVOUS_PROTOCOL_VERSION,
	decodeBackendMessage,
	decodeBrowserMessage,
	type BackendRendezvousMessage,
	type BrowserRendezvousMessage,
} from "../shared/rendezvous-protocol.js";
import { loadOrCreateBackendIdentity } from "../server/backend-identity.js";
import {
	BackendRendezvousClient,
	rendezvousWebSocketUrl,
} from "../server/rendezvous-client.js";
import { createRendezvousServer, type PipaneRendezvousServer } from "./server.js";

const cleanupDirs: string[] = [];
const cleanupServers: PipaneRendezvousServer[] = [];
const cleanupSockets: WebSocket[] = [];
const cleanupClients: BackendRendezvousClient[] = [];

afterEach(async () => {
	for (const client of cleanupClients.splice(0)) client.stop();
	for (const socket of cleanupSockets.splice(0)) socket.close();
	await Promise.all(cleanupServers.splice(0).map((server) => server.close()));
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startServer(): Promise<{ rendezvous: PipaneRendezvousServer; baseUrl: string }> {
	const rendezvous = createRendezvousServer();
	cleanupServers.push(rendezvous);
	const port = await rendezvous.listen();
	return { rendezvous, baseUrl: `http://127.0.0.1:${port}` };
}

function createIdentity() {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-rendezvous-test-"));
	cleanupDirs.push(dir);
	return loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
}

function openSocket(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		cleanupSockets.push(socket);
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

function nextBrowserMessage(socket: WebSocket): Promise<BrowserRendezvousMessage> {
	return new Promise((resolve, reject) => {
		const onMessage = (raw: WebSocket.RawData) => {
			const decoded = decodeBrowserMessage(raw.toString());
			if (!decoded.ok) {
				reject(new Error(decoded.error.message));
				return;
			}
			resolve(decoded.value);
		};
		socket.once("message", onMessage);
	});
}

function nextBackendMessage(
	socket: WebSocket,
	predicate: (message: BackendRendezvousMessage) => boolean = () => true,
): Promise<BackendRendezvousMessage> {
	return new Promise((resolve, reject) => {
		const onMessage = (raw: WebSocket.RawData) => {
			const decoded = decodeBackendMessage(raw.toString());
			if (!decoded.ok) {
				socket.off("message", onMessage);
				reject(new Error(decoded.error.message));
				return;
			}
			if (!predicate(decoded.value)) return;
			socket.off("message", onMessage);
			resolve(decoded.value);
		};
		socket.on("message", onMessage);
	});
}

function eventPromise<T>(subscribe: (resolve: (value: T) => void) => () => void): Promise<T> {
	return new Promise((resolve) => {
		let unsubscribe = () => {};
		unsubscribe = subscribe((value) => {
			unsubscribe();
			resolve(value);
		});
	});
}

describe("pipane rendezvous", () => {
	it("authenticates a persistent backend and relays signaling in both directions", async () => {
		const { rendezvous, baseUrl } = await startServer();
		const identity = createIdentity();
		const client = new BackendRendezvousClient({
			url: baseUrl,
			identity,
			metadata: { name: "test-backend", softwareVersion: "0.1.6", protocolVersions: [1] },
		});
		cleanupClients.push(client);

		await expect(client.start()).resolves.toBe(identity.backendId);
		expect(rendezvous.hub.isBackendOnline(identity.backendId)).toBe(true);
		expect(rendezvous.hub.getBackendMetadata(identity.backendId)?.name).toBe("test-backend");

		const statusResponse = await fetch(`${baseUrl}/api/rendezvous/backends/${identity.backendId}`);
		expect(statusResponse.status).toBe(200);
		expect(await statusResponse.json()).toEqual(expect.objectContaining({
			backendId: identity.backendId,
			online: true,
		}));

		const browser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const connectionRequest = eventPromise<string>((resolve) => client.onConnectionRequest(resolve));
		const browserConnected = nextBrowserMessage(browser);
		browser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "connect_backend",
			backendId: identity.backendId,
		}));
		const [connectionId, connected] = await Promise.all([connectionRequest, browserConnected]);
		expect(connected).toEqual({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "backend_connected",
			backendId: identity.backendId,
			connectionId,
		});

		const offer = { kind: "description" as const, type: "offer" as const, sdp: "v=0\r\n" };
		const backendSignal = eventPromise<{ connectionId: string; signal: unknown }>((resolve) => client.onSignal(
			(id, signal) => resolve({ connectionId: id, signal }),
		));
		browser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "signal",
			connectionId,
			signal: offer,
		}));
		expect(await backendSignal).toEqual({ connectionId, signal: offer });

		const answer = { kind: "description" as const, type: "answer" as const, sdp: "v=0\r\na=answer\r\n" };
		const browserSignal = nextBrowserMessage(browser);
		client.sendSignal(connectionId, answer);
		expect(await browserSignal).toEqual({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "signal",
			connectionId,
			signal: answer,
		});

		const connectionClosed = eventPromise<{ id: string; reason: string }>((resolve) => client.onConnectionClosed(
			(id, reason) => resolve({ id, reason }),
		));
		browser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "close_connection",
			connectionId,
			reason: "done",
		}));
		expect(await connectionClosed).toEqual({ id: connectionId, reason: "done" });
	});

	it("reconnects the persistent outbound backend registration", async () => {
		const { baseUrl } = await startServer();
		const identity = createIdentity();
		const sockets: WebSocket[] = [];
		const client = new BackendRendezvousClient({
			url: baseUrl,
			identity,
			metadata: { softwareVersion: "0.1.6", protocolVersions: [1] },
			createWebSocket: (url) => {
				const socket = new WebSocket(url);
				sockets.push(socket);
				return socket;
			},
		});
		cleanupClients.push(client);
		await client.start();

		const disconnected = eventPromise<boolean>((resolve) => client.onStatus((connected) => {
			if (!connected) resolve(connected);
		}));
		sockets[0].terminate();
		expect(await disconnected).toBe(false);

		const reconnected = eventPromise<boolean>((resolve) => client.onStatus((connected) => {
			if (connected) resolve(connected);
		}));
		expect(await reconnected).toBe(true);
		expect(sockets).toHaveLength(2);
	});

	it("rejects invalid backend signatures and reports offline backends", async () => {
		const { baseUrl } = await startServer();
		const backend = await openSocket(rendezvousWebSocketUrl(baseUrl, "backend"));
		const registrationError = nextBackendMessage(backend, (message) => message.type === "error");
		backend.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "register_backend",
			publicKey: "invalid-key",
			signature: "invalid-signature",
			metadata: { softwareVersion: "0.1.6", protocolVersions: [1] },
		}));
		expect(await registrationError).toEqual(expect.objectContaining({
			type: "error",
			code: "unauthorized_connection",
		}));

		const browser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const offlineError = nextBrowserMessage(browser);
		browser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "connect_backend",
			backendId: "b_offline",
		}));
		expect(await offlineError).toEqual(expect.objectContaining({
			type: "error",
			code: "backend_offline",
		}));
	});

	it("serves health and rejects unknown WebSocket paths", async () => {
		const { baseUrl } = await startServer();
		expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({ ok: true });
		await expect(openSocket(`${baseUrl.replace("http:", "ws:")}/unknown`)).rejects.toThrow();
	});
});

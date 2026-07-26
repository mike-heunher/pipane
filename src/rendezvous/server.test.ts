// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
	RENDEZVOUS_PROTOCOL_VERSION,
	decodeBackendMessage,
	decodeBrowserMessage,
	type BackendRendezvousMessage,
	type BrowserRendezvousMessage,
} from "../shared/rendezvous-protocol.js";
import { deviceChallengePayload, type ConnectionTicketResponse, type DeviceChallenge } from "../shared/trust-protocol.js";
import { deriveDeviceId } from "../shared/node-trust-crypto.js";
import { loadOrCreateBackendIdentity } from "../server/backend-identity.js";
import {
	BackendRendezvousClient,
	rendezvousWebSocketUrl,
	type BackendConnectionRequest,
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
	const dataDir = mkdtempSync(path.join(tmpdir(), "pipane-rendezvous-state-"));
	cleanupDirs.push(dataDir);
	const rendezvous = createRendezvousServer({ dataDir });
	cleanupServers.push(rendezvous);
	const port = await rendezvous.listen();
	return { rendezvous, baseUrl: `http://127.0.0.1:${port}` };
}

function createIdentity() {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-rendezvous-test-"));
	cleanupDirs.push(dir);
	return loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
}

function createDevice() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const encodedPublicKey = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url");
	return {
		privateKey,
		publicKey: encodedPublicKey,
		deviceId: deriveDeviceId(encodedPublicKey),
		sign(challenge: DeviceChallenge): string {
			return sign("sha256", Buffer.from(deviceChallengePayload(challenge)), {
				key: privateKey,
				dsaEncoding: "ieee-p1363",
			}).toString("base64url");
		},
	};
}

async function issueTicket(
	baseUrl: string,
	device: ReturnType<typeof createDevice>,
	request: Record<string, unknown>,
	path: string,
): Promise<ConnectionTicketResponse> {
	const challengeResponse = await fetch(`${baseUrl}/v1/auth/challenges`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
	expect(challengeResponse.status).toBe(200);
	const challenge = await challengeResponse.json() as DeviceChallenge;
	const ticketResponse = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ challengeId: challenge.challengeId, signature: device.sign(challenge) }),
	});
	expect(ticketResponse.status).toBe(200);
	return ticketResponse.json() as Promise<ConnectionTicketResponse>;
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

describe("pipane rendezvous trust and signaling", () => {
	it("pairs a device, creates an anonymous account, and requires one-use tickets", async () => {
		const { rendezvous, baseUrl } = await startServer();
		const identity = createIdentity();
		const client = new BackendRendezvousClient({
			url: baseUrl,
			identity,
			metadata: { name: "test-backend", softwareVersion: "0.1.6", protocolVersions: [1] },
		});
		cleanupClients.push(client);
		await expect(client.start()).resolves.toBe(identity.backendId);
		expect(client.ticketPublicKey).toBe(rendezvous.trustStore.ticketPublicKey);
		expect(rendezvous.hub.isBackendOnline(identity.backendId)).toBe(true);

		const pairId = "pair_integration";
		await client.openPairing(pairId, Date.now() + 60_000);
		const device = createDevice();
		const pairingTicket = await issueTicket(baseUrl, device, {
			purpose: "pair",
			devicePublicKey: device.publicKey,
			backendId: identity.backendId,
			connectionId: "c_pairing",
			pairId,
		}, `/v1/pairings/${pairId}/tickets`);

		const browser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const connectionRequest = eventPromise<BackendConnectionRequest>((resolve) => client.onConnectionRequest(resolve));
		const browserConnected = nextBrowserMessage(browser);
		const browserTurn = {
			urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:443?transport=tcp"],
			username: "temporary-browser",
			credential: "temporary-credential",
		};
		browser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "connect_backend",
			backendId: identity.backendId,
			ticket: pairingTicket.ticket,
			iceServers: [browserTurn],
		}));
		const [request, connected] = await Promise.all([connectionRequest, browserConnected]);
		expect(request).toEqual({ connectionId: "c_pairing", ticket: pairingTicket.ticket, iceServers: [browserTurn] });
		expect(connected).toEqual({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "backend_connected",
			backendId: identity.backendId,
			connectionId: "c_pairing",
		});

		const confirmation = await client.confirmPairing("c_pairing");
		expect(confirmation).toEqual(expect.objectContaining({
			pairId,
			deviceId: device.deviceId,
			accountId: expect.stringMatching(/^a_/),
		}));
		expect(rendezvous.trustStore.getBackendOwner(identity.backendId)).toBe(confirmation.accountId);

		const discoveryChallengeResponse = await fetch(`${baseUrl}/v1/auth/challenges`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ purpose: "discover", deviceId: device.deviceId }),
		});
		const discoveryChallenge = await discoveryChallengeResponse.json() as DeviceChallenge;
		const discoveryResponse = await fetch(`${baseUrl}/v1/accounts/backends`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				challengeId: discoveryChallenge.challengeId,
				signature: device.sign(discoveryChallenge),
			}),
		});
		expect(await discoveryResponse.json()).toEqual({
			backends: [{
				backendId: identity.backendId,
				name: "test-backend",
				softwareVersion: "0.1.6",
				protocolVersions: [1],
				online: true,
			}],
		});

		const createInviteChallengeResponse = await fetch(`${baseUrl}/v1/auth/challenges`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ purpose: "create_device_invite", deviceId: device.deviceId }),
		});
		const createInviteChallenge = await createInviteChallengeResponse.json() as DeviceChallenge;
		const inviteResponse = await fetch(`${baseUrl}/v1/device-invites`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				challengeId: createInviteChallenge.challengeId,
				signature: device.sign(createInviteChallenge),
			}),
		});
		expect(inviteResponse.status).toBe(200);
		const invite = await inviteResponse.json() as { inviteId: string; secret: string; expiresAt: number };
		expect(invite.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);

		const invitedDevice = createDevice();
		const acceptChallengeResponse = await fetch(`${baseUrl}/v1/auth/challenges`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				purpose: "accept_device_invite",
				deviceId: invitedDevice.deviceId,
				devicePublicKey: invitedDevice.publicKey,
				pairId: invite.inviteId,
			}),
		});
		const acceptChallenge = await acceptChallengeResponse.json() as DeviceChallenge;
		const acceptanceResponse = await fetch(`${baseUrl}/v1/device-invites/${encodeURIComponent(invite.inviteId)}/accept`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				challengeId: acceptChallenge.challengeId,
				signature: invitedDevice.sign(acceptChallenge),
				secret: invite.secret,
			}),
		});
		expect(await acceptanceResponse.json()).toEqual({
			accountId: confirmation.accountId,
			deviceId: invitedDevice.deviceId,
		});
		const invitedDiscoveryChallengeResponse = await fetch(`${baseUrl}/v1/auth/challenges`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ purpose: "discover", deviceId: invitedDevice.deviceId }),
		});
		const invitedDiscoveryChallenge = await invitedDiscoveryChallengeResponse.json() as DeviceChallenge;
		const invitedDiscoveryResponse = await fetch(`${baseUrl}/v1/accounts/backends`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				challengeId: invitedDiscoveryChallenge.challengeId,
				signature: invitedDevice.sign(invitedDiscoveryChallenge),
			}),
		});
		expect((await invitedDiscoveryResponse.json() as { backends: Array<{ backendId: string }> }).backends.map(
			(backend) => backend.backendId,
		)).toEqual([identity.backendId]);

		const replayBrowser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const replayError = nextBrowserMessage(replayBrowser);
		replayBrowser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "connect_backend",
			backendId: identity.backendId,
			ticket: pairingTicket.ticket,
		}));
		expect(await replayError).toEqual(expect.objectContaining({ type: "error", code: "invalid_ticket" }));

		browser.close();
		const connectionTicket = await issueTicket(baseUrl, device, {
			purpose: "connect",
			deviceId: device.deviceId,
			backendId: identity.backendId,
			connectionId: "c_regular",
		}, "/v1/connections/tickets");
		const regularBrowser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const regularRequest = eventPromise<BackendConnectionRequest>((resolve) => client.onConnectionRequest(resolve));
		regularBrowser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "connect_backend",
			backendId: identity.backendId,
			ticket: connectionTicket.ticket,
		}));
		expect(await regularRequest).toEqual({ connectionId: "c_regular", ticket: connectionTicket.ticket, iceServers: [] });

		client.stop();
		await vi.waitFor(() => expect(rendezvous.hub.isBackendOnline(identity.backendId)).toBe(false));
		const revokeChallengeResponse = await fetch(`${baseUrl}/v1/auth/challenges`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ purpose: "revoke_backend", deviceId: device.deviceId, backendId: identity.backendId }),
		});
		expect(revokeChallengeResponse.status).toBe(200);
		const revokeChallenge = await revokeChallengeResponse.json() as DeviceChallenge;
		const revokeResponse = await fetch(`${baseUrl}/v1/revocations/backends`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challengeId: revokeChallenge.challengeId, signature: device.sign(revokeChallenge) }),
		});
		expect(revokeResponse.status).toBe(200);

		const replacement = new BackendRendezvousClient({
			url: baseUrl,
			identity,
			metadata: { softwareVersion: "0.1.6", protocolVersions: [1] },
		});
		cleanupClients.push(replacement);
		const pendingRevocation = eventPromise<{ accountId: string; deviceId?: string }>((resolve) => replacement.onAuthorizationRevoked(resolve));
		await replacement.start();
		expect(await pendingRevocation).toEqual(expect.objectContaining({
			type: "authorization_revoked",
			accountId: confirmation.accountId,
		}));
	});

	it("relays role-correct signaling and rejects cross-route ownership", async () => {
		const { baseUrl } = await startServer();
		const identity = createIdentity();
		const client = new BackendRendezvousClient({
			url: baseUrl,
			identity,
			metadata: { softwareVersion: "0.1.6", protocolVersions: [1] },
		});
		cleanupClients.push(client);
		await client.start();
		await client.openPairing("pair_signal", Date.now() + 60_000);
		const device = createDevice();
		const ticket = await issueTicket(baseUrl, device, {
			purpose: "pair",
			devicePublicKey: device.publicKey,
			backendId: identity.backendId,
			connectionId: "c_signal",
			pairId: "pair_signal",
		}, "/v1/pairings/pair_signal/tickets");
		const browser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const connected = nextBrowserMessage(browser);
		browser.send(JSON.stringify({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, type: "connect_backend", backendId: identity.backendId, ticket: ticket.ticket }));
		await connected;

		const offer = { kind: "description" as const, type: "offer" as const, sdp: "v=0\r\na=fingerprint:sha-256 AA:BB\r\n" };
		const backendSignal = eventPromise<{ connectionId: string; signal: unknown }>((resolve) => client.onSignal(
			(connectionId, signal) => resolve({ connectionId, signal }),
		));
		browser.send(JSON.stringify({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, type: "signal", connectionId: "c_signal", signal: offer }));
		expect(await backendSignal).toEqual({ connectionId: "c_signal", signal: offer });

		const answer = { kind: "description" as const, type: "answer" as const, sdp: "v=0\r\na=fingerprint:sha-256 CC:DD\r\n" };
		const browserSignal = nextBrowserMessage(browser);
		client.sendSignal("c_signal", answer);
		expect(await browserSignal).toEqual({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, type: "signal", connectionId: "c_signal", signal: answer });

		const attacker = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const attackError = nextBrowserMessage(attacker);
		attacker.send(JSON.stringify({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, type: "signal", connectionId: "c_signal", signal: offer }));
		expect(await attackError).toEqual(expect.objectContaining({ type: "error", code: "unauthorized_connection" }));
	});

	it("pushes device revocation and closes active routes", async () => {
		const { baseUrl } = await startServer();
		const identity = createIdentity();
		const client = new BackendRendezvousClient({ url: baseUrl, identity, metadata: { softwareVersion: "test", protocolVersions: [1] } });
		cleanupClients.push(client);
		await client.start();
		await client.openPairing("pair_revoke", Date.now() + 60_000);
		const device = createDevice();
		const pairTicket = await issueTicket(baseUrl, device, {
			purpose: "pair", devicePublicKey: device.publicKey, backendId: identity.backendId, connectionId: "c_pair", pairId: "pair_revoke",
		}, "/v1/pairings/pair_revoke/tickets");
		const pairBrowser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const pairConnected = nextBrowserMessage(pairBrowser);
		pairBrowser.send(JSON.stringify({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, type: "connect_backend", backendId: identity.backendId, ticket: pairTicket.ticket }));
		await pairConnected;
		const confirmation = await client.confirmPairing("c_pair");
		pairBrowser.close();

		const regularTicket = await issueTicket(baseUrl, device, {
			purpose: "connect", deviceId: device.deviceId, backendId: identity.backendId, connectionId: "c_revoke",
		}, "/v1/connections/tickets");
		const browser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const connected = nextBrowserMessage(browser);
		browser.send(JSON.stringify({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, type: "connect_backend", backendId: identity.backendId, ticket: regularTicket.ticket }));
		await connected;

		const revocation = eventPromise<{ accountId: string; deviceId?: string }>((resolve) => client.onAuthorizationRevoked(resolve));
		const closed = nextBrowserMessage(browser);
		const challengeResponse = await fetch(`${baseUrl}/v1/auth/challenges`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ purpose: "revoke_device", deviceId: device.deviceId, backendId: identity.backendId, targetDeviceId: device.deviceId }),
		});
		const challenge = await challengeResponse.json() as DeviceChallenge;
		const revokeResponse = await fetch(`${baseUrl}/v1/revocations/devices`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challengeId: challenge.challengeId, signature: device.sign(challenge) }),
		});
		expect(revokeResponse.status).toBe(200);
		expect(await revocation).toEqual({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "authorization_revoked",
			accountId: confirmation.accountId,
			deviceId: device.deviceId,
		});
		expect(await closed).toEqual(expect.objectContaining({ type: "connection_closed", reason: "Authorization revoked" }));

		const deniedChallenge = await fetch(`${baseUrl}/v1/auth/challenges`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ purpose: "connect", deviceId: device.deviceId, backendId: identity.backendId, connectionId: "c_denied" }),
		});
		expect(deniedChallenge.status).toBe(400);
	});

	it("reconnects backend registration and rejects invalid signatures or offline targets", async () => {
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
		const disconnected = eventPromise<boolean>((resolve) => client.onStatus((connected) => { if (!connected) resolve(false); }));
		sockets[0].terminate();
		expect(await disconnected).toBe(false);
		const reconnected = eventPromise<boolean>((resolve) => client.onStatus((connected) => { if (connected) resolve(true); }));
		expect(await reconnected).toBe(true);
		expect(sockets).toHaveLength(2);

		const backend = await openSocket(rendezvousWebSocketUrl(baseUrl, "backend"));
		const registrationError = nextBackendMessage(backend, (message) => message.type === "error");
		backend.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "register_backend",
			publicKey: "invalid-key",
			signature: "invalid-signature",
			metadata: { softwareVersion: "0.1.6", protocolVersions: [1] },
		}));
		expect(await registrationError).toEqual(expect.objectContaining({ type: "error", code: "unauthorized_connection" }));

		const browser = await openSocket(rendezvousWebSocketUrl(baseUrl, "browser"));
		const offlineError = nextBrowserMessage(browser);
		browser.send(JSON.stringify({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			type: "connect_backend",
			backendId: "b_offline",
			ticket: "invalid",
		}));
		expect(await offlineError).toEqual(expect.objectContaining({ type: "error", code: "backend_offline" }));
	});

	it("serves health and rejects unknown WebSocket paths", async () => {
		const { baseUrl } = await startServer();
		expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({ ok: true });
		await expect(openSocket(`${baseUrl.replace("http:", "ws:")}/unknown`)).rejects.toThrow();
	});
});

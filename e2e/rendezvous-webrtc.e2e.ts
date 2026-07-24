import { expect, test, type BrowserContext } from "@playwright/test";
import nodeDataChannel from "node-datachannel";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreateBackendIdentity } from "../src/server/backend-identity.js";
import { BackendTrustStore } from "../src/server/backend-trust-store.js";
import { BackendConnectionAuthorizer } from "../src/server/backend-connection-authorizer.js";
import { BackendRendezvousClient, rendezvousWebSocketUrl } from "../src/server/rendezvous-client.js";
import {
	BackendWebRtcManager,
	PIPANE_DATA_CHANNEL_LABEL,
	PIPANE_DATA_CHANNEL_PROTOCOL,
} from "../src/server/backend-webrtc.js";
import { RENDEZVOUS_PROTOCOL_VERSION } from "../src/shared/rendezvous-protocol.js";
import type { BackendApi } from "../src/shared/backend-api.js";
import { BackendProtocolHandler } from "../src/server/backend-protocol-handler.js";
import { DataChannelFrameConnection } from "../src/server/frame-connection.js";
import { routeFrameConnection } from "../src/server/frame-router.js";
import { createRendezvousServer } from "../src/rendezvous/server.js";
import { MockTurnServer } from "./mock-turn-server.js";

function attachTestBackendProtocols(peers: BackendWebRtcManager, backendId: string, projectName: string): void {
	let acceptedConnections = 0;
	const api: BackendApi = {
		getCapabilities: async () => ({
			backendId,
			semanticProtocolVersion: 2,
			applicationProtocolVersions: [1],
			features: ["sessions", "local-settings", "updates"],
		}),
		listSessions: async () => [{
			id: projectName,
			path: `/sessions/${projectName}.jsonl`,
			cwd: `/work/${projectName}`,
			cwdDisplay: `~/work/${projectName}`,
			name: `${projectName} session`,
			created: "2026-07-20T10:00:00.000Z",
			modified: projectName === "first-project" ? "2026-07-22T10:00:00.000Z" : "2026-07-21T10:00:00.000Z",
			messageCount: 1,
			firstMessage: `Work on ${projectName}`,
		}],
		deleteSession: async () => undefined,
		listForkMessages: async () => [],
		browseDirectory: async (requestedPath) => ({ path: requestedPath || "/", dirs: [] }),
		getRawSession: async () => "",
		getFileContent: async (_sessionPath, requestedPath) => ({ path: requestedPath, content: "" }),
		getLocalSettings: async () => ({ path: "/settings.json", exists: false, errors: [], settings: {}, formatted: "{}\n" }),
		validateLocalSettings: async () => ({ valid: true, errors: [], formatted: "{}\n" }),
		patchLocalSettings: async () => ({ valid: true, errors: [], formatted: "{}\n" }),
		saveLocalSettings: async () => ({ valid: true, errors: [], formatted: "{}\n" }),
		getUpdates: async () => ({ checkedAt: new Date(0).toISOString(), notices: [] }),
		runUpdate: async (target) => ({
			result: { target, message: "updated", restartRequired: false },
			snapshot: { checkedAt: new Date().toISOString(), notices: [] },
		}),
	};
	const semantic = new BackendProtocolHandler(api);
	peers.onDataChannel(({ channel, deviceId }) => {
		const routes = routeFrameConnection(new DataChannelFrameConnection(channel));
		semantic.accept(routes.semantic, deviceId);
		const connectionNumber = ++acceptedConnections;
		routes.application.on("message", (frame) => {
			const raw = frame.toString();
			if (raw === "ping") {
				routes.application.send("pong");
				return;
			}
			let command: any;
			try { command = JSON.parse(raw); } catch { return; }
			const data = command.type === "get_available_models"
				? { models: [] }
				: command.type === "get_default_model"
					? { model: null, thinkingLevel: "off" }
					: command.type === "get_session_statuses"
						? { statuses: {} }
						: command.type === "get_commands"
							? { commands: [] }
							: {};
			routes.application.send(JSON.stringify({
				protocolVersion: 1,
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data,
			}));
		});
		// The handcrafted first connection asserts raw ordering and revocation.
		// Subsequent QR/app connections receive the normal application init.
		if (connectionNumber > 1) {
			routes.application.send(JSON.stringify({
				protocolVersion: 1,
				type: "init",
				sessionStatuses: {},
				steeringQueues: {},
				providerUsageStatuses: {},
				// Exercise carrier fragmentation before normal remote app startup.
				carrierPadding: "x".repeat(512 * 1024),
			}));
		}
	});
}

interface BrowserPairResult {
	reply: string;
	ordered: boolean;
	privateKeyExtractable: boolean;
	backendIdentityVerified: boolean;
	accountId: string;
	deviceId: string;
	revoked: boolean;
	forcedTurn: boolean;
}

test("pairs, forces TURN, merges backend sessions, and revokes a DataChannel", async ({ page, browser }) => {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-webrtc-e2e-"));
	const turn = new MockTurnServer();
	await turn.listen();
	const rendezvous = createRendezvousServer({
		dataDir: path.join(dir, "rendezvous"),
		clientDist: path.resolve("dist/client"),
		iceServers: [{ urls: turn.url, username: turn.username, credential: turn.password }],
	});
	const port = await rendezvous.listen();
	const baseUrl = `http://127.0.0.1:${port}`;
	const identity = loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
	const backendTrust = new BackendTrustStore({ filePath: path.join(dir, "backend-trust.json") });
	const pairing = backendTrust.createPairing();
	const signaling = new BackendRendezvousClient({
		url: baseUrl,
		identity,
		metadata: { name: "First backend", softwareVersion: "test", protocolVersions: [1, 2] },
	});
	let peers: BackendWebRtcManager | undefined;
	let secondPeers: BackendWebRtcManager | undefined;
	let secondSignaling: BackendRendezvousClient | undefined;
	let invitedContext: BrowserContext | undefined;

	try {
		await signaling.start();
		await signaling.openPairing(pairing.pairId, pairing.expiresAt);
		const authorizer = new BackendConnectionAuthorizer(backendTrust, signaling);
		peers = new BackendWebRtcManager({
			signaling,
			identity,
			ticketPublicKey: () => signaling.ticketPublicKey,
			authorize: (context) => authorizer.authorize(context),
			iceTransportPolicy: "relay",
			bindAddress: "127.0.0.1",
		});
		attachTestBackendProtocols(peers, identity.backendId, "first-project");
		signaling.onAuthorizationRevoked(({ accountId, deviceId }) => {
			backendTrust.applyRevocation(accountId, deviceId);
			peers?.closeAuthorization(accountId, deviceId);
		});

		await page.goto(`${baseUrl}/health`);
		const result = await page.evaluate(async (options): Promise<BrowserPairResult> => {
			const encode = (value: ArrayBuffer): string => {
				let binary = "";
				for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
				return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
			};
			const decode = (value: string): ArrayBuffer => {
				const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
				const bytes = new Uint8Array(binary.length);
				for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
				return bytes.buffer;
			};
			const hash = async (value: string | ArrayBuffer): Promise<string> => encode(await crypto.subtle.digest(
				"SHA-256",
				typeof value === "string" ? new TextEncoder().encode(value) : value,
			));
			const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
			const privateKey = await new Promise<CryptoKey>((resolve, reject) => {
				const open = indexedDB.open("pipane-e2e-device", 1);
				open.onupgradeneeded = () => open.result.createObjectStore("keys");
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const database = open.result;
					const write = database.transaction("keys", "readwrite");
					write.objectStore("keys").put(keys.privateKey, "private");
					write.onerror = () => reject(write.error);
					write.oncomplete = () => {
						const read = database.transaction("keys", "readonly").objectStore("keys").get("private");
						read.onerror = () => reject(read.error);
						read.onsuccess = () => {
							database.close();
							resolve(read.result as CryptoKey);
						};
					};
				};
			});
			const publicKeyBytes = await crypto.subtle.exportKey("spki", keys.publicKey);
			const devicePublicKey = encode(publicKeyBytes);
			const deviceId = `d_${await hash(publicKeyBytes)}`;
			const connectionId = `c_${crypto.randomUUID()}`;
			const challengeResponse = await fetch("/v1/auth/challenges", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					purpose: "pair",
					devicePublicKey,
					backendId: options.backendId,
					connectionId,
					pairId: options.pairId,
				}),
			});
			if (!challengeResponse.ok) throw new Error(await challengeResponse.text());
			const challenge = await challengeResponse.json();
			const challengePayload = [
				"pipane-device-challenge-v1",
				challenge.challengeId,
				challenge.nonce,
				challenge.purpose,
				challenge.deviceId,
				challenge.devicePublicKey,
				challenge.backendId || "",
				challenge.connectionId || "",
				challenge.pairId || "",
				challenge.targetDeviceId || "",
				String(challenge.expiresAt),
			].join("\n");
			const challengeSignature = encode(await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				privateKey,
				new TextEncoder().encode(challengePayload),
			));
			const ticketResponse = await fetch(`/v1/pairings/${encodeURIComponent(options.pairId)}/tickets`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ challengeId: challenge.challengeId, signature: challengeSignature }),
			});
			if (!ticketResponse.ok) throw new Error(await ticketResponse.text());
			const authorization = await ticketResponse.json();
			const ticketClaims = JSON.parse(atob(authorization.ticket.split(".")[0].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(authorization.ticket.split(".")[0].length / 4) * 4, "=")));

			return new Promise<BrowserPairResult>((resolve, reject) => {
				const socket = new WebSocket(options.wsUrl);
				const peer = new RTCPeerConnection({ iceServers: authorization.iceServers, iceTransportPolicy: "relay" });
				const channel = peer.createDataChannel(options.label, { ordered: true, protocol: options.protocol });
				let answerSdp: string | undefined;
				let offerSdp = "";
				let binding: any;
				let remoteSet = false;
				let authenticated: { accountId: string; deviceId: string } | undefined;
				let reply: string | undefined;
				let revocationStarted = false;
				let routeClosed = false;
				let channelClosed = false;
				let sawRelayCandidate = false;
				let sawRemoteRelayCandidate = false;
				const pendingCandidates: RTCIceCandidateInit[] = [];
				const send = (message: object) => socket.send(JSON.stringify({ protocolVersion: options.protocolVersion, ...message }));
				const cleanup = () => {
					channel.close();
					peer.close();
					socket.close();
				};
				const fail = (error: unknown) => {
					cleanup();
					reject(error instanceof Error ? error : new Error(String(error)));
				};
				const finishIfRevoked = () => {
					if (!reply || !authenticated || !routeClosed || !channelClosed) return;
					resolve({
						reply,
						ordered: channel.ordered,
						privateKeyExtractable: privateKey.extractable,
						backendIdentityVerified: true,
						accountId: authenticated.accountId,
						deviceId: authenticated.deviceId,
						revoked: true,
						forcedTurn: sawRelayCandidate && sawRemoteRelayCandidate,
					});
					cleanup();
				};
				const applyAnswer = async () => {
					if (!answerSdp || !binding || remoteSet) return;
					const backendKeyBytes = decode(binding.publicKey);
					if (`b_${await hash(backendKeyBytes)}` !== options.backendId
						|| binding.backendId !== options.backendId
						|| binding.connectionId !== connectionId
						|| binding.offerSha256 !== await hash(offerSdp)
						|| binding.answerSha256 !== await hash(answerSdp)
						|| binding.expiresAt !== ticketClaims.expiresAt) {
						throw new Error("Backend binding mismatch");
					}
					const fingerprint = /^a=fingerprint:(sha-(?:1|224|256|384|512)) ([A-Fa-f0-9:]+)\r?$/m.exec(answerSdp);
					if (!fingerprint || binding.dtlsFingerprint !== `${fingerprint[1].toLowerCase()} ${fingerprint[2].toUpperCase()}`) {
						throw new Error("DTLS fingerprint mismatch");
					}
					const unsignedPayload = [
						"pipane-backend-binding-v1",
						binding.backendId,
						binding.publicKey,
						binding.connectionId,
						binding.offerSha256,
						binding.answerSha256,
						binding.dtlsFingerprint,
						String(binding.expiresAt),
					].join("\n");
					const backendKey = await crypto.subtle.importKey("spki", backendKeyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
					if (!await crypto.subtle.verify(
						{ name: "ECDSA", hash: "SHA-256" },
						backendKey,
						decode(binding.signature),
						new TextEncoder().encode(unsignedPayload),
					)) throw new Error("Backend binding signature failed");
					await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
					remoteSet = true;
					for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
				};

				peer.onicecandidate = (event) => {
					if (!event.candidate) return;
					const candidate = event.candidate.toJSON();
					if (candidate.candidate?.includes(" typ relay ")) sawRelayCandidate = true;
					send({
						type: "signal",
						connectionId,
						signal: {
							kind: "candidate",
							candidate: candidate.candidate,
							sdpMid: candidate.sdpMid,
							sdpMLineIndex: candidate.sdpMLineIndex,
						},
					});
				};
				channel.onopen = () => {
					void (async () => {
						const proofPayload = `pipane-device-connection-v1\n${authorization.ticket}\n${binding.signature}`;
						const deviceSignature = encode(await crypto.subtle.sign(
							{ name: "ECDSA", hash: "SHA-256" },
							privateKey,
							new TextEncoder().encode(proofPayload),
						));
						channel.send(JSON.stringify({
							protocolVersion: 1,
							type: "authenticate",
							ticket: authorization.ticket,
							bindingSignature: binding.signature,
							deviceSignature,
							pairingSecret: options.secret,
						}));
					})().catch(fail);
				};
				channel.onmessage = (event) => {
					const value = String(event.data);
					if (!authenticated) {
						const message = JSON.parse(value);
						if (message.type !== "authenticated") {
							fail(new Error(message.message || "Authentication failed"));
							return;
						}
						authenticated = message;
						channel.send("ping");
						return;
					}
					reply = value;
					revocationStarted = true;
					void (async () => {
						const response = await fetch("/v1/auth/challenges", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								purpose: "revoke_device",
								deviceId,
								backendId: options.backendId,
								targetDeviceId: deviceId,
							}),
						});
						if (!response.ok) throw new Error(await response.text());
						const revokeChallenge = await response.json();
						const revokePayload = [
							"pipane-device-challenge-v1",
							revokeChallenge.challengeId,
							revokeChallenge.nonce,
							revokeChallenge.purpose,
							revokeChallenge.deviceId,
							revokeChallenge.devicePublicKey,
							revokeChallenge.backendId || "",
							revokeChallenge.connectionId || "",
							revokeChallenge.pairId || "",
							revokeChallenge.targetDeviceId || "",
							String(revokeChallenge.expiresAt),
						].join("\n");
						const revokeSignature = encode(await crypto.subtle.sign(
							{ name: "ECDSA", hash: "SHA-256" },
							privateKey,
							new TextEncoder().encode(revokePayload),
						));
						const revokeResponse = await fetch("/v1/revocations/devices", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ challengeId: revokeChallenge.challengeId, signature: revokeSignature }),
						});
						if (!revokeResponse.ok) throw new Error(await revokeResponse.text());
					})().catch(fail);
				};
				channel.onclose = () => {
					if (!revocationStarted) {
						fail(new Error("DataChannel closed before revocation"));
						return;
					}
					channelClosed = true;
					finishIfRevoked();
				};
				channel.onerror = () => {
					if (!revocationStarted) fail(new Error("DataChannel failed"));
				};
				socket.onerror = () => fail(new Error("Rendezvous WebSocket failed"));
				socket.onopen = () => send({ type: "connect_backend", backendId: options.backendId, ticket: authorization.ticket });
				socket.onmessage = (event) => {
					void (async () => {
						const message = JSON.parse(String(event.data));
						if (message.type === "connection_closed" && revocationStarted) {
							routeClosed = true;
							finishIfRevoked();
							return;
						}
						if (message.type === "error" || message.type === "connection_closed") throw new Error(message.message || message.reason);
						if (message.type === "backend_connected") {
							const offer = await peer.createOffer();
							offerSdp = offer.sdp || "";
							await peer.setLocalDescription(offer);
							send({ type: "signal", connectionId, signal: { kind: "description", type: "offer", sdp: offerSdp } });
							return;
						}
						if (message.type === "connection_binding") {
							binding = message.binding;
							await applyAnswer();
							return;
						}
						if (message.type !== "signal") return;
						if (message.signal.kind === "description") {
							answerSdp = message.signal.sdp;
							await applyAnswer();
						} else {
							if (message.signal.candidate.includes(" typ relay ")) sawRemoteRelayCandidate = true;
							const candidate = {
								candidate: message.signal.candidate,
								sdpMid: message.signal.sdpMid,
								sdpMLineIndex: message.signal.sdpMLineIndex,
							};
							if (remoteSet) await peer.addIceCandidate(candidate);
							else pendingCandidates.push(candidate);
						}
					})().catch(fail);
				};
			});
		}, {
			wsUrl: rendezvousWebSocketUrl(baseUrl, "browser"),
			backendId: identity.backendId,
			pairId: pairing.pairId,
			secret: pairing.secret,
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			label: PIPANE_DATA_CHANNEL_LABEL,
			protocol: PIPANE_DATA_CHANNEL_PROTOCOL,
		});

		expect(result).toEqual({
			reply: "pong",
			ordered: true,
			privateKeyExtractable: false,
			backendIdentityVerified: true,
			accountId: expect.stringMatching(/^a_/),
			deviceId: expect.stringMatching(/^d_/),
			revoked: true,
			forcedTurn: true,
		});
		expect(backendTrust.ownerAccountId).toBe(result.accountId);
		expect(rendezvous.trustStore.getBackendOwner(identity.backendId)).toBe(result.accountId);

		// Exercise the packaged zero-signup QR landing page with a second browser identity.
		const qrPairing = backendTrust.createPairing();
		await signaling.openPairing(qrPairing.pairId, qrPairing.expiresAt);
		const qrUrl = new URL(`${baseUrl}/pair/${encodeURIComponent(qrPairing.pairId)}`);
		qrUrl.hash = new URLSearchParams({ backend: identity.backendId, secret: qrPairing.secret }).toString();
		await page.goto(qrUrl.toString());
		await expect(page.locator("[data-testid='pairing-status']")).toContainText("Paired successfully", { timeout: 10_000 });
		expect(new URL(page.url()).pathname).toBe(`/backend/${identity.backendId}`);
		expect(new URL(page.url()).hash).toBe("");

		// Pair a second backend with the existing browser device/account, then
		// exercise discovery, semantic v2 requests, and product-level switching.
		const secondIdentity = loadOrCreateBackendIdentity(path.join(dir, "identity-second.json"));
		const secondTrust = new BackendTrustStore({ filePath: path.join(dir, "backend-trust-second.json") });
		const secondPairing = secondTrust.createPairing();
		secondSignaling = new BackendRendezvousClient({
			url: baseUrl,
			identity: secondIdentity,
			metadata: { name: "Second backend", softwareVersion: "test", protocolVersions: [1, 2] },
		});
		await secondSignaling.start();
		await secondSignaling.openPairing(secondPairing.pairId, secondPairing.expiresAt);
		const secondAuthorizer = new BackendConnectionAuthorizer(secondTrust, secondSignaling);
		secondPeers = new BackendWebRtcManager({
			signaling: secondSignaling,
			identity: secondIdentity,
			ticketPublicKey: () => secondSignaling!.ticketPublicKey,
			authorize: (context) => secondAuthorizer.authorize(context),
			iceTransportPolicy: "relay",
			bindAddress: "127.0.0.1",
		});
		attachTestBackendProtocols(secondPeers, secondIdentity.backendId, "second-project");
		const secondQrUrl = new URL(`${baseUrl}/pair/${encodeURIComponent(secondPairing.pairId)}`);
		secondQrUrl.hash = new URLSearchParams({ backend: secondIdentity.backendId, secret: secondPairing.secret }).toString();
		await page.goto(secondQrUrl.toString());
		await expect(page.locator("[data-testid='pairing-status']")).toContainText("Paired successfully", { timeout: 10_000 });

		await page.goto(baseUrl);
		await expect(page.locator("session-picker .host-row[data-backend-id]")).toHaveCount(2, { timeout: 15_000 });
		await expect(page.locator("session-picker .host-name")).toHaveText(["First backend", "Second backend"]);
		await expect(page.locator("session-picker .group-label")).toHaveText([
			"First backend / first-project",
			"Second backend / second-project",
		]);
		await expect(page.locator("message-editor")).toBeVisible();
		await expect(page.locator("[data-testid='backend-switcher']")).toHaveCount(0);

		const firstHost = page.locator(`session-picker .host-row[data-backend-id='${identity.backendId}']`);
		await firstHost.locator("[aria-label^='Manage']").click();
		await page.getByRole("button", { name: "Add another device" }).click();
		const inviteDialog = page.locator("[data-testid='device-invite-dialog']");
		await expect(inviteDialog.locator("[data-testid='device-invite-create-status']")).toContainText("expires in 10:");
		await expect(inviteDialog.locator("[data-testid='device-invite-qr']")).toBeVisible();
		const inviteUrl = await inviteDialog.locator("[data-testid='device-invite-link']").inputValue();
		expect(new URL(inviteUrl).hash).toContain("secret=");

		invitedContext = await browser.newContext();
		const invitedPage = await invitedContext.newPage();
		await invitedPage.goto(inviteUrl);
		await expect(invitedPage.locator("[data-testid='device-invite-status']")).toContainText("Device added");
		expect(new URL(invitedPage.url()).hash).toBe("");
		await invitedPage.goto(baseUrl);
		await expect(invitedPage.locator("session-picker .host-row[data-backend-id]")).toHaveCount(2, { timeout: 30_000 });
		await expect(invitedPage.locator("session-picker .host-name")).toHaveText(["First backend", "Second backend"]);
		await invitedContext.close();
		invitedContext = undefined;
		await inviteDialog.locator("[aria-label='Close device invite']").click();

		await firstHost.locator(".host-status").click();
		const diagnosticsDialog = page.locator("[data-testid='connection-diagnostics']");
		await expect(diagnosticsDialog).toContainText(/TURN relay|Direct via STUN/u, { timeout: 10_000 });
		await expect(diagnosticsDialog).toContainText("Pipane traffic");
		await expect(diagnosticsDialog).toContainText(turn.url);
		await diagnosticsDialog.locator("[aria-label='Close connection diagnostics']").click();

		const secondHost = page.locator(`session-picker .host-row[data-backend-id='${secondIdentity.backendId}']`);
		const secondProject = page.locator(`session-picker .project-group[data-backend-id='${secondIdentity.backendId}']`);
		await secondProject.locator(".session-item").click();
		await expect(secondHost).toHaveClass(/active/u);
		await expect(secondProject.locator(".session-item")).toHaveClass(/active/u);
		await expect(page).toHaveURL(baseUrl + "/");
		expect(secondTrust.ownerAccountId).toBe(result.accountId);
	} finally {
		await invitedContext?.close();
		secondPeers?.close();
		secondSignaling?.stop();
		peers?.close();
		signaling.stop();
		await rendezvous.close();
		await turn.close();
		nodeDataChannel.cleanup();
		await rm(dir, { recursive: true, force: true });
	}
});

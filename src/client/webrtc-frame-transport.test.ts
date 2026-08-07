import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IceSignal } from "../shared/rendezvous-protocol.js";
import {
	DataChannelFrameDecoder,
	MAX_DATA_CHANNEL_MESSAGE_BYTES,
	encodeDataChannelFrame,
} from "../shared/data-channel-framing.js";
import type { BackendIdentityBinding, ConnectionTicketClaims, IceServerConfiguration } from "../shared/trust-protocol.js";
import { loadOrCreateBackendIdentity, signBackendIdentityBinding } from "../server/backend-identity.js";
import { generateBrowserDeviceIdentity } from "./device-identity.js";
import type { BrowserRendezvousClient } from "./browser-rendezvous-client.js";
import { WebRtcFrameTransport } from "./webrtc-frame-transport.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeChannel {
	readyState: RTCDataChannelState = "connecting";
	ordered = true;
	onopen: ((event: Event) => unknown) | null = null;
	onclose: ((event: Event) => unknown) | null = null;
	onerror: ((event: Event) => unknown) | null = null;
	onmessage: ((event: MessageEvent) => unknown) | null = null;
	onbufferedamountlow: ((event: Event) => unknown) | null = null;
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	sent: string[] = [];

	send(value: string): void {
		this.sent.push(value);
	}

	close(): void {
		this.readyState = "closed";
	}

	open(): void {
		this.readyState = "open";
		this.onopen?.(new Event("open"));
	}

	receive(value: string): void {
		this.onmessage?.(new MessageEvent("message", { data: value }));
	}

	remoteClose(): void {
		this.readyState = "closed";
		this.onclose?.(new Event("close"));
	}
}

class FakePeer {
	connectionState: RTCPeerConnectionState = "new";
	iceConnectionState: RTCIceConnectionState = "connected";
	iceGatheringState: RTCIceGatheringState = "complete";
	signalingState: RTCSignalingState = "stable";
	readonly sctp = { maxMessageSize: 262_144, transport: { state: "connected" as RTCDtlsTransportState } };
	onicecandidate: ((event: RTCPeerConnectionIceEvent) => unknown) | null = null;
	oniceconnectionstatechange: ((event: Event) => unknown) | null = null;
	onconnectionstatechange: ((event: Event) => unknown) | null = null;
	readonly channel = new FakeChannel();
	readonly setLocalDescription = vi.fn(async () => {});
	readonly setRemoteDescription = vi.fn(async () => {});
	readonly addIceCandidate = vi.fn(async () => {});
	readonly createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\na=setup:actpass\r\n" }));
	readonly getStats = vi.fn(async () => new Map<string, any>([
		["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair", dtlsState: "connected" }],
		["pair", {
			id: "pair",
			type: "candidate-pair",
			state: "succeeded",
			nominated: true,
			localCandidateId: "local",
			remoteCandidateId: "remote",
			currentRoundTripTime: 0.012,
			availableOutgoingBitrate: 2_500_000,
			bytesSent: 4_096,
			bytesReceived: 8_192,
		}],
		["local", {
			id: "local",
			type: "local-candidate",
			address: "203.0.113.10",
			port: 51_234,
			protocol: "udp",
			candidateType: "srflx",
			relatedAddress: "192.168.1.5",
			relatedPort: 51_234,
			url: "stun:stun.example:3478",
		}],
		["remote", {
			id: "remote",
			type: "remote-candidate",
			address: "198.51.100.8",
			port: 49_000,
			protocol: "udp",
			candidateType: "host",
		}],
		["data", { id: "data", type: "data-channel", messagesSent: 3, messagesReceived: 4, bytesSent: 500, bytesReceived: 900 }],
	]) as unknown as RTCStatsReport);
	readonly close = vi.fn(() => { this.connectionState = "closed"; });

	createDataChannel(): RTCDataChannel {
		return this.channel as unknown as RTCDataChannel;
	}
}

class FakeRendezvous {
	private signalListener?: (signal: IceSignal) => void;
	private bindingListener?: (binding: BackendIdentityBinding) => void;
	readonly sendSignal = vi.fn();
	readonly close = vi.fn();

	constructor(private readonly connectionId: string) {}
	connect(): Promise<string> { return Promise.resolve(this.connectionId); }
	onSignal(listener: (signal: IceSignal) => void): () => void { this.signalListener = listener; return () => {}; }
	onIdentityBinding(listener: (binding: BackendIdentityBinding) => void): () => void { this.bindingListener = listener; return () => {}; }
	onConnectionClosed(): () => void { return () => {}; }
	onError(): () => void { return () => {}; }
	emitSignal(signal: IceSignal): void { this.signalListener?.(signal); }
	emitBinding(binding: BackendIdentityBinding): void { this.bindingListener?.(binding); }
}

function encodeClaims(claims: ConnectionTicketClaims): string {
	return `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.central-signature`;
}

describe("WebRtcFrameTransport", () => {
	it("coalesces connection calls and authenticates before exposing v1 frames", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pipane-transport-test-"));
		cleanupDirs.push(dir);
		const backend = loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
		const device = await generateBrowserDeviceIdentity();
		const connectionId = "c_transport";
		const expiresAt = Date.now() + 60_000;
		const ticket = encodeClaims({
			version: 1,
			kind: "pairing",
			ticketId: "t_transport",
			backendId: backend.backendId,
			connectionId,
			deviceId: device.deviceId,
			devicePublicKey: device.publicKey,
			pairId: "pair_transport",
			issuedAt: Date.now(),
			expiresAt,
		});
		const peer = new FakePeer();
		const rendezvous = new FakeRendezvous(connectionId);
		const authorize = vi.fn(async () => ({ ticket, iceServers: [{ urls: ["stun:stun.example:3478"] }], pairingSecret: "secret" }));
		const transport = new WebRtcFrameTransport({
			rendezvousUrl: "https://signal.example",
			backendId: backend.backendId,
			deviceIdentity: device,
			authorize,
			createPeerConnection: () => peer as unknown as RTCPeerConnection,
			createRendezvousClient: () => rendezvous as unknown as BrowserRendezvousClient,
		});
		const connecting = transport.connect("unused");
		expect(transport.connect("unused")).toBe(connecting);
		expect(authorize).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(rendezvous.sendSignal).toHaveBeenCalledWith(expect.objectContaining({
			kind: "description",
			type: "offer",
		})));
		const offerSdp = "v=0\r\na=setup:actpass\r\n";
		const answerSdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n";
		const binding = signBackendIdentityBinding(backend, { connectionId, offerSdp, answerSdp, expiresAt });
		rendezvous.emitSignal({ kind: "description", type: "answer", sdp: answerSdp });
		rendezvous.emitBinding(binding);
		await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
		peer.channel.open();
		await vi.waitFor(() => expect(peer.channel.sent).toHaveLength(1));
		const authentication = JSON.parse(peer.channel.sent[0]);
		expect(authentication).toEqual(expect.objectContaining({
			type: "authenticate",
			ticket,
			bindingSignature: binding.signature,
			pairingSecret: "secret",
			deviceSignature: expect.any(String),
		}));
		peer.channel.receive(JSON.stringify({ protocolVersion: 1, type: "authenticated", accountId: "a_owner", deviceId: device.deviceId }));
		await expect(connecting).resolves.toBeUndefined();
		expect(transport.isConnected).toBe(true);

		const frame = vi.fn();
		transport.onFrame(frame);
		peer.channel.receive("server-frame");
		expect(frame).toHaveBeenCalledWith("server-frame");
		transport.send("client-frame");
		expect(peer.channel.sent.at(-1)).toBe("client-frame");

		frame.mockClear();
		const largeServerFrame = JSON.stringify({ type: "session_sync", content: "remote history 🙂 ".repeat(20_000) });
		for (const chunk of encodeDataChannelFrame(largeServerFrame, "server_large")) peer.channel.receive(chunk);
		expect(frame).toHaveBeenCalledTimes(1);
		expect(frame).toHaveBeenCalledWith(largeServerFrame);

		const sentBeforeLargeFrame = peer.channel.sent.length;
		const largeClientFrame = JSON.stringify({ v: 2, kind: "request", content: "upload data ".repeat(20_000) });
		transport.send(largeClientFrame);
		const clientChunks = peer.channel.sent.slice(sentBeforeLargeFrame);
		expect(clientChunks.length).toBeGreaterThan(1);
		expect(clientChunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= MAX_DATA_CHANNEL_MESSAGE_BYTES)).toBe(true);
		const decoder = new DataChannelFrameDecoder();
		let decoded: string | undefined;
		for (const chunk of clientChunks) decoded = decoder.accept(chunk) ?? decoded;
		expect(decoded).toBe(largeClientFrame);

		peer.connectionState = "connected";
		const diagnostics = await transport.getConnectionDiagnostics();
		expect(diagnostics).toEqual(expect.objectContaining({
			backendId: backend.backendId,
			connectionState: "connected",
			iceConnectionState: "connected",
			icePath: "direct-stun",
			iceServerUrls: ["stun:stun.example:3478"],
			selectedPair: expect.objectContaining({
				currentRoundTripTimeMs: 12,
				local: expect.objectContaining({ candidateType: "srflx", address: "203.0.113.10" }),
				remote: expect.objectContaining({ candidateType: "host", address: "198.51.100.8" }),
			}),
			dataChannel: expect.objectContaining({ maxMessageSize: 262_144, messagesSent: 3, bytesReceived: 900 }),
		}));
		expect(diagnostics.signalingUrl).toBe("wss://signal.example/v2/rendezvous/browser");
		transport.close();
	});

	it("obtains a fresh ticket after an established carrier disconnects", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pipane-reconnect-test-"));
		cleanupDirs.push(dir);
		const backend = loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
		const device = await generateBrowserDeviceIdentity();
		const expiresAt = Date.now() + 60_000;
		const claims: ConnectionTicketClaims = {
			version: 1,
			kind: "connection",
			ticketId: "t_reconnect",
			backendId: backend.backendId,
			connectionId: "c_reconnect",
			deviceId: device.deviceId,
			devicePublicKey: device.publicKey,
			accountId: "a_owner",
			issuedAt: Date.now(),
			expiresAt,
		};
		const peer = new FakePeer();
		const rendezvous = new FakeRendezvous(claims.connectionId);
		const authorize = vi.fn(async () => ({ ticket: encodeClaims(claims), iceServers: [] }));
		let reconnect: (() => void) | undefined;
		const transport = new WebRtcFrameTransport({
			rendezvousUrl: "https://signal.example",
			backendId: backend.backendId,
			deviceIdentity: device,
			authorize,
			createPeerConnection: () => peer as unknown as RTCPeerConnection,
			createRendezvousClient: () => rendezvous as unknown as BrowserRendezvousClient,
			schedule: (callback) => {
				reconnect = callback;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
		});
		const connecting = transport.connect("webrtc");
		await vi.waitFor(() => expect(rendezvous.sendSignal).toHaveBeenCalled());
		const offerSdp = "v=0\r\na=setup:actpass\r\n";
		const answerSdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n";
		rendezvous.emitSignal({ kind: "description", type: "answer", sdp: answerSdp });
		rendezvous.emitBinding(signBackendIdentityBinding(backend, { connectionId: claims.connectionId, offerSdp, answerSdp, expiresAt }));
		await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
		peer.channel.open();
		await vi.waitFor(() => expect(peer.channel.sent).toHaveLength(1));
		peer.channel.receive(JSON.stringify({ protocolVersion: 1, type: "authenticated", accountId: "a_owner", deviceId: device.deviceId }));
		await connecting;

		peer.channel.remoteClose();
		expect(transport.isReconnecting).toBe(true);
		await vi.waitFor(async () => expect((await transport.getConnectionDiagnostics()).lastDisconnect)
			.toEqual(expect.objectContaining({
				occurredAt: expect.any(String),
				failure: expect.objectContaining({
					code: "datachannel",
					message: "Established WebRTC DataChannel closed",
				}),
				snapshot: expect.objectContaining({ icePath: "direct-stun" }),
			})));
		reconnect?.();
		await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
		expect((await transport.getConnectionDiagnostics()).lastDisconnect?.failure.code).toBe("datachannel");
		transport.close();
	});

	it("classifies an ICE path failure and retains sanitized failed-attempt diagnostics", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pipane-ice-failure-test-"));
		cleanupDirs.push(dir);
		const backend = loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
		const device = await generateBrowserDeviceIdentity();
		const claims: ConnectionTicketClaims = {
			version: 1,
			kind: "connection",
			ticketId: "t_ice_failure",
			backendId: backend.backendId,
			connectionId: "c_ice_failure",
			deviceId: device.deviceId,
			devicePublicKey: device.publicKey,
			accountId: "a_owner",
			issuedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		};
		const peer = new FakePeer();
		const rendezvous = new FakeRendezvous(claims.connectionId);
		const supplementalIceServers = [{
			urls: ["turn:turn.example:3478?transport=udp"],
			username: "temporary-user",
			credential: "temporary-password",
		}];
		const createPeerConnection = vi.fn((_configuration: RTCConfiguration) => peer as unknown as RTCPeerConnection);
		const createRendezvousClient = vi.fn((_ticket: string, _servers: IceServerConfiguration[]) => rendezvous as unknown as BrowserRendezvousClient);
		const transport = new WebRtcFrameTransport({
			rendezvousUrl: "https://signal.example",
			backendId: backend.backendId,
			deviceIdentity: device,
			authorize: async () => ({
				ticket: encodeClaims(claims),
				iceServers: [{ urls: "stun:stun.example:3478" }],
				supplementalIceServers,
			}),
			createPeerConnection,
			createRendezvousClient,
			connectionTimeoutMs: 60_000,
		});
		const connecting = transport.connect("webrtc");
		await vi.waitFor(() => expect(rendezvous.sendSignal).toHaveBeenCalled());
		expect(createPeerConnection).toHaveBeenCalledWith(expect.objectContaining({
			iceServers: [{ urls: "stun:stun.example:3478" }, ...supplementalIceServers],
		}));
		expect(createRendezvousClient).toHaveBeenCalledWith(expect.any(String), supplementalIceServers);
		peer.iceConnectionState = "failed";
		peer.oniceconnectionstatechange?.(new Event("iceconnectionstatechange"));
		await expect(connecting).rejects.toEqual(expect.objectContaining({ code: "ice", turnRecommended: true }));
		const diagnostics = await transport.getConnectionDiagnostics();
		expect(diagnostics.failure).toEqual(expect.objectContaining({ code: "ice", turnRecommended: true }));
		expect(diagnostics.iceServerUrls).toContain("turn:turn.example:3478?transport=udp");
		expect(JSON.stringify(diagnostics)).not.toContain("temporary-password");
	});

	it("retains relay-configuration failures that happen before peer creation", async () => {
		const device = await generateBrowserDeviceIdentity();
		const configurationError = Object.assign(new Error("Metered rejected the TURN API key"), {
			code: "relay_configuration" as const,
			turnRecommended: false,
		});
		const transport = new WebRtcFrameTransport({
			rendezvousUrl: "https://signal.example",
			backendId: "b_expected",
			deviceIdentity: device,
			authorize: async () => { throw configurationError; },
		});
		await expect(transport.connect("unused")).rejects.toBe(configurationError);
		await expect(transport.getConnectionDiagnostics()).resolves.toEqual(expect.objectContaining({
			failure: expect.objectContaining({ code: "relay_configuration", turnRecommended: false }),
		}));
	});

	it("rejects a ticket for another browser before creating a peer", async () => {
		const device = await generateBrowserDeviceIdentity();
		const claims: ConnectionTicketClaims = {
			version: 1,
			kind: "connection",
			ticketId: "t_wrong",
			backendId: "b_expected",
			connectionId: "c_wrong",
			deviceId: "d_other",
			devicePublicKey: "other-key",
			accountId: "a_owner",
			issuedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		};
		const createPeerConnection = vi.fn();
		const transport = new WebRtcFrameTransport({
			rendezvousUrl: "https://signal.example",
			backendId: "b_expected",
			deviceIdentity: device,
			authorize: async () => ({ ticket: encodeClaims(claims), iceServers: [] }),
			createPeerConnection,
		});
		await expect(transport.connect("unused")).rejects.toThrow("does not match");
		expect(createPeerConnection).not.toHaveBeenCalled();
	});
});

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
import type { BackendIdentityBinding, ConnectionTicketClaims } from "../shared/trust-protocol.js";
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
	onicecandidate: ((event: RTCPeerConnectionIceEvent) => unknown) | null = null;
	onconnectionstatechange: ((event: Event) => unknown) | null = null;
	readonly channel = new FakeChannel();
	readonly setLocalDescription = vi.fn(async () => {});
	readonly setRemoteDescription = vi.fn(async () => {});
	readonly addIceCandidate = vi.fn(async () => {});
	readonly createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\na=setup:actpass\r\n" }));
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
	it("verifies backend binding and authenticates before exposing v1 frames", async () => {
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
		const transport = new WebRtcFrameTransport({
			rendezvousUrl: "https://signal.example",
			backendId: backend.backendId,
			deviceIdentity: device,
			authorize: async () => ({ ticket, iceServers: [], pairingSecret: "secret" }),
			createPeerConnection: () => peer as unknown as RTCPeerConnection,
			createRendezvousClient: () => rendezvous as unknown as BrowserRendezvousClient,
		});
		const connecting = transport.connect("unused");
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
		reconnect?.();
		await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
		transport.close();
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

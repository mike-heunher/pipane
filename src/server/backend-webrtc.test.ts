// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IceSignal } from "../shared/rendezvous-protocol.js";
import { deviceChallengePayload, type DeviceChallenge } from "../shared/trust-protocol.js";
import { RendezvousTrustStore } from "../rendezvous/trust-store.js";
import {
	BackendWebRtcManager,
	PIPANE_DATA_CHANNEL_LABEL,
	PIPANE_DATA_CHANNEL_PROTOCOL,
	type BackendSignalingClient,
} from "./backend-webrtc.js";
import { loadOrCreateBackendIdentity } from "./backend-identity.js";
import type { BackendConnectionRequest } from "./rendezvous-client.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeSignaling implements BackendSignalingClient {
	private connectionListener?: (request: BackendConnectionRequest) => void;
	private signalListener?: (connectionId: string, signal: IceSignal) => void;
	private closedListener?: (connectionId: string, reason: string) => void;
	readonly sendSignal = vi.fn();
	readonly sendIdentityBinding = vi.fn();
	readonly closeConnection = vi.fn();

	onConnectionRequest(listener: (request: BackendConnectionRequest) => void): () => void {
		this.connectionListener = listener;
		return () => { this.connectionListener = undefined; };
	}

	onSignal(listener: (connectionId: string, signal: IceSignal) => void): () => void {
		this.signalListener = listener;
		return () => { this.signalListener = undefined; };
	}

	onConnectionClosed(listener: (connectionId: string, reason: string) => void): () => void {
		this.closedListener = listener;
		return () => { this.closedListener = undefined; };
	}

	request(request: BackendConnectionRequest): void {
		this.connectionListener?.(request);
	}

	signal(connectionId: string, signal: IceSignal): void {
		this.signalListener?.(connectionId, signal);
	}

	close(connectionId: string, reason: string): void {
		this.closedListener?.(connectionId, reason);
	}
}

function setup(connectionId = "connection") {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-webrtc-unit-"));
	cleanupDirs.push(dir);
	const identity = loadOrCreateBackendIdentity(path.join(dir, "backend.json"));
	const trust = new RendezvousTrustStore({ dataDir: path.join(dir, "rendezvous") });
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const devicePublicKey = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url");
	const challenge = trust.createChallenge({
		purpose: "pair",
		devicePublicKey,
		backendId: identity.backendId,
		connectionId,
		pairId: "pair_unit",
	});
	const signature = sign("sha256", Buffer.from(deviceChallengePayload(challenge as DeviceChallenge)), {
		key: privateKey,
		dsaEncoding: "ieee-p1363",
	}).toString("base64url");
	const issued = trust.issuePairingTicket(challenge.challengeId, signature);
	const signaling = new FakeSignaling();
	const manager = new BackendWebRtcManager({
		signaling,
		identity,
		ticketPublicKey: () => trust.ticketPublicKey,
		authorize: async ({ claims }) => ({ accountId: "a_owner", deviceId: claims.deviceId }),
	});
	return { identity, trust, signaling, manager, request: { connectionId, ticket: issued.ticket, iceServers: [] } };
}

describe("BackendWebRtcManager", () => {
	it("rejects signals for unknown connections", () => {
		const { signaling, manager } = setup();
		signaling.signal("missing", { kind: "description", type: "offer", sdp: "v=0" });
		expect(signaling.closeConnection).toHaveBeenCalledWith("missing", "Unknown backend WebRTC connection");
		manager.close();
	});

	it("rejects malformed tickets before allocating a peer", () => {
		const { signaling, manager } = setup();
		signaling.request({ connectionId: "bad", ticket: "malformed", iceServers: [] });
		expect(signaling.closeConnection).toHaveBeenCalledWith("bad", "Malformed connection ticket");
		manager.close();
	});

	it("serializes negotiation failures and closes their peer", async () => {
		const { signaling, manager, request } = setup();
		const error = new Promise<Error>((resolve) => manager.onError((_connectionId, value) => resolve(value)));
		signaling.request(request);
		signaling.signal(request.connectionId, { kind: "description", type: "answer", sdp: "v=0" });
		expect((await error).message).toContain("expected an offer");
		expect(signaling.closeConnection).toHaveBeenCalledWith(request.connectionId, "WebRTC negotiation failed");
		signaling.close(request.connectionId, "done");
		manager.close();
	});

	it("publishes the required ordered application channel identity", () => {
		expect(PIPANE_DATA_CHANNEL_LABEL).toBe("pipane");
		expect(PIPANE_DATA_CHANNEL_PROTOCOL).toBe("pipane.v1");
	});
});

// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deviceChallengePayload, type DeviceChallenge } from "../shared/trust-protocol.js";
import {
	IceServerProvider,
	RendezvousTrustStore,
	deriveDeviceId,
} from "./trust-store.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createStore(now = Date.now()) {
	const dataDir = mkdtempSync(path.join(tmpdir(), "pipane-trust-test-"));
	cleanupDirs.push(dataDir);
	return {
		dataDir,
		store: new RendezvousTrustStore({ dataDir, now: () => now }),
	};
}

function createDevice() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const encodedPublicKey = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url");
	return {
		privateKey,
		publicKey: encodedPublicKey,
		deviceId: deriveDeviceId(encodedPublicKey),
		signChallenge(challenge: DeviceChallenge): string {
			return sign("sha256", Buffer.from(deviceChallengePayload(challenge)), {
				key: privateKey,
				dsaEncoding: "ieee-p1363",
			}).toString("base64url");
		},
	};
}

function pairDevice(store: RendezvousTrustStore, device = createDevice(), backendId = "b_backend", pairId = "pair_one") {
	const challenge = store.createChallenge({
		purpose: "pair",
		devicePublicKey: device.publicKey,
		backendId,
		connectionId: `c_${pairId}`,
		pairId,
	});
	const issued = store.issuePairingTicket(challenge.challengeId, device.signChallenge(challenge));
	store.consumeRouteTicket(issued.ticket);
	const confirmation = store.confirmPairing(issued.claims);
	return { device, issued, confirmation };
}

describe("RendezvousTrustStore", () => {
	it("creates an anonymous account only after backend-confirmed first pairing", () => {
		const { dataDir, store } = createStore(10_000);
		const device = createDevice();
		const challenge = store.createChallenge({
			purpose: "pair",
			devicePublicKey: device.publicKey,
			backendId: "b_backend",
			connectionId: "c_first",
			pairId: "pair_first",
		});
		const issued = store.issuePairingTicket(challenge.challengeId, device.signChallenge(challenge));
		expect(issued.claims).toEqual(expect.objectContaining({
			kind: "pairing",
			deviceId: device.deviceId,
			backendId: "b_backend",
			connectionId: "c_first",
			pairId: "pair_first",
		}));
		expect(issued.claims.accountId).toBeUndefined();
		expect(store.getBackendOwner("b_backend")).toBeUndefined();

		store.consumeRouteTicket(issued.ticket);
		const confirmation = store.confirmPairing(issued.claims);
		expect(confirmation.accountId).toMatch(/^a_/);
		expect(store.getBackendOwner("b_backend")).toBe(confirmation.accountId);
		expect(store.isDeviceActive(device.deviceId)).toBe(true);
		expect(statSync(path.join(dataDir, "ticket-identity.json")).mode & 0o777).toBe(0o600);
		expect(statSync(path.join(dataDir, "trust-store.json")).mode & 0o777).toBe(0o600);
	});

	it("issues account-scoped tickets, persists identity, and rejects replay", () => {
		const { dataDir, store } = createStore(20_000);
		const { device, confirmation } = pairDevice(store);
		const challenge = store.createChallenge({
			purpose: "connect",
			deviceId: device.deviceId,
			backendId: "b_backend",
			connectionId: "c_again",
		});
		const issued = store.issueConnectionTicket(challenge.challengeId, device.signChallenge(challenge));
		expect(issued.claims.accountId).toBe(confirmation.accountId);
		expect(store.consumeRouteTicket(issued.ticket)).toEqual(issued.claims);
		expect(() => store.consumeRouteTicket(issued.ticket)).toThrow("already used");

		const reloaded = new RendezvousTrustStore({ dataDir, now: () => 20_000 });
		expect(reloaded.ticketPublicKey).toBe(store.ticketPublicKey);
		expect(reloaded.getBackendOwner("b_backend")).toBe(confirmation.accountId);
		expect(() => reloaded.consumeRouteTicket(issued.ticket)).toThrow("already used");
	});

	it("adds devices and backends to one account while rejecting ownership conflicts", () => {
		const { store } = createStore(30_000);
		const first = pairDevice(store);
		const secondDevice = createDevice();
		const secondPair = pairDevice(store, secondDevice, "b_backend", "pair_second_device");
		expect(secondPair.confirmation.accountId).toBe(first.confirmation.accountId);

		const addBackendChallenge = store.createChallenge({
			purpose: "pair",
			deviceId: first.device.deviceId,
			backendId: "b_second",
			connectionId: "c_second_backend",
			pairId: "pair_second_backend",
		});
		const addBackend = store.issuePairingTicket(addBackendChallenge.challengeId, first.device.signChallenge(addBackendChallenge));
		expect(store.confirmPairing(addBackend.claims).accountId).toBe(first.confirmation.accountId);
		expect(store.getBackendOwner("b_second")).toBe(first.confirmation.accountId);
		const discovery = store.createChallenge({ purpose: "discover", deviceId: first.device.deviceId });
		expect(store.listAuthorizedBackendIds(discovery.challengeId, first.device.signChallenge(discovery)).sort()).toEqual([
			"b_backend",
			"b_second",
		]);

		const stranger = createDevice();
		const strangerPair = pairDevice(store, stranger, "b_stranger", "pair_stranger");
		const conflictChallenge = store.createChallenge({
			purpose: "pair",
			deviceId: stranger.deviceId,
			backendId: "b_backend",
			connectionId: "c_conflict",
			pairId: "pair_conflict",
		});
		const conflict = store.issuePairingTicket(conflictChallenge.challengeId, stranger.signChallenge(conflictChallenge));
		expect(strangerPair.confirmation.accountId).not.toBe(first.confirmation.accountId);
		expect(() => store.confirmPairing(conflict.claims)).toThrow("another account");
	});

	it("creates a ten-minute one-use invite that adds a new device to the same backend account", () => {
		const { dataDir, store } = createStore(35_000);
		const first = pairDevice(store);
		const addBackendChallenge = store.createChallenge({
			purpose: "pair",
			deviceId: first.device.deviceId,
			backendId: "b_second",
			connectionId: "c_second",
			pairId: "pair_second_backend",
		});
		const addBackend = store.issuePairingTicket(
			addBackendChallenge.challengeId,
			first.device.signChallenge(addBackendChallenge),
		);
		store.confirmPairing(addBackend.claims);

		const createChallenge = store.createChallenge({
			purpose: "create_device_invite",
			deviceId: first.device.deviceId,
		});
		const invite = store.createDeviceInvite(createChallenge.challengeId, first.device.signChallenge(createChallenge));
		expect(invite.expiresAt).toBe(35_000 + 10 * 60_000);
		expect(readFileSync(path.join(dataDir, "trust-store.json"), "utf8")).not.toContain(invite.secret);

		const attacker = createDevice();
		const attackerChallenge = store.createChallenge({
			purpose: "accept_device_invite",
			deviceId: attacker.deviceId,
			devicePublicKey: attacker.publicKey,
			pairId: invite.inviteId,
		});
		expect(() => store.acceptDeviceInvite(
			attackerChallenge.challengeId,
			attacker.signChallenge(attackerChallenge),
			invite.inviteId,
			"wrong-secret",
		)).toThrow("Invalid device invite secret");

		const second = createDevice();
		const acceptChallenge = store.createChallenge({
			purpose: "accept_device_invite",
			deviceId: second.deviceId,
			devicePublicKey: second.publicKey,
			pairId: invite.inviteId,
		});
		expect(store.acceptDeviceInvite(
			acceptChallenge.challengeId,
			second.signChallenge(acceptChallenge),
			invite.inviteId,
			invite.secret,
		)).toEqual({ accountId: first.confirmation.accountId, deviceId: second.deviceId });

		const discovery = store.createChallenge({ purpose: "discover", deviceId: second.deviceId });
		expect(store.listAuthorizedBackendIds(discovery.challengeId, second.signChallenge(discovery)).sort()).toEqual([
			"b_backend",
			"b_second",
		]);
		const replayDevice = createDevice();
		expect(() => store.createChallenge({
			purpose: "accept_device_invite",
			deviceId: replayDevice.deviceId,
			devicePublicKey: replayDevice.publicKey,
			pairId: invite.inviteId,
		})).toThrow("missing or expired");
	});

	it("revokes devices and backend grants using one-use signed challenges", () => {
		const { store } = createStore(40_000);
		const first = pairDevice(store);
		const second = pairDevice(store, createDevice(), "b_backend", "pair_second");
		const revokeDeviceChallenge = store.createChallenge({
			purpose: "revoke_device",
			deviceId: first.device.deviceId,
			backendId: "b_backend",
			targetDeviceId: second.device.deviceId,
		});
		const revokeDeviceSignature = first.device.signChallenge(revokeDeviceChallenge);
		expect(store.revokeDevice(revokeDeviceChallenge.challengeId, revokeDeviceSignature)).toEqual({
			accountId: first.confirmation.accountId,
			deviceId: second.device.deviceId,
		});
		expect(store.isDeviceActive(second.device.deviceId)).toBe(false);
		expect(() => store.revokeDevice(revokeDeviceChallenge.challengeId, revokeDeviceSignature)).toThrow("missing or expired");

		const revokeBackendChallenge = store.createChallenge({
			purpose: "revoke_backend",
			deviceId: first.device.deviceId,
			backendId: "b_backend",
		});
		expect(store.revokeBackend(
			revokeBackendChallenge.challengeId,
			first.device.signChallenge(revokeBackendChallenge),
		)).toEqual({ accountId: first.confirmation.accountId, backendId: "b_backend" });
		expect(store.getBackendOwner("b_backend")).toBeUndefined();
		expect(store.getPendingBackendRevocation("b_backend")).toEqual({
			accountId: first.confirmation.accountId,
			backendId: "b_backend",
		});
	});

	it("issues coturn REST credentials without exposing the shared secret", () => {
		const provider = new IceServerProvider(
			[{ urls: "stun:stun.example:3478" }],
			{ urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:443"], secret: "turn-secret", ttlSeconds: 300 },
			() => 1_000_000,
		);
		expect(provider.issue("d_device")).toEqual([
			{ urls: "stun:stun.example:3478" },
			{
				urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:443"],
				username: "1300:d_device",
				credential: expect.any(String),
			},
		]);
		expect(JSON.stringify(provider.issue("d_device"))).not.toContain("turn-secret");
	});
});

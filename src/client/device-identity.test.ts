import "fake-indexeddb/auto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDeviceSignature } from "../shared/node-trust-crypto.js";
import { deviceChallengePayload, type DeviceChallenge } from "../shared/trust-protocol.js";
import { loadOrCreateBackendIdentity, signBackendIdentityBinding } from "../server/backend-identity.js";
import {
	generateBrowserDeviceIdentity,
	loadBrowserDeviceIdentity,
	loadOrCreateBrowserDeviceIdentity,
	signDeviceChallenge,
	verifyBrowserBackendBinding,
} from "./device-identity.js";

const cleanupDirs: string[] = [];
const cleanupDatabases: string[] = [];

afterEach(async () => {
	for (const name of cleanupDatabases.splice(0)) indexedDB.deleteDatabase(name);
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("browser device identity", () => {
	it("generates a non-exportable P-256 signer and persists it in IndexedDB", async () => {
		const databaseName = `pipane-device-test-${crypto.randomUUID()}`;
		cleanupDatabases.push(databaseName);
		await expect(loadBrowserDeviceIdentity(databaseName)).resolves.toBeUndefined();
		const first = await loadOrCreateBrowserDeviceIdentity(databaseName);
		const second = await loadBrowserDeviceIdentity(databaseName);
		if (!second) throw new Error("Stored identity is missing");
		expect(second.deviceId).toBe(first.deviceId);
		expect(second.publicKey).toBe(first.publicKey);
		expect(first.privateKey.extractable).toBe(false);
		await expect(crypto.subtle.exportKey("pkcs8", first.privateKey)).rejects.toThrow();

		const challenge: DeviceChallenge = {
			version: 1,
			challengeId: "ch_browser",
			nonce: "nonce",
			purpose: "connect",
			deviceId: first.deviceId,
			devicePublicKey: first.publicKey,
			backendId: "b_backend",
			connectionId: "c_browser",
			expiresAt: Date.now() + 60_000,
		};
		const signature = await signDeviceChallenge(first, challenge);
		expect(verifyDeviceSignature(first.publicKey, deviceChallengePayload(challenge), signature)).toBe(true);
	});

	it("verifies backend signatures bound to both SDP descriptions and DTLS fingerprint", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pipane-browser-binding-"));
		cleanupDirs.push(dir);
		const backend = loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
		const offerSdp = "v=0\r\na=setup:actpass\r\n";
		const answerSdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n";
		const expiresAt = Date.now() + 60_000;
		const binding = signBackendIdentityBinding(backend, {
			connectionId: "c_binding",
			offerSdp,
			answerSdp,
			expiresAt,
		});
		await expect(verifyBrowserBackendBinding(binding, {
			backendId: backend.backendId,
			connectionId: "c_binding",
			offerSdp,
			answerSdp,
			expiresAt,
		})).resolves.toBeUndefined();
		await expect(verifyBrowserBackendBinding(binding, {
			backendId: backend.backendId,
			connectionId: "c_binding",
			offerSdp: `${offerSdp}changed`,
			answerSdp,
			expiresAt,
		})).rejects.toThrow("does not match");
	});

	it("creates distinct identities outside persistent storage", async () => {
		const first = await generateBrowserDeviceIdentity();
		const second = await generateBrowserDeviceIdentity();
		expect(first.deviceId).not.toBe(second.deviceId);
	});
});

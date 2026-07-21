// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deriveBackendId,
	loadBackendIdentity,
	loadOrCreateBackendIdentity,
	signBackendChallenge,
	verifyBackendChallenge,
} from "./backend-identity.js";

const cleanupPaths: string[] = [];

function identityPath(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-identity-test-"));
	cleanupPaths.push(dir);
	const filePath = path.join(dir, "nested", "identity.json");
	mkdirSync(path.dirname(filePath), { recursive: true });
	return filePath;
}

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("backend identity", () => {
	it("creates one private identity with a stable public backend id", () => {
		const filePath = identityPath();
		const first = loadOrCreateBackendIdentity(filePath);
		const second = loadOrCreateBackendIdentity(filePath);

		expect(first.backendId).toMatch(/^b_[A-Za-z0-9_-]{43}$/);
		expect(second.backendId).toBe(first.backendId);
		expect(second.publicKey).toBe(first.publicKey);
		expect(deriveBackendId(first.publicKey)).toBe(first.backendId);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		expect(readFileSync(filePath, "utf8")).not.toContain("BEGIN PRIVATE KEY");
	});

	it("signs domain-separated registration challenges", () => {
		const identity = loadOrCreateBackendIdentity(identityPath());
		const signature = signBackendChallenge(identity, "challenge-one");

		expect(verifyBackendChallenge(identity.publicKey, "challenge-one", signature)).toBe(true);
		expect(verifyBackendChallenge(identity.publicKey, "challenge-two", signature)).toBe(false);
		expect(verifyBackendChallenge(identity.publicKey, "challenge-one", "invalid")).toBe(false);
	});

	it("rejects malformed identity files and public keys", () => {
		const filePath = identityPath();
		writeFileSync(filePath, "not-json", { encoding: "utf8", flag: "wx" });
		expect(() => loadBackendIdentity(filePath)).toThrow("Invalid backend identity file");
		expect(() => deriveBackendId("not+base64url")).toThrow("Invalid public key encoding");
	});
});

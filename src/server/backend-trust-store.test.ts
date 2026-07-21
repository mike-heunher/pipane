// @vitest-environment node

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionTicketClaims } from "../shared/trust-protocol.js";
import { BackendTrustStore } from "./backend-trust-store.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(now = 10_000) {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-backend-trust-"));
	cleanupDirs.push(dir);
	const filePath = path.join(dir, "trust.json");
	return { filePath, store: new BackendTrustStore({ filePath, now: () => now }) };
}

function claims(overrides: Partial<ConnectionTicketClaims> = {}): ConnectionTicketClaims {
	return {
		version: 1,
		kind: "connection",
		ticketId: "t_one",
		backendId: "b_backend",
		connectionId: "c_one",
		deviceId: "d_device",
		devicePublicKey: "public-key",
		accountId: "a_owner",
		issuedAt: 10_000,
		expiresAt: 20_000,
		...overrides,
	};
}

describe("BackendTrustStore", () => {
	it("persists single-use hashed pairing capabilities in a private file", () => {
		const { filePath, store } = setup();
		const pairing = store.createPairing();
		const storedText = JSON.stringify(JSON.parse(requireText(filePath)));
		expect(storedText).not.toContain(pairing.secret);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		expect(store.listActivePairings()).toEqual([{ pairId: pairing.pairId, expiresAt: pairing.expiresAt }]);
		expect(() => store.consumePairing(pairing.pairId, "wrong-secret")).toThrow("Invalid pairing secret");
		store.consumePairing(pairing.pairId, pairing.secret);
		expect(() => store.consumePairing(pairing.pairId, pairing.secret)).toThrow("already used");
	});

	it("enforces owner, device revocation, and persistent ticket replay protection", () => {
		const { filePath, store } = setup();
		store.completePairing("a_owner");
		store.authorizeTicket(claims());
		store.markTicketUsed(claims());
		expect(() => store.authorizeTicket(claims())).toThrow("already used");
		expect(() => store.authorizeTicket(claims({ ticketId: "t_other", accountId: "a_other" }))).toThrow("does not own");

		store.applyRevocation("a_owner", "d_device");
		expect(() => store.authorizeTicket(claims({ ticketId: "t_revoked" }))).toThrow("revoked");
		const reloaded = new BackendTrustStore({ filePath, now: () => 10_000 });
		expect(() => reloaded.authorizeTicket(claims())).toThrow("already used");
		reloaded.applyRevocation("a_owner");
		expect(reloaded.ownerAccountId).toBeUndefined();
	});

	it("allows a pairing ticket before ownership but never changes existing ownership", () => {
		const { store } = setup();
		const pairingClaims = claims({ kind: "pairing", accountId: undefined, pairId: "pair_one" });
		expect(() => store.authorizeTicket(pairingClaims)).not.toThrow();
		store.completePairing("a_owner");
		expect(() => store.completePairing("a_other")).toThrow("another account");
	});
});

function requireText(filePath: string): string {
	// Kept local so the test never exports or logs pairing secrets.
	return readFileSync(filePath, "utf8");
}

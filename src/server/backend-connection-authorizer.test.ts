// @vitest-environment node

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionTicketClaims } from "../shared/trust-protocol.js";
import { BackendConnectionAuthorizer } from "./backend-connection-authorizer.js";
import { BackendTrustStore } from "./backend-trust-store.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup() {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-authorizer-"));
	cleanupDirs.push(dir);
	const store = new BackendTrustStore({ filePath: path.join(dir, "trust.json") });
	const confirmation = {
		connectionId: "c_pair",
		pairId: "pair_one",
		accountId: "a_owner",
		deviceId: "d_device",
	};
	const signaling = { confirmPairing: vi.fn(async () => confirmation) };
	return { store, signaling, authorizer: new BackendConnectionAuthorizer(store, signaling) };
}

function claims(overrides: Partial<ConnectionTicketClaims> = {}): ConnectionTicketClaims {
	return {
		version: 1,
		kind: "pairing",
		ticketId: "t_pair",
		backendId: "b_backend",
		connectionId: "c_pair",
		deviceId: "d_device",
		devicePublicKey: "public-key",
		pairId: "pair_one",
		issuedAt: Date.now(),
		expiresAt: Date.now() + 60_000,
		...overrides,
	};
}

describe("BackendConnectionAuthorizer", () => {
	it("makes the backend secret check precede anonymous account confirmation", async () => {
		const { store, signaling, authorizer } = setup();
		const pairing = store.createPairing();
		signaling.confirmPairing.mockResolvedValue({
			connectionId: "c_pair",
			pairId: pairing.pairId,
			accountId: "a_owner",
			deviceId: "d_device",
		});
		const ticketClaims = claims({ pairId: pairing.pairId });
		await expect(authorizer.authorize({ claims: ticketClaims, pairingSecret: "wrong" })).rejects.toThrow("Invalid pairing secret");
		expect(signaling.confirmPairing).not.toHaveBeenCalled();

		await expect(authorizer.authorize({ claims: ticketClaims, pairingSecret: pairing.secret })).resolves.toEqual({
			accountId: "a_owner",
			deviceId: "d_device",
		});
		expect(signaling.confirmPairing).toHaveBeenCalledWith("c_pair");
		expect(store.ownerAccountId).toBe("a_owner");
	});

	it("accepts owner tickets once and rejects another account", async () => {
		const { store, authorizer } = setup();
		store.completePairing("a_owner");
		const regular = claims({ kind: "connection", ticketId: "t_regular", accountId: "a_owner", pairId: undefined });
		await expect(authorizer.authorize({ claims: regular })).resolves.toEqual({ accountId: "a_owner", deviceId: "d_device" });
		await expect(authorizer.authorize({ claims: regular })).rejects.toThrow("already used");
		await expect(authorizer.authorize({
			claims: claims({ kind: "connection", ticketId: "t_other", accountId: "a_other", pairId: undefined }),
		})).rejects.toThrow("does not own");
	});
});

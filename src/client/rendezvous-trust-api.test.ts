import { describe, expect, it, vi } from "vitest";
import { generateBrowserDeviceIdentity } from "./device-identity.js";
import { parsePairingUrl, RendezvousTrustApi } from "./rendezvous-trust-api.js";

describe("RendezvousTrustApi", () => {
	it("proves device-key possession before requesting a pairing ticket", async () => {
		const identity = await generateBrowserDeviceIdentity();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				version: 1,
				challengeId: "ch_one",
				nonce: "nonce",
				purpose: "pair",
				deviceId: identity.deviceId,
				devicePublicKey: identity.publicKey,
				backendId: "b_backend",
				connectionId: "c_one",
				pairId: "pair_one",
				expiresAt: Date.now() + 60_000,
			}), { status: 200, headers: { "content-type": "application/json" } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "ticket", iceServers: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}));
		const api = new RendezvousTrustApi("https://signal.example/ignored", fetchMock);
		await expect(api.createPairingTicket(identity, {
			backendId: "b_backend",
			pairId: "pair_one",
		}, "c_one")).resolves.toEqual({ ticket: "ticket", iceServers: [] });
		expect(fetchMock).toHaveBeenNthCalledWith(1, new URL("https://signal.example/v1/auth/challenges"), expect.objectContaining({
			body: expect.stringContaining(identity.publicKey),
		}));
		const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(secondBody).toEqual({ challengeId: "ch_one", signature: expect.any(String) });
		expect(secondBody.signature.length).toBeGreaterThan(40);
	});

	it("discovers only runtime-validated backends authorized for the device account", async () => {
		const identity = await generateBrowserDeviceIdentity();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				version: 1,
				challengeId: "ch_discover",
				nonce: "nonce",
				purpose: "discover",
				deviceId: identity.deviceId,
				devicePublicKey: identity.publicKey,
				expiresAt: Date.now() + 60_000,
			}), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ backends: [
				{ backendId: "b_one", name: "One", protocolVersions: [1, 2], online: true },
			] }), { status: 200 }));
		const api = new RendezvousTrustApi("https://signal.example", fetchMock);
		await expect(api.listAuthorizedBackends(identity)).resolves.toEqual([
			{ backendId: "b_one", name: "One", protocolVersions: [1, 2], online: true },
		]);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			purpose: "discover",
			deviceId: identity.deviceId,
		});
	});

	it("keeps the 256-bit secret in the URL fragment", () => {
		const value = "https://app.example/pair/pair_abc#backend=b_backend&secret=top-secret";
		expect(parsePairingUrl(value)).toEqual({ pairId: "pair_abc", backendId: "b_backend", secret: "top-secret" });
		expect(new URL(value).search).toBe("");
		expect(() => parsePairingUrl("https://app.example/pair/pair_abc?secret=leaked")).toThrow("malformed");
	});
});

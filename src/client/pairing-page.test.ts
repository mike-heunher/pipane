import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDeviceIdentity } from "./device-identity.js";
import { ConnectionAttemptError } from "./frame-transport.js";
import { initializePairingPage } from "./pairing-page.js";

const originalUrl = window.location.href;

afterEach(() => {
	document.body.replaceChildren();
	window.history.replaceState(null, "", originalUrl);
});

describe("pairing page", () => {
	it("consumes a fragment capability and clears the secret after authentication", async () => {
		window.history.replaceState(null, "", "/pair/pair_one#backend=b_backend&secret=pair-secret");
		const root = document.createElement("div");
		root.id = "app";
		document.body.append(root);
		const identity = { deviceId: "d_device", publicKey: "public-key", privateKey: {} } as BrowserDeviceIdentity;
		const createPairingTicket = vi.fn(async () => ({ ticket: "ticket", iceServers: [] }));
		const resolveTurnIceServers = vi.fn(async () => [{ urls: "turn:turn.example:3478", username: "temporary", credential: "credential" }]);
		const connect = vi.fn(async (_endpoint: string) => {});
		const close = vi.fn();

		await initializePairingPage({
			loadIdentity: async () => identity,
			createTrustApi: () => ({ createPairingTicket }),
			resolveTurnIceServers,
			createTransport: (options) => {
				expect(options.backendId).toBe("b_backend");
				return {
					connect: async (endpoint) => {
						await options.authorize();
						await connect(endpoint);
					},
					close,
				};
			},
		});

		expect(createPairingTicket).toHaveBeenCalledWith(identity, {
			pairId: "pair_one",
			backendId: "b_backend",
			secret: "pair-secret",
		});
		expect(connect).toHaveBeenCalledWith("webrtc");
		expect(resolveTurnIceServers).toHaveBeenCalledWith("d_device");
		expect(close).toHaveBeenCalledWith(1000, "Pairing complete");
		expect(window.location.pathname).toBe("/backend/b_backend");
		expect(window.location.hash).toBe("");
		expect(document.querySelector("[data-testid='pairing-status']")?.textContent).toContain("Paired successfully");
		expect(document.querySelector<HTMLAnchorElement>("[data-testid='pairing-continue']")?.href).toContain("/backend/b_backend");
	});

	it("keeps the capability available for an explicit retry after failure", async () => {
		window.history.replaceState(null, "", "/pair/pair_retry#backend=b_backend&secret=retry-secret");
		const root = document.createElement("div");
		root.id = "app";
		document.body.append(root);
		const connect = vi.fn(async (_endpoint: string) => {})
			.mockRejectedValueOnce(new Error("Backend rejected pairing"))
			.mockResolvedValueOnce(undefined);
		const identity = { deviceId: "d_device", publicKey: "public-key", privateKey: {} } as BrowserDeviceIdentity;
		await initializePairingPage({
			loadIdentity: async () => identity,
			createTrustApi: () => ({ createPairingTicket: async () => ({ ticket: "ticket", iceServers: [] }) }),
			createTransport: (options) => ({
				connect: async (endpoint) => {
					await options.authorize();
					await connect(endpoint);
				},
				close: vi.fn(),
			}),
		});
		const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
		expect(retry.hidden).toBe(false);
		expect(window.location.hash).toContain("retry-secret");
		retry.click();
		await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(window.location.hash).toBe(""));
	});

	it("offers TURN setup only after a classified ICE failure and retries after save", async () => {
		window.history.replaceState(null, "", "/pair/pair_turn#backend=b_backend&secret=turn-secret");
		const root = document.createElement("div");
		root.id = "app";
		document.body.append(root);
		const identity = { deviceId: "d_device", publicKey: "public-key", privateKey: {} } as BrowserDeviceIdentity;
		const connect = vi.fn(async (_endpoint: string) => undefined)
			.mockRejectedValueOnce(new ConnectionAttemptError("ice", "No direct path"))
			.mockResolvedValueOnce(undefined);
		const openRelayDialog = vi.fn(async (options: any) => {
			await options.onSaved?.({ kind: "static" });
		});
		await initializePairingPage({
			loadIdentity: async () => identity,
			createTrustApi: () => ({ createPairingTicket: async () => ({ ticket: "ticket", iceServers: [] }) }),
			resolveTurnIceServers: async () => [],
			openRelayDialog,
			createTransport: (options) => ({
				connect: async (endpoint) => {
					await options.authorize();
					await connect(endpoint);
				},
				close: vi.fn(),
			}),
		});
		const relay = document.querySelector("[data-testid='pairing-turn-relay']") as HTMLButtonElement;
		expect(relay.hidden).toBe(false);
		relay.click();
		await vi.waitFor(() => expect(openRelayDialog).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(window.location.hash).toBe(""));
	});
});

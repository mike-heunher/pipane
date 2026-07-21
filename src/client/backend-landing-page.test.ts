import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDeviceIdentity } from "./device-identity.js";
import { initializeBackendLandingPage } from "./backend-landing-page.js";

const identity = { deviceId: "d_device", publicKey: "public", privateKey: {} as CryptoKey } satisfies BrowserDeviceIdentity;

afterEach(() => document.body.replaceChildren());

function root(): void {
	const app = document.createElement("div");
	app.id = "app";
	document.body.append(app);
}

describe("backend landing page", () => {
	it("shows all account backends with compatibility and reachability", async () => {
		root();
		await initializeBackendLandingPage({
			loadIdentity: async () => identity,
			createTrustApi: () => ({
				listAuthorizedBackends: async () => [
					{ backendId: "b_one", name: "One", protocolVersions: [1, 2], online: true },
					{ backendId: "b_two", name: "Two", protocolVersions: [], online: false },
				],
				revokeBackend: vi.fn(),
			}),
			confirm: () => true,
		});
		const cards = document.querySelectorAll("[data-backend-id]");
		expect(cards).toHaveLength(2);
		expect(cards[0].querySelector<HTMLAnchorElement>("[data-testid='open-backend']")?.getAttribute("href")).toBe("/backend/b_one");
		expect(cards[1].querySelector("[data-testid='open-backend']")?.getAttribute("aria-disabled")).toBe("true");
	});

	it("explains terminal recovery when no browser key exists", async () => {
		root();
		await initializeBackendLandingPage({
			loadIdentity: async () => undefined,
			createTrustApi: () => ({ listAuthorizedBackends: vi.fn(), revokeBackend: vi.fn() }),
			confirm: () => false,
		});
		expect(document.body.textContent).toContain("pipane pair");
		expect(document.body.textContent).toContain("No paired browser key");
	});

	it("revokes an offline grant without requiring a backend connection", async () => {
		root();
		const revokeBackend = vi.fn(async () => undefined);
		await initializeBackendLandingPage({
			loadIdentity: async () => identity,
			createTrustApi: () => ({
				listAuthorizedBackends: async () => [{ backendId: "b_offline", protocolVersions: [], online: false }],
				revokeBackend,
			}),
			confirm: () => true,
		});
		(document.querySelector("button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(revokeBackend).toHaveBeenCalledWith(identity, "b_offline"));
		await vi.waitFor(() => expect(document.querySelector("[data-backend-id='b_offline']")).toBeNull());
	});
});

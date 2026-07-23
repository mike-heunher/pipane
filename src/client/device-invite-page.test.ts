import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDeviceIdentity } from "./device-identity.js";
import { initializeDeviceInvitePage } from "./device-invite-page.js";

const originalUrl = window.location.href;

function mount(): void {
	const root = document.createElement("div");
	root.id = "app";
	document.body.append(root);
}

afterEach(() => {
	document.body.replaceChildren();
	window.history.replaceState(null, "", originalUrl);
});

describe("device invite page", () => {
	it("adds a fresh browser device and clears the capability secret", async () => {
		window.history.replaceState(null, "", "/invite/invite_one#secret=invite-secret");
		mount();
		const identity = { deviceId: "d_new", publicKey: "public-key", privateKey: {} } as BrowserDeviceIdentity;
		const acceptDeviceInvite = vi.fn(async () => ({ accountId: "a_owner", deviceId: identity.deviceId }));

		await initializeDeviceInvitePage({
			loadIdentity: async () => identity,
			createTrustApi: () => ({ acceptDeviceInvite }),
		});

		expect(acceptDeviceInvite).toHaveBeenCalledWith(identity, {
			inviteId: "invite_one",
			secret: "invite-secret",
		});
		expect(window.location.pathname).toBe("/");
		expect(window.location.hash).toBe("");
		expect(document.querySelector("[data-testid='device-invite-status']")?.textContent).toContain("Device added");
		expect(document.querySelector<HTMLAnchorElement>("[data-testid='device-invite-continue']")?.href).toContain("/");
	});

	it("retains the secret so an expired-network failure can be retried", async () => {
		window.history.replaceState(null, "", "/invite/invite_retry#secret=retry-secret");
		mount();
		const identity = { deviceId: "d_new", publicKey: "public-key", privateKey: {} } as BrowserDeviceIdentity;
		const acceptDeviceInvite = vi.fn()
			.mockRejectedValueOnce(new Error("Temporary failure"))
			.mockResolvedValueOnce({ accountId: "a_owner", deviceId: identity.deviceId });
		await initializeDeviceInvitePage({
			loadIdentity: async () => identity,
			createTrustApi: () => ({ acceptDeviceInvite }),
		});
		expect(window.location.hash).toContain("retry-secret");
		const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
		retry.click();
		await vi.waitFor(() => expect(acceptDeviceInvite).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(window.location.hash).toBe(""));
	});
});

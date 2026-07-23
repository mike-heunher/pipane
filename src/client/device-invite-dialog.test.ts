import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDeviceIdentity } from "./device-identity.js";
import { openDeviceInviteDialog } from "./device-invite-dialog.js";

const identity = { deviceId: "d_device", publicKey: "public", privateKey: {} as CryptoKey } satisfies BrowserDeviceIdentity;

afterEach(() => document.body.replaceChildren());

describe("device invite dialog", () => {
	it("shows a QR code, copyable link, and ten-minute countdown", async () => {
		const renderQr = vi.fn(async () => undefined);
		const copyText = vi.fn(async () => undefined);
		const createDeviceInvite = vi.fn(async () => ({
			url: "https://pipane.dev/invite/invite_one#secret=secret",
			expiresAt: 601_000,
		}));
		const closed = openDeviceInviteDialog({
			loadIdentity: async () => identity,
			createTrustApi: () => ({ createDeviceInvite }),
			renderQr,
			copyText,
			now: () => 1_000,
		});

		await vi.waitFor(() => expect(renderQr).toHaveBeenCalledWith(
			expect.any(HTMLCanvasElement),
			"https://pipane.dev/invite/invite_one#secret=secret",
		));
		expect(document.querySelector<HTMLInputElement>("[data-testid='device-invite-link']")?.value).toContain("invite_one");
		expect(document.querySelector("[data-testid='device-invite-create-status']")?.textContent).toContain("10:00");
		const copy = [...document.querySelectorAll("button")].find((button) => button.textContent === "Copy link")!;
		copy.click();
		await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith("https://pipane.dev/invite/invite_one#secret=secret"));
		await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
		(document.querySelector("[aria-label='Close device invite']") as HTMLButtonElement).click();
		await closed;
	});

	it("requires an already-authorized browser identity", async () => {
		const closed = openDeviceInviteDialog({
			loadIdentity: async () => undefined,
			createTrustApi: () => ({ createDeviceInvite: vi.fn() }),
			renderQr: vi.fn(),
			copyText: vi.fn(),
			now: Date.now,
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("not authorized"));
		(document.querySelector("[aria-label='Close device invite']") as HTMLButtonElement).click();
		await closed;
	});
});

import { expect, test } from "@playwright/test";
import { startMockPipaneServer, type MockPipaneServer } from "./mock-pipane-server.js";

let mock: MockPipaneServer;

test.beforeAll(async () => {
	mock = await startMockPipaneServer({
		sessions: [],
		states: {},
		updates: [
			{ target: "pipane", currentVersion: "0.1.6", latestVersion: "0.1.7" },
			{ target: "pi", currentVersion: "0.80.6", latestVersion: "0.80.10" },
			{ target: "extensions", packages: ["npm:one", "git:example/two"] },
		],
	});
});

test.afterAll(async () => {
	await mock.close();
});

test("updates use a compact backend indicator and can be hidden until tomorrow", async ({ page }) => {
	await page.goto(`http://127.0.0.1:${mock.port}`);
	await expect(page.locator(".update-notifications")).toHaveCount(0);
	const indicator = page.locator("session-picker .update-indicator");
	await expect(indicator).toHaveText("↑");
	await expect(indicator).toHaveAttribute("aria-label", "3 updates available for this backend");
	await indicator.click();
	await expect(page.locator("session-picker .update-option")).toHaveCount(3);

	for (const target of ["pipane", "pi"] as const) {
		const option = page.locator(`session-picker [data-update-target="${target}"]`);
		await option.locator(".update-later").click();
		await expect(option).toHaveCount(0);
	}
	await expect(page.locator('session-picker [data-update-target="extensions"]')).toHaveCount(1);

	await page.reload();
	await indicator.click();
	await expect(page.locator('session-picker [data-update-target="pipane"]')).toHaveCount(0);
	await expect(page.locator('session-picker [data-update-target="pi"]')).toHaveCount(0);
	await expect(page.locator('session-picker [data-update-target="extensions"]')).toHaveCount(1);

	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await indicator.click();
	await expect(page.locator("session-picker .update-option")).toHaveCount(3);
	expect(mock.getUpdateRequests()).toEqual([]);
});

test("selected backend updates require confirmation and run together", async ({ page }) => {
	await page.goto(`http://127.0.0.1:${mock.port}`);
	await page.locator("session-picker .update-indicator").click();
	await expect(page.locator('session-picker [data-update-target="pipane"]')).toContainText("v0.1.6 → v0.1.7");
	await expect(page.locator('session-picker [data-update-target="pi"]')).toContainText("v0.80.6 → v0.80.10");
	await expect(page.locator('session-picker [data-update-target="extensions"]')).toContainText("2 Pi package updates");

	const piCheckbox = page.locator('session-picker [data-update-target="pi"] input');
	await piCheckbox.uncheck();
	await expect(page.locator("session-picker .update-run")).toHaveText("Update selected (2)");

	page.once("dialog", (dialog) => dialog.dismiss());
	await page.locator("session-picker .update-run").click();
	expect(mock.getUpdateRequests()).toEqual([]);

	page.once("dialog", (dialog) => dialog.accept());
	await page.locator("session-picker .update-run").click();
	await expect(page.locator('session-picker [data-update-target="pipane"]')).toHaveCount(0);
	await expect(page.locator('session-picker [data-update-target="extensions"]')).toHaveCount(0);
	await expect(page.locator("session-picker .update-menu-feedback.success")).toContainText("pipane update completed");
	expect(mock.getUpdateRequests()).toEqual(["pipane", "extensions"]);

	await expect(piCheckbox).not.toBeChecked();
	await piCheckbox.check();
	page.once("dialog", (dialog) => dialog.accept());
	await page.locator("session-picker .update-run").click();
	await expect(page.locator('session-picker [data-update-target="pi"]')).toHaveCount(0);
	expect(mock.getUpdateRequests()).toEqual(["pipane", "extensions", "pi"]);
});

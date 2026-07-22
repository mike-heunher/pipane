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

test("Pi and pipane update notices can be hidden until tomorrow", async ({ page }) => {
	await page.goto(`http://127.0.0.1:${mock.port}`);
	await expect(page.locator(".update-notice")).toHaveCount(3);

	for (const target of ["pipane", "pi"] as const) {
		const notice = page.locator(`[data-update-target="${target}"]`);
		await expect(notice.locator(".update-notice-dismiss")).toHaveText("Remind me tomorrow");
		await notice.locator(".update-notice-dismiss").click();
		await expect(notice).toHaveCount(0);
	}
	await expect(page.locator('[data-update-target="extensions"]')).toHaveCount(1);

	await page.reload();
	await expect(page.locator('[data-update-target="pipane"]')).toHaveCount(0);
	await expect(page.locator('[data-update-target="pi"]')).toHaveCount(0);
	await expect(page.locator('[data-update-target="extensions"]')).toHaveCount(1);

	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.locator(".update-notice")).toHaveCount(3);
	expect(mock.getUpdateRequests()).toEqual([]);
});

test("update notices require confirmation and run every update action", async ({ page }) => {
	await page.goto(`http://127.0.0.1:${mock.port}`);
	await expect(page.locator(".update-notice")).toHaveCount(3);
	await expect(page.locator('[data-update-target="pipane"]')).toContainText("v0.1.6 → v0.1.7");
	await expect(page.locator('[data-update-target="pi"]')).toContainText("v0.80.6 → v0.80.10");
	await expect(page.locator('[data-update-target="extensions"]')).toContainText("2 Pi package updates");

	page.once("dialog", (dialog) => dialog.dismiss());
	await page.locator('[data-update-target="pipane"] .update-notice-update').click();
	expect(mock.getUpdateRequests()).toEqual([]);

	for (const target of ["pipane", "pi", "extensions"] as const) {
		page.once("dialog", (dialog) => dialog.accept());
		await page.locator(`[data-update-target="${target}"] .update-notice-update`).click();
		await expect(page.locator(`[data-update-target="${target}"]`)).toHaveCount(0);
		await expect(page.locator(".update-feedback.is-success")).toContainText(`${target} update completed`);
	}

	expect(mock.getUpdateRequests()).toEqual(["pipane", "pi", "extensions"]);
});

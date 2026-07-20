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

test("update notices require confirmation and run every update action", async ({ page }) => {
	await page.goto(`http://127.0.0.1:${mock.port}`);
	await expect(page.locator(".update-notice")).toHaveCount(3);
	await expect(page.locator('[data-update-target="pipane"]')).toContainText("v0.1.6 → v0.1.7");
	await expect(page.locator('[data-update-target="pi"]')).toContainText("v0.80.6 → v0.80.10");
	await expect(page.locator('[data-update-target="extensions"]')).toContainText("2 Pi package updates");

	page.once("dialog", (dialog) => dialog.dismiss());
	await page.locator('[data-update-target="pipane"]').click();
	expect(mock.getUpdateRequests()).toEqual([]);

	for (const target of ["pipane", "pi", "extensions"] as const) {
		page.once("dialog", (dialog) => dialog.accept());
		await page.locator(`[data-update-target="${target}"]`).click();
		await expect(page.locator(`[data-update-target="${target}"]`)).toHaveCount(0);
		await expect(page.locator(".update-feedback.is-success")).toContainText(`${target} update completed`);
	}

	expect(mock.getUpdateRequests()).toEqual(["pipane", "pi", "extensions"]);
});

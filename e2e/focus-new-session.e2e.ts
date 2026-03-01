/**
 * E2E test: clicking the group "+" button to create a new session
 * should focus the input textarea so the user can start typing immediately.
 */

import { test, expect, type Page } from "@playwright/test";
import { startHarness, type E2EHarness } from "./harness.js";
import { textChunks } from "./mock-llm-server.js";

/**
 * Click the "+" button on the group with the given cwd.
 */
async function clickGroupNewButton(page: Page, cwd: string): Promise<void> {
	await page.evaluate((targetCwd) => {
		const picker = document.querySelector("session-picker");
		if (!picker?.shadowRoot) throw new Error("No session-picker");
		const headers = picker.shadowRoot.querySelectorAll(".group-header");
		for (const header of headers) {
			if (header.getAttribute("title") === targetCwd) {
				const btn = header.querySelector(".group-new-btn") as HTMLButtonElement;
				if (!btn) throw new Error("No + button found in group header");
				btn.click();
				return;
			}
		}
		throw new Error(`No group with cwd "${targetCwd}" found`);
	}, cwd);
}

/**
 * Get all group cwds visible in the session picker.
 */
async function getAllGroupCwds(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const picker = document.querySelector("session-picker");
		if (!picker?.shadowRoot) return [];
		const headers = picker.shadowRoot.querySelectorAll(".group-header");
		return Array.from(headers).map((h) => h.getAttribute("title") || "");
	});
}

/**
 * Check if the message-editor textarea is the active (focused) element.
 * Traverses shadow roots to find the actual focused element.
 */
async function isTextareaFocused(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		// Walk through shadow roots to find the deepest active element
		let active: Element | null = document.activeElement;
		while (active?.shadowRoot?.activeElement) {
			active = active.shadowRoot.activeElement;
		}
		return active?.tagName === "TEXTAREA";
	});
}

test.describe("Focus on new session", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	let harness: E2EHarness;

	test.beforeAll(async () => {
		harness = await startHarness();
	}, 30000);

	test.afterAll(async () => {
		await harness?.close();
	});

	test("clicking group '+' button focuses the input textarea", async ({ page }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("First session response.") },
		]);

		// Step 1: Open the app and send a prompt to establish a project group
		await page.goto(`http://localhost:${harness.pipanePort}`);

		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible({ timeout: 10000 });
		const textarea = editor.locator("textarea").first();
		await expect(textarea).toBeEnabled({ timeout: 5000 });
		await textarea.fill("Setup message");
		await textarea.press("Meta+Enter");

		// Wait for response to complete
		await expect(
			page.getByText("First session response", { exact: false }),
		).toBeVisible({ timeout: 15000 });

		// Wait for sidebar to show the session
		await page.waitForFunction(() => {
			const picker = document.querySelector("session-picker") as any;
			return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) >= 1;
		}, null, { timeout: 10000 });

		// Discover the project group cwd
		const groups = await getAllGroupCwds(page);
		expect(groups.length).toBeGreaterThanOrEqual(1);
		const projectBasename = harness.projectDir.split("/").pop()!;
		const projectCwd = groups.find((g) => g.endsWith(projectBasename));
		expect(projectCwd).toBeTruthy();

		// Step 2: Blur the textarea so we can verify focus is set by the new session action
		await page.evaluate(() => {
			(document.activeElement as HTMLElement)?.blur();
			// Also blur through shadow roots
			let active: Element | null = document.activeElement;
			while (active?.shadowRoot?.activeElement) {
				active = active.shadowRoot.activeElement;
				(active as HTMLElement)?.blur?.();
			}
		});

		// Verify textarea is NOT focused before clicking "+"
		expect(await isTextareaFocused(page)).toBe(false);

		// Step 3: Click the group "+" to create a new session
		await clickGroupNewButton(page, projectCwd!);

		// Step 4: Wait for the new session to appear
		await page.waitForFunction((expected) => {
			const picker = document.querySelector("session-picker") as any;
			return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) > expected;
		}, 1, { timeout: 5000 });

		// Step 5: Verify the textarea is focused
		// Use polling since focus may happen after a rAF
		await expect.poll(
			() => isTextareaFocused(page),
			{ timeout: 3000, message: "Expected textarea to be focused after creating new session" },
		).toBe(true);
	});
});

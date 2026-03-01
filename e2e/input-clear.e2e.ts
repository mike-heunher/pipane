/**
 * E2E test: input box is cleared after sending a prompt.
 *
 * Regression test for a bug where the textarea kept its value after
 * pressing Enter to send, because `handleSend` didn't clear the editor.
 */

import { test, expect } from "@playwright/test";
import { startHarness, type E2EHarness } from "./harness.js";
import { textChunks } from "./mock-llm-server.js";

test.describe("Input clear on send", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	let harness: E2EHarness;

	test.beforeAll(async () => {
		harness = await startHarness();
	}, 30000);

	test.afterAll(async () => {
		await harness?.close();
	});

	async function gotoFreshSession(page: import("@playwright/test").Page) {
		await page.goto(`http://localhost:${harness.pipanePort}`);
		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible({ timeout: 10000 });
		const textarea = editor.locator("textarea").first();
		await expect(textarea).toBeEnabled({ timeout: 5000 });

		const hasExistingSessions = await page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			if (!picker?.shadowRoot) return false;
			return picker.shadowRoot.querySelectorAll(".session-item").length > 0;
		});
		if (hasExistingSessions) {
			await page.evaluate(() => {
				const picker = document.querySelector("session-picker") as any;
				const btn = picker?.shadowRoot?.querySelector(".group-new-btn") as HTMLButtonElement;
				btn?.click();
			});
			await page.waitForTimeout(300);
		}
	}

	test("textarea is cleared after sending a prompt with Enter", async ({ page }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Got it, thanks!") },
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();

		// Type a message and send with Enter
		await textarea.fill("This should be cleared after sending");
		await textarea.press("Enter");

		// Wait for the assistant response to confirm the prompt was sent
		await expect(page.getByText("Got it, thanks!", { exact: false })).toBeVisible({ timeout: 15000 });

		// The textarea should now be empty
		await expect(textarea).toHaveValue("", { timeout: 5000 });
	});
});

/**
 * E2E test: input box is cleared after sending a prompt.
 *
 * Regression test for a bug where the textarea kept its value after
 * pressing Enter to send, because `handleSend` didn't clear the editor.
 */

import type { Page } from "@playwright/test";
import type { E2EHarness } from "./harness.js";
import { test, expect } from "./real-stack-fixture.js";
import { textChunks } from "./mock-llm-server.js";

test.describe("Input clear on send", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	async function gotoFreshSession(page: Page, harness: E2EHarness) {
		await page.goto(`http://localhost:${harness.pipanePort}`);
		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible({ timeout: 10000 });
		const textarea = editor.locator("textarea").first();
		await expect(textarea).toBeEnabled({ timeout: 5000 });

		const existingSessionCount = await page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			return picker?.shadowRoot?.querySelectorAll(".session-item").length ?? 0;
		});
		if (existingSessionCount > 0) {
			await page.evaluate(async () => {
				const picker = document.querySelector("session-picker") as any;
				const group = picker?.shadowRoot?.querySelector(".group-header") as HTMLElement | null;
				const cwd = group?.getAttribute("title");
				if (!cwd) throw new Error("Session group was not rendered");
				await picker.agent.newSession(cwd);
			});
			await expect.poll(async () => page.evaluate(() => {
				const picker = document.querySelector("session-picker") as any;
				return picker?.agent?.sessionStatus;
			})).toBe("virtual");
		}
	}

	test("textarea is cleared after sending a prompt with Enter", async ({ page, harness }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Got it, thanks!") },
		]);

		await gotoFreshSession(page, harness);

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

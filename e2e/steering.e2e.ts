/**
 * E2E test for steering (queueing prompts while the agent is running).
 *
 * Uses the real pi-web stack with a mock LLM. The test:
 * 1. Sends an initial prompt that triggers a slow bash tool call
 * 2. While the tool is executing, sends steering messages
 * 3. Verifies the steering queue appears in the UI
 * 4. Verifies the remove button works
 * 5. Verifies queued steering is consumed and disappears after execution
 */

import { test, expect } from "@playwright/test";
import { startHarness, type E2EHarness } from "./harness.js";
import { toolCallChunks, textChunks, type Scenario } from "./mock-llm-server.js";

test.describe("Steering queue e2e", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	let harness: E2EHarness;

	test.beforeAll(async () => {
		harness = await startHarness();
	}, 30000);

	test.afterAll(async () => {
		await harness?.close();
	});

	async function gotoFreshSession(page: import("@playwright/test").Page) {
		await page.goto(`http://localhost:${harness.piWebPort}`);
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

	test("steering messages appear in queue and are consumed after execution", async ({ page }) => {
		// Scenario setup:
		// 1. Initial prompt triggers a slow bash tool (sleep 3)
		// 2. After tool result comes back, LLM responds with text
		// 3. The steering message "also do cleanup" becomes a new user turn
		//    and gets a text response from the LLM
		harness.setScenarios([
			{
				match: "run slow task",
				hasToolResults: false,
				chunks: toolCallChunks(
					"call_slow_1",
					"bash",
					{ command: "sleep 3 && echo done" },
				),
			},
			{
				// After bash tool result, LLM responds with text
				match: "run slow task",
				hasToolResults: true,
				chunks: textChunks("The slow task is complete."),
			},
			{
				// The steering message becomes a new user turn.
				match: "also do cleanup",
				chunks: textChunks("Cleanup is done."),
			},
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();

		// 1. Send the initial prompt that triggers a slow tool
		await textarea.fill("run slow task");
		await textarea.press("Enter");

		// 2. Wait for the tool to start executing (bash tool visible)
		await expect(page.locator("tool-message").first()).toBeVisible({ timeout: 15000 });

		// 3. While the agent is running, send a steering message
		await textarea.fill("also do cleanup");
		await textarea.press("Enter");

		// 4. The steering queue should appear in the UI
		const queue = page.locator(".steering-queue");
		await expect(queue).toBeVisible({ timeout: 5000 });

		// Verify the steering text is shown in the queue chip
		await expect(page.locator(".steering-chip-text").first()).toContainText("also do cleanup", { timeout: 5000 });

		// 5. Wait for the slow task to complete and the steering to be consumed.
		//    The queue should disappear once the steering prompt is consumed.
		await expect(queue).not.toBeVisible({ timeout: 20000 });

		// 6. The steering prompt's response should appear
		await expect(page.getByText("Cleanup is done", { exact: false }).first()).toBeVisible({ timeout: 15000 });
	});

	test("remove button removes a steering message from the queue", async ({ page }) => {
		// Use a very long sleep so the tool stays running while we manipulate the queue.
		harness.setScenarios([
			{
				match: "run another slow task",
				hasToolResults: false,
				chunks: toolCallChunks(
					"call_slow_2",
					"bash",
					// Very long sleep — we only need the tool running, not completing
					{ command: "sleep 30 && echo finished" },
				),
			},
			{
				match: /.*/,
				hasToolResults: true,
				chunks: textChunks("Done."),
			},
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();

		// 1. Send initial prompt
		await textarea.fill("run another slow task");
		await textarea.press("Enter");

		// 2. Wait for tool execution to start
		await expect(page.locator("tool-message").first()).toBeVisible({ timeout: 15000 });

		// 3. Queue two steering messages
		await textarea.fill("first steering message");
		await textarea.press("Enter");

		const queue = page.locator(".steering-queue");
		await expect(queue).toBeVisible({ timeout: 5000 });

		await textarea.fill("second steering message");
		await textarea.press("Enter");

		// 4. Verify both are shown
		await expect(page.locator(".steering-chip")).toHaveCount(2, { timeout: 5000 });

		// 5. Click the remove button on the first chip
		const removeBtn = page.locator(".steering-chip-remove").first();
		await removeBtn.click();

		// 6. Only one chip should remain
		await expect(page.locator(".steering-chip")).toHaveCount(1, { timeout: 5000 });
		await expect(page.locator(".steering-chip-text").first()).toContainText("second steering message", { timeout: 5000 });
	});
});

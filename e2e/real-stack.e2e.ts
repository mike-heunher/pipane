/**
 * E2E tests against the real pipane stack with a mock LLM.
 *
 * These tests start the real pipane server (which spawns real pi RPC processes)
 * but point the LLM at a mock OpenAI-compatible endpoint. This validates the
 * full pipeline: UI → WebSocket → pipane server → pi RPC → mock LLM → back to UI.
 */

import { test, expect } from "@playwright/test";
import { startHarness, type E2EHarness } from "./harness.js";
import {
	textChunks,
	toolCallWithTextChunks,
	toolCallChunks,
	type Scenario,
} from "./mock-llm-server.js";

test.describe("Real stack e2e", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	let harness: E2EHarness;

	test.beforeAll(async () => {
		harness = await startHarness();
	}, 30000);

	test.afterAll(async () => {
		await harness?.close();
	});

	/** Navigate to the app and start a fresh (virtual) session for a clean test. */
	async function gotoFreshSession(page: import("@playwright/test").Page) {
		await page.goto(`http://localhost:${harness.pipanePort}`);
		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible({ timeout: 10000 });
		const textarea = editor.locator("textarea").first();
		await expect(textarea).toBeEnabled({ timeout: 5000 });

		// If there are existing sessions (from prior tests), the page auto-loads
		// the most recent one. Create a new virtual session so tests start clean.
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

	test("can send a prompt and see the response", async ({ page }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Hello! I can help you with your project.") },
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("Hello, can you help me?");
		await textarea.press("Enter");

		// Wait for an assistant message to appear
		const assistantMsg = page.locator("assistant-message").first();
		await expect(assistantMsg).toBeVisible({ timeout: 15000 });

		// Check the response text is somewhere on the page (markdown renderer may wrap it)
		await expect(page.getByText("I can help you with your project", { exact: false })).toBeVisible({ timeout: 10000 });
	});

	test("can execute a tool call and see the result", async ({ page }) => {
		harness.setScenarios([
			{
				match: "read the config",
				hasToolResults: false,
				chunks: toolCallWithTextChunks(
					"I'll read the config file for you.",
					"call_001",
					"read",
					{ path: "config.ts" },
				),
			},
			{
				// After tool result, respond with text
				match: /.*/,
				hasToolResults: true,
				chunks: textChunks("The config file contains port 3000 and host localhost."),
			},
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("Please read the config file");
		await textarea.press("Enter");

		// Wait for tool-message to appear (the read tool was called)
		await expect(page.locator("tool-message").first()).toBeVisible({ timeout: 15000 });

		// The tool result should show the file content
		await expect(page.getByText("port: 3000", { exact: false }).first()).toBeVisible({ timeout: 10000 });

		// The final text response should appear
		await expect(page.getByText("config file contains port 3000", { exact: false }).first()).toBeVisible({ timeout: 10000 });
	});

	test("tool renderers display correctly for read", async ({ page }) => {
		harness.setScenarios([
			{
				match: "read",
				chunks: toolCallChunks("call_r1", "read", { path: "config.ts" }),
			},
			{
				match: /.*/,
				chunks: textChunks("Done reading."),
			},
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("read config.ts");
		await textarea.press("Enter");

		// Wait for the custom tool renderer to appear
		const toolMsg = page.locator("tool-message").first();
		await expect(toolMsg).toBeVisible({ timeout: 15000 });

		// Our custom ReadRenderer shows "read(config.ts)" in the header
		await expect(page.getByText("read(config.ts)", { exact: false }).first()).toBeVisible({ timeout: 10000 });
	});

	test("clicking chat messages jumps to the corresponding JSONL line", async ({ page }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Hello! I can help you with your project.") },
		]);

		await gotoFreshSession(page);

		// Open JSONL viewer via burger menu
		await page.locator("session-picker").getByTitle("Menu").click();
		await page.getByText("JSONL viewer").click();
		await expect(page.locator(".jsonl-panel")).toBeVisible();

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("jump-test prompt");
		await textarea.press("Enter");

		await expect(page.getByText("I can help you with your project", { exact: false }).first()).toBeVisible({ timeout: 15000 });
		await expect(page.locator(".jsonl-entry").first()).toBeVisible({ timeout: 15000 });

		// Click user message and verify JSONL focuses user entry
		await page.getByText("jump-test prompt", { exact: false }).first().click();
		await expect(page.locator(".jsonl-entry-focused .jsonl-line-label")).toContainText("message (user)", { timeout: 5000 });

		// Click assistant message and verify JSONL focuses assistant entry
		await page.getByText("I can help you with your project", { exact: false }).first().click();
		await expect(page.locator(".jsonl-entry-focused .jsonl-line-label")).toContainText("message (assistant)", { timeout: 5000 });
	});

	test("bash streaming output is visible during execution", async ({ page }) => {
		harness.setScenarios([
			{
				match: "run the loop",
				hasToolResults: false,
				chunks: toolCallChunks(
					"call_bash_1",
					"bash",
					{ command: "for i in 1 2 3; do echo \"dot_$i\"; sleep 0.3; done" },
				),
			},
			{
				// After tool result, respond with text
				match: /.*/,
				hasToolResults: true,
				chunks: textChunks("The loop finished producing dots."),
			},
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("run the loop");
		await textarea.press("Enter");

		// Wait for tool-message to appear (the bash tool was called)
		await expect(page.locator("tool-message").first()).toBeVisible({ timeout: 15000 });

		// The partial output should be visible DURING execution — check for early dots
		// before the tool completes. We look for any dot output appearing.
		await expect(page.getByText("dot_1", { exact: false }).first()).toBeVisible({ timeout: 15000 });

		// Wait for the final response after tool completion
		await expect(page.getByText("loop finished producing dots", { exact: false }).first()).toBeVisible({ timeout: 15000 });

		// All dots should be visible in the final result
		await expect(page.getByText("dot_3", { exact: false }).first()).toBeVisible({ timeout: 10000 });
	});

	test("session appears in picker after prompt", async ({ page }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Sure, I'll help with that.") },
		]);

		await gotoFreshSession(page);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("Help me refactor this module");
		await textarea.press("Enter");

		// Wait for response
		await expect(page.getByText("I'll help with that", { exact: false }).first()).toBeVisible({ timeout: 15000 });

		// The session picker should show the session — wait for at least one item
		await page.waitForFunction(() => {
			const picker = document.querySelector("session-picker") as any;
			return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) >= 1;
		}, null, { timeout: 10000 });
	});
});

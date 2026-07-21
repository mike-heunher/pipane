/**
 * E2E tests against the real pipane stack with a mock LLM.
 *
 * These tests start the real pipane server (which spawns real pi RPC processes)
 * but point the LLM at a mock OpenAI-compatible endpoint. This validates the
 * full pipeline: UI → WebSocket → pipane server → pi RPC → mock LLM → back to UI.
 */

import type { Page } from "@playwright/test";
import type { E2EHarness } from "./harness.js";
import { test, expect } from "./real-stack-fixture.js";
import {
	textChunks,
	toolCallWithTextChunks,
	toolCallChunks,
	type Scenario,
} from "./mock-llm-server.js";

test.describe("Real stack e2e", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	/** Navigate to the app and start a fresh (virtual) session for a clean test. */
	async function gotoFreshSession(page: Page, harness: E2EHarness) {
		await page.goto(`http://localhost:${harness.pipanePort}`);
		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible({ timeout: 10000 });
		const textarea = editor.locator("textarea").first();
		await expect(textarea).toBeEnabled({ timeout: 5000 });

		// If there are existing sessions (from prior tests), the page auto-loads
		// the most recent one. Create a new virtual session so tests start clean.
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

	test("fuzzy-completes slash commands without executing the selection", async ({ page, harness }) => {
		await gotoFreshSession(page, harness);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("/cpct");

		const menu = editor.locator(".slash-command-menu");
		await expect(menu).toBeVisible();
		await expect(menu.locator(".slash-command-option")).toHaveCount(1);
		await expect(menu).toContainText("/compact [instructions]");
		await expect(menu).toContainText("Compact conversation history");

		await textarea.press("Enter");
		await expect(textarea).toHaveValue("/compact ");
		await expect(menu).toBeHidden();
		await expect(page.locator("compaction-summary")).toHaveCount(0);
	});

	test("can send a prompt and see the response", async ({ page, harness }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Hello! I can help you with your project.") },
		]);

		await gotoFreshSession(page, harness);

		const editor = page.locator("message-editor");
		const textarea = editor.locator("textarea").first();
		await textarea.fill("Hello, can you help me?");
		await textarea.press("Enter");

		// Wait for an assistant message to appear
		const assistantMsg = page.locator("assistant-message").first();
		await expect(assistantMsg).toBeVisible({ timeout: 15000 });

		// Check the response text is somewhere on the page (markdown renderer may wrap it)
		await expect(page.getByText("I can help you with your project", { exact: false })).toBeVisible({ timeout: 10000 });

		// The harness cwd is not a linked Git worktree, so the persisted session
		// should be identified as the root checkout in the conversation picker.
		const sessionItem = page.locator("session-picker .session-item").filter({ hasText: "Hello, can you help me?" });
		await expect(sessionItem.locator(".session-worktree")).toHaveText("root", { timeout: 10000 });
	});

	test("keeps hash-dependent sync deltas ordered during burst streaming", async ({ page, harness }) => {
		const syncFailures: string[] = [];
		page.on("console", (message) => {
			const text = message.text();
			if (
				text.includes("[jsonl-sync] Base hash mismatch")
				|| text.includes("[ws-adapter] Sync verification failed")
				|| text.includes("[ws-adapter] Session revision gap")
				|| text.includes("[ws-adapter] Ignoring delta while awaiting full sync")
			) {
				syncFailures.push(text);
			}
		});

		const response = [
			...Array.from({ length: 80 }, (_, index) => `burst_${String(index).padStart(3, "0")}`),
			"BURST_COMPLETE",
		].join(" ");
		harness.setScenarios([
			{ match: "sync-burst-e2e", chunks: textChunks(response) },
		]);

		await gotoFreshSession(page, harness);
		const textarea = page.locator("message-editor").locator("textarea").first();
		await textarea.fill("sync-burst-e2e");
		await textarea.press("Enter");

		await expect(page.getByText("BURST_COMPLETE", { exact: false }).first()).toBeVisible({ timeout: 15000 });
		await expect(page.locator(".status-stop-button")).toBeHidden({ timeout: 10_000 });
		// Cross two paint boundaries so all queued session-sync frame work has run.
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));
		expect(syncFailures, "session sync should not enter full-sync recovery").toEqual([]);
	});

	test("preserves, clamps, executes, and restores effective thinking across model changes", async ({ page, harness }) => {
		harness.setScenarios([
			{ match: "thinking-state-e2e", chunks: textChunks("Thinking state persisted.") },
		]);

		await gotoFreshSession(page, harness);
		const thinkingButton = page.locator(".thinking-icon-btn");
		await expect(thinkingButton).toBeVisible();
		await expect(thinkingButton.locator(".thinking-level-label")).toHaveText("medium");

		// The full model supports high → xhigh. The sparse model has a hole at
		// xhigh but supports max, so pi's upward-first clamp must preview as max.
		await thinkingButton.click();
		await expect(thinkingButton.locator(".thinking-level-label")).toHaveText("high");
		await thinkingButton.click();
		await expect(thinkingButton.locator(".thinking-level-label")).toHaveText("xhigh");

		await page.getByText("mock-model", { exact: true }).click();
		await expect(page.locator(".model-picker-overlay")).toBeVisible();
		await page.getByText("mock/mock-sparse", { exact: true }).click();
		await expect(thinkingButton.locator(".thinking-level-label")).toHaveText("max");

		const textarea = page.locator("message-editor").locator("textarea").first();
		await textarea.fill("thinking-state-e2e");
		await textarea.press("Enter");
		await expect(page.getByText("Thinking state persisted.", { exact: false })).toBeVisible({ timeout: 15000 });
		await expect(thinkingButton.locator(".thinking-level-label")).toHaveText("max");

		// A full reload exercises compact session model restoration and the final
		// authoritative detach snapshot, not just optimistic local UI state.
		await page.reload();
		await expect(page.locator("message-editor")).toBeVisible({ timeout: 10000 });
		await expect(page.getByText("mock-sparse", { exact: true })).toBeVisible({ timeout: 10000 });
		await expect(page.locator(".thinking-icon-btn .thinking-level-label")).toHaveText("max");
	});

	test("can execute a tool call and see the result", async ({ page, harness }) => {
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

		await gotoFreshSession(page, harness);

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

	test("tool renderers display correctly for read", async ({ page, harness }) => {
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

		await gotoFreshSession(page, harness);

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

	test("clicking chat messages jumps to the corresponding JSONL line", async ({ page, harness }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Hello! I can help you with your project.") },
		]);

		await gotoFreshSession(page, harness);

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

	test("bash streaming output is visible during execution", async ({ page, harness }) => {
		harness.setScenarios([
			{
				match: "run the loop",
				hasToolResults: false,
				chunks: toolCallChunks(
					"call_bash_1",
					"bash",
					{ command: "for i in 1 2 3; do echo \"dot_$i\"; sleep 0.1; done" },
				),
			},
			{
				// After tool result, respond with text
				match: /.*/,
				hasToolResults: true,
				chunks: textChunks("The loop finished producing dots."),
			},
		]);

		await gotoFreshSession(page, harness);

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

	test("user scroll position survives streaming Bash output", async ({ page, harness }) => {
		harness.setScenarios([
			{
				match: "stream enough output to scroll",
				hasToolResults: false,
				chunks: toolCallChunks(
					"call_bash_scroll",
					"bash",
					{ command: "for i in $(seq 1 40); do echo scroll_line_$i; sleep 0.05; done" },
				),
			},
			{
				match: /.*/,
				hasToolResults: true,
				chunks: textChunks("Finished the scroll stream."),
			},
		]);

		await gotoFreshSession(page, harness);
		await page.addStyleTag({
			content: "#chat-scroll-area > div { padding-top: 1800px !important; }",
		});

		const textarea = page.locator("message-editor textarea").first();
		await textarea.fill("stream enough output to scroll");
		await textarea.press("Enter");

		const output = page.locator("tool-message .tool-body-scroll").first();
		await expect(output).toContainText("scroll_line_3", { timeout: 15000 });

		const scrollArea = page.locator("#chat-scroll-area");
		const bounds = await scrollArea.boundingBox();
		expect(bounds).not.toBeNull();
		await page.mouse.move(bounds!.x + 20, bounds!.y + 100);
		await page.mouse.wheel(0, -700);
		await expect.poll(() => scrollArea.evaluate((element) =>
			element.scrollHeight - element.scrollTop - element.clientHeight,
		)).toBeGreaterThan(100);

		await expect(output).toContainText("scroll_line_30", { timeout: 15000 });
		const distanceAfterMoreOutput = await scrollArea.evaluate((element) =>
			element.scrollHeight - element.scrollTop - element.clientHeight,
		);
		expect(distanceAfterMoreOutput).toBeGreaterThan(100);

		await expect(page.getByText("Finished the scroll stream.", { exact: true })).toBeVisible({ timeout: 15000 });
		await expect.poll(() => scrollArea.evaluate((element) =>
			element.scrollHeight - element.scrollTop - element.clientHeight,
		)).toBeGreaterThan(100);
	});

	test("session appears in picker after prompt", async ({ page, harness }) => {
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("Sure, I'll help with that.") },
		]);

		await gotoFreshSession(page, harness);

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

/**
 * E2E test: conversation elements should span full width on wide viewports.
 *
 * Regression test for the max-w-3xl constraint not being removed because the
 * CSS selector targeted `agent-interface` which doesn't exist in the DOM.
 */

import { test, expect } from "@playwright/test";
import { startMockPipaneServer, type MockPipaneServer } from "./mock-pipane-server.js";

const SESSION_PATH = "/tmp/mock-sessions/wide-test.jsonl";

const sessions = [
	{
		id: "w1", path: SESSION_PATH, cwd: "/Users/dev/project",
		name: "Wide layout test",
		created: new Date().toISOString(),
		modified: new Date().toISOString(),
		lastUserPromptTime: new Date().toISOString(),
		messageCount: 2,
		firstMessage: "Hello",
	},
];

const messages = [
	{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1000 },
	{
		role: "assistant",
		content: [{ type: "text", text: "This is a response that should span the full width of the conversation area on wide viewports." }],
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
		timestamp: 1001,
		stopReason: "end_turn",
	},
];

function createMockServer(): Promise<MockPipaneServer> {
	return startMockPipaneServer({
		sessions,
		states: { [SESSION_PATH]: messages },
		browse: { path: "/Users/dev", dirs: [] },
	});
}

test.describe("Wide viewport layout", () => {
	// Use a wide viewport (1900px) to reproduce the regression
	test.use({ viewport: { width: 1900, height: 900 } });

	let mock: Awaited<ReturnType<typeof createMockServer>>;

	test.beforeAll(async () => { mock = await createMockServer(); });
	test.afterAll(async () => { await mock.close(); });

	test("conversation elements span full width, not capped at max-w-3xl (48rem)", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);

		// Wait for session to load and messages to appear
		await page.waitForFunction(() => {
			const picker = document.querySelector("session-picker") as any;
			return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) > 0;
		}, null, { timeout: 10000 });

		// Click the session to load it
		await page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			const items = picker.shadowRoot.querySelectorAll(".session-item");
			if (items.length > 0) items[0].click();
		});

		// Wait for the assistant message to render
		await expect(page.locator("assistant-message").first()).toBeVisible({ timeout: 10000 });

		// Close canvas panel if visible (it takes space from the chat area)
		const canvasCloseBtn = page.locator("button.canvas-close");
		if (await canvasCloseBtn.isVisible().catch(() => false)) {
			await canvasCloseBtn.click();
			await expect(canvasCloseBtn).toBeHidden();
		}

		// Measure the message container width vs its parent scroll area
		const widths = await page.evaluate(() => {
			const scrollArea = document.getElementById("chat-scroll-area");
			const messageContainer = scrollArea?.querySelector(".max-w-3xl, pi-message-list")?.parentElement as HTMLElement | null;
			// Find the div wrapping pi-message-list (the one with max-w-3xl class)
			const wrapper = scrollArea?.querySelector("div") as HTMLElement | null;

			if (!scrollArea || !wrapper) return null;

			const scrollAreaWidth = scrollArea.clientWidth;
			const wrapperWidth = wrapper.clientWidth;
			const wrapperMaxWidth = window.getComputedStyle(wrapper).maxWidth;

			return {
				scrollAreaWidth,
				wrapperWidth,
				wrapperMaxWidth,
			};
		});

		expect(widths).not.toBeNull();

		// The wrapper's max-width should be 100% (or "none"), NOT 48rem (768px).
		// If the regression is present, wrapperMaxWidth will be "48rem" or "768px".
		const maxW = widths!.wrapperMaxWidth;
		expect(
			maxW === "100%" || maxW === "none" || parseFloat(maxW) > 1000,
			`Expected full-width but got max-width: ${maxW}. The max-w-3xl override is not working.`,
		).toBeTruthy();

		// The wrapper should be close to the scroll area width (minus padding)
		// At 1900px viewport with sidebar (280px), the chat area is ~1620px.
		// With max-w-3xl (768px), it would be much narrower.
		expect(
			widths!.wrapperWidth,
			`Wrapper width (${widths!.wrapperWidth}px) should be close to scroll area width (${widths!.scrollAreaWidth}px), not capped at 768px`,
		).toBeGreaterThan(900);

		// Also check the input area wrapper
		const inputWidths = await page.evaluate(() => {
			const inputArea = document.querySelector(".shrink-0.border-t");
			const inputWrapper = inputArea?.querySelector("div") as HTMLElement | null;

			if (!inputWrapper) return null;

			return {
				inputWrapperWidth: inputWrapper.clientWidth,
				inputMaxWidth: window.getComputedStyle(inputWrapper).maxWidth,
			};
		});

		expect(inputWidths).not.toBeNull();
		const inputMaxW = inputWidths!.inputMaxWidth;
		expect(
			inputMaxW === "100%" || inputMaxW === "none" || parseFloat(inputMaxW) > 1000,
			`Expected full-width input but got max-width: ${inputMaxW}. The input max-w-3xl override is not working.`,
		).toBeTruthy();
	});
});

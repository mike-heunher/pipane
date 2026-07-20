/**
 * E2E regression test: authoritative rerun snapshots must not duplicate tools.
 */

import { expect, test } from "@playwright/test";
import { startMockPipaneServer, type MockPipaneServer } from "./mock-pipane-server.js";
const SESSION_PATH = "/tmp/mock-sessions/test-session.jsonl";

const usage = (input: number, output: number, total: number) => ({
	input, output, cacheRead: 0, cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const messages = [
	{ role: "user", content: [{ type: "text", text: "sleep 200" }], timestamp: 1000 },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "..." },
			{ type: "toolCall", id: "t1", name: "Bash", arguments: { command: "sleep 200" } },
		],
		usage: usage(3600, 118, 0.0207),
		timestamp: 1001,
		stopReason: "aborted",
	},
	{
		role: "toolResult", toolCallId: "t1", toolName: "Bash",
		isError: true, content: [{ type: "text", text: "Command aborted" }], timestamp: 1002,
	},
];

function createMockServer(): Promise<MockPipaneServer> {
	const now = new Date().toISOString();
	return startMockPipaneServer({
		sessions: [{
			id: "s1", path: SESSION_PATH, cwd: "/tmp",
			created: now, modified: now,
			messageCount: 3, firstMessage: "sleep 200",
		}],
		states: { [SESSION_PATH]: messages },
		model: { provider: "anthropic", id: "sonnet" },
	});
}

test.describe("Rerun duplicate rendering regression", () => {
	let mock: Awaited<ReturnType<typeof createMockServer>>;

	test.beforeAll(async () => { mock = await createMockServer(); });
	test.afterAll(async () => { await mock.close(); });

	test("message_end should not cause duplicate tool blocks", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);

		// Wait for session items to load
		await page.waitForFunction(() => {
			const picker = document.querySelector("session-picker") as any;
			return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) > 0;
		}, null, { timeout: 10000 });

		// Select session
		await page.evaluate(() => {
			(document.querySelector("session-picker") as any).shadowRoot.querySelector(".session-item")?.click();
		});

		// Wait for tool-message to appear (session loaded)
		await page.waitForFunction(() =>
			document.querySelectorAll("tool-message").length > 0,
			null, { timeout: 10000 },
		);

		// Verify initial: 1 tool-message (from aborted run)
		let toolCount = await page.evaluate(() => document.querySelectorAll("tool-message").length);
		expect(toolCount).toBe(1);

		// Simulate rerun with authoritative flat-state snapshots.
		mock.sendSessionStatus(SESSION_PATH, "running");
		const newAssistant = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "..." },
				{ type: "toolCall", id: "t2", name: "Bash", arguments: { command: "sleep 200" } },
			],
			usage: usage(3700, 72, 0.0203),
			timestamp: 2001,
			stopReason: "tool_use",
		};

		const rerunMessages = [
			...messages,
			{ role: "user", content: [{ type: "text", text: "sleep 200" }], timestamp: 2000 },
			newAssistant,
		];
		const pushState = async (pendingToolCalls: string[]) => {
			mock.sendSessionState(SESSION_PATH, {
				messages: rerunMessages,
				isStreaming: true,
				pendingToolCalls,
			});
			await page.evaluate(() => new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}));
		};

		// During streaming there must be exactly one historical and one rerun tool.
		await pushState([]);
		await expect(page.locator("tool-message")).toHaveCount(2);
		await expect(page.locator("tool-message").filter({ hasText: "sleep 200" })).toHaveCount(2);

		// Re-publishing the authoritative message_end state must replace, not append,
		// the rerun tool block.
		await pushState([]);
		toolCount = await page.locator("tool-message").count();
		console.log(`After message_end state: ${toolCount} tool-message elements (expected 2)`);
		expect(toolCount).toBe(2);

		// Starting the new tool only changes pending state; it cannot duplicate it.
		await pushState(["t2"]);
		toolCount = await page.locator("tool-message").count();
		console.log(`After tool_start state: ${toolCount} tool-message elements (expected 2)`);
		expect(toolCount).toBe(2);
	});
});

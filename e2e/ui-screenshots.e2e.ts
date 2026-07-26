import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startMockPipaneServer, type MockPipaneServer } from "./mock-pipane-server.js";
const LATEST_DIR = path.resolve(import.meta.dirname, "latest");
const captureLatest = process.env.PIPANE_CAPTURE_LATEST_SCREENSHOTS === "1";

if (captureLatest) {
	fs.mkdirSync(LATEST_DIR, { recursive: true });
	for (const file of fs.readdirSync(LATEST_DIR)) {
		if (file.endsWith(".png")) fs.unlinkSync(path.join(LATEST_DIR, file));
	}
}

const usage = (input: number, output: number, total: number, totalTokens?: number) => ({
	input, output, cacheRead: 0, cacheWrite: 0, totalTokens,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const SESSION_PATH = "/tmp/mock-sessions/test-session.jsonl";
const SESSION_PATH_2 = "/tmp/mock-sessions/other-project.jsonl";
const SESSION_PATH_3 = "/tmp/mock-sessions/another-session.jsonl";
const MOCK_MODEL = {
	provider: "anthropic",
	id: "claude-sonnet-4-20250514",
	reasoning: true,
	contextWindow: 200_000,
	thinkingLevelMap: { xhigh: "xhigh" },
};

const sessions = [
	{
		id: "s1", path: SESSION_PATH, cwd: "/Users/dev/my-project",
		name: "Refactor auth module",
		created: new Date(Date.now() - 3600000).toISOString(),
		modified: new Date(Date.now() - 600000).toISOString(),
		lastUserPromptTime: new Date(Date.now() - 600000).toISOString(),
		messageCount: 12, firstMessage: "Can you refactor the auth module to use JWT?",
	},
	{
		id: "s2", path: SESSION_PATH_2, cwd: "/Users/dev/other-project",
		created: new Date(Date.now() - 86400000).toISOString(),
		modified: new Date(Date.now() - 7200000).toISOString(),
		lastUserPromptTime: new Date(Date.now() - 7200000).toISOString(),
		messageCount: 5, firstMessage: "Fix the CSS layout bug on the dashboard",
	},
	{
		id: "s3", path: SESSION_PATH_3, cwd: "/Users/dev/my-project",
		name: "Add unit tests",
		created: new Date(Date.now() - 172800000).toISOString(),
		modified: new Date(Date.now() - 86400000).toISOString(),
		lastUserPromptTime: new Date(Date.now() - 86400000).toISOString(),
		messageCount: 24, firstMessage: "Write comprehensive unit tests for the utils module",
	},
];

const toolMessages = [
	{ role: "user", content: [{ type: "text", text: "Read the config file, edit it, write a new file, and run the tests" }], timestamp: 1000 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "I'll start by reading the config file." },
			{ type: "toolCall", id: "t1", name: "Read", arguments: { path: "/Users/dev/my-project/src/config.ts", offset: 1, limit: 50 } },
		],
		usage: usage(1200, 80, 0.01),
		timestamp: 1001,
		stopReason: "tool_use",
	},
	{
		role: "toolResult", toolCallId: "t1", toolName: "Read", isError: false,
		content: [{ type: "text", text: 'export const config = {\n  port: 3000,\n  host: "localhost",\n};' }], timestamp: 1002,
	},
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Now I'll update the auth configuration." },
			{ type: "toolCall", id: "t2", name: "Edit", arguments: {
				path: "/Users/dev/my-project/src/config.ts",
				oldText: '  auth: {\n    secret: "change-me",\n  },',
				newText: '  auth: {\n    secret: process.env.JWT_SECRET || "change-me",\n    algorithm: "HS256",\n  },',
			} },
		],
		usage: usage(1800, 120, 0.015),
		timestamp: 1003,
		stopReason: "tool_use",
	},
	{ role: "toolResult", toolCallId: "t2", toolName: "Edit", isError: false, content: [{ type: "text", text: "Edit applied successfully." }], timestamp: 1004 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "I'll create a new auth utility file." },
			{ type: "toolCall", id: "t3", name: "Write", arguments: { path: "/Users/dev/my-project/src/auth/jwt.ts", content: 'export const ok = true;\n' } },
		],
		usage: usage(2400, 150, 0.02),
		timestamp: 1005,
		stopReason: "tool_use",
	},
	{ role: "toolResult", toolCallId: "t3", toolName: "Write", isError: false, content: [{ type: "text", text: "File written successfully." }], timestamp: 1006 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Now let's run tests." },
			{ type: "toolCall", id: "t4", name: "Bash", arguments: { command: "cd /Users/dev/my-project && npm test" } },
		],
		usage: usage(3000, 90, 0.018),
		timestamp: 1007,
		stopReason: "tool_use",
	},
	{ role: "toolResult", toolCallId: "t4", toolName: "Bash", isError: false, content: [{ type: "text", text: "Tests 5 passed" }], timestamp: 1008 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Let me also check type coverage." },
			{ type: "toolCall", id: "t5", name: "Bash", arguments: { command: "npx tsc --noEmit" } },
		],
		usage: usage(3200, 60, 0.016),
		timestamp: 1009,
		stopReason: "tool_use",
	},
	{ role: "toolResult", toolCallId: "t5", toolName: "Bash", isError: true, content: [{ type: "text", text: "TS2307: Cannot find module 'jsonwebtoken'" }], timestamp: 1010 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "I'll open a canvas summary." },
			{ type: "toolCall", id: "t6", name: "canvas", arguments: { title: "Auth migration summary" } },
		],
		usage: usage(3400, 70, 0.017),
		timestamp: 1011,
		stopReason: "tool_use",
	},
	{
		role: "toolResult", toolCallId: "t6", toolName: "canvas", isError: false,
		details: { title: "Auth migration summary", markdown: "# Auth Migration\n\n- Updated config defaults" },
		content: [{ type: "text", text: "Canvas prepared" }], timestamp: 1012,
	},
	{
		role: "assistant",
		content: [
			{ type: "text", text: "I'll inspect the ingestion test with an extension tool." },
			{ type: "toolCall", id: "t7", name: "hypa_read", arguments: {
				path: "tests/test_tool_ingestion.py", offset: 1, limit: 180, maxTokens: 10_000,
			} },
		],
		timestamp: 1013,
		stopReason: "tool_use",
	},
	{
		role: "toolResult", toolCallId: "t7", toolName: "hypa_read", isError: false,
		content: [{ type: "text", text: "def test_tool_ingestion():\n    assert ingest_tool_call() == expected" }], timestamp: 1014,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		usage: usage(3600, 100, 0.02, 152_000),
		timestamp: 1015,
		stopReason: "end_turn",
	},
];

const completedToolCallTimings = {
	t1: { startedAt: 10_000, completedAt: 12_340 },
	t2: { startedAt: 20_000, completedAt: 20_860 },
	t3: { startedAt: 30_000, completedAt: 31_250 },
	t4: { startedAt: 40_000, completedAt: 63_400 },
	t5: { startedAt: 70_000, completedAt: 72_180 },
	t6: { startedAt: 80_000, completedAt: 80_640 },
	t7: { startedAt: 90_000, completedAt: 91_420 },
};

function createMockServer(showTokenUsage = true): Promise<MockPipaneServer> {
	return startMockPipaneServer({
		sessions,
		states: Object.fromEntries(sessions.map((session) => [session.path, {
			messages: toolMessages,
			toolCallTimings: completedToolCallTimings,
		}])),
		model: MOCK_MODEL,
		sessionStatuses: { [SESSION_PATH_2]: "running" },
		settings: {
			appearance: { colorTheme: "gruvbox", darkMode: "light", showTokenUsage },
			messages: { initialCount: 50 },
		},
		browse: {
			path: "/Users/dev",
			dirs: [
				{ name: "my-project", path: "/Users/dev/my-project" },
				{ name: "other-project", path: "/Users/dev/other-project" },
			],
		},
	});
}

async function captureAndCompare(target: Locator | Page, name: string) {
	const screenshot = await target.screenshot({ animations: "disabled" });
	if (captureLatest) fs.writeFileSync(path.join(LATEST_DIR, name), screenshot);
	await expect(screenshot).toMatchSnapshot(name, { maxDiffPixelRatio: 0.015 });
}

async function waitForSessionItems(page: Page) {
	await page.waitForFunction(() => {
		const picker = document.querySelector("session-picker") as any;
		return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) > 0;
	}, null, { timeout: 10000 });
}

async function openMainSession(page: Page) {
	await waitForSessionItems(page);
	await page.evaluate(async (sessionPath) => {
		const picker = document.querySelector("session-picker") as any;
		if (!picker?.agent) throw new Error("Session picker agent was not ready");
		await picker.agent.switchSession(sessionPath);
	}, SESSION_PATH);
	await expect.poll(async () => page.evaluate(() => {
		const picker = document.querySelector("session-picker") as any;
		return picker?.agent?.sessionFile;
	})).toBe(SESSION_PATH);
	await expect(page.locator("tool-message").first()).toBeVisible();
}

test.describe("UI behavior and visual goldens", () => {
	test.describe.configure({ mode: captureLatest ? "default" : "parallel" });
	test.use({ viewport: { width: 1440, height: 900 } });
	let mock: Awaited<ReturnType<typeof createMockServer>>;

	test.beforeAll(async () => { mock = await createMockServer(); });
	test.afterAll(async () => { await mock.close(); });
	test.beforeEach(async ({ page }) => {
		// Visual snapshots must not depend on browser/system theme defaults or
		// localStorage left by unrelated tests. Apply the canonical light Gruvbox
		// appearance before application code runs; the mock API returns the same.
		await page.addInitScript(() => {
			localStorage.setItem("color-theme", "gruvbox");
			localStorage.setItem("theme", "light");
			localStorage.setItem("pipane-show-token-usage", "true");
		});
	});

	test("delays session actions until the row has been hovered", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await waitForSessionItems(page);

		const item = page.locator("session-picker").locator(".session-item").filter({ hasText: "Refactor auth module" });
		const pin = item.locator(".pin-btn");
		const remove = item.locator(".delete-btn");
		await expect(pin).toHaveCSS("visibility", "hidden");
		await expect(pin).toHaveCSS("pointer-events", "none");
		await expect(remove).toHaveCSS("visibility", "hidden");

		await item.hover();
		const revealTransition = await pin.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				properties: style.transitionProperty,
				delays: style.transitionDelay,
			};
		});
		expect(revealTransition).toEqual({
			properties: "opacity, visibility",
			delays: "0s, 0.3s",
		});
		await expect(pin).toHaveCSS("visibility", "visible", { timeout: 1_000 });
		await expect(remove).toHaveCSS("visibility", "visible", { timeout: 1_000 });
	});

	test("session list", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);
		await captureAndCompare(page.locator("session-picker"), "session-list.png");
	});

	test("preview session list", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);
		await page.locator("session-picker").evaluate((picker: any) => { picker.previewMode = true; });
		await captureAndCompare(page.locator("session-picker"), "session-list-preview.png");
	});

	test("settings command center", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);
		await page.locator("session-picker").getByTitle("Settings").click();
		await expect(page.locator(".local-settings-panel")).toBeVisible();
		await expect(page.locator(".local-settings-status.is-valid")).toBeVisible();
		await captureAndCompare(page, "settings-command-center.png");
	});

	test("tool renderers", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		await captureAndCompare(page, "tool-renderers-full.png");

		const tools = page.locator("tool-message");
		await expect(tools).toHaveCount(7);
		const names = ["tool-read.png", "tool-edit.png", "tool-write.png", "tool-bash-success.png", "tool-bash-error.png", "tool-canvas.png", "tool-generic.png"];
		for (let i = 0; i < names.length; i++) {
			const tool = tools.nth(i);
			await tool.scrollIntoViewIfNeeded();
			await captureAndCompare(tool, names[i]);
		}
	});

	test("input", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible({ timeout: 10000 });
		// The page auto-loads the latest session, which opens its canvas. Wait for
		// that authoritative content before closing the panel for a stable width.
		await expect(page.locator("tool-message")).toHaveCount(7);
		const canvasCloseBtn = page.locator("button.canvas-close");
		if (await canvasCloseBtn.count() > 0) {
			await expect(canvasCloseBtn).toBeVisible();
			await canvasCloseBtn.click();
			await expect(canvasCloseBtn).toBeHidden();
		}
		await captureAndCompare(editor, "input-empty.png");

		const textarea = editor.locator("textarea").first();
		await textarea.fill("/");
		const slashMenu = editor.locator(".slash-command-menu");
		await expect(slashMenu.locator(".slash-command-option")).toHaveCount(9);
		await captureAndCompare(slashMenu, "slash-command-overview.png");

		await textarea.fill("Can you help me refactor the database module to use connection pooling?");
		await expect(textarea).toHaveValue("Can you help me refactor the database module to use connection pooling?");
		await editor.evaluate((element: any) => element.updateComplete);
		await captureAndCompare(editor, "input-with-text.png");
	});

	test("provider usage status", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		for (const sessionPath of [SESSION_PATH, SESSION_PATH_2, SESSION_PATH_3]) {
			mock.send({
				type: "extension_status",
				sessionPath,
				statuses: { "provider-usage": "claude 18% 5h 42% wk" },
			});
		}
		mock.sendSessionStatus(SESSION_PATH, "running");
		mock.sendSessionState(SESSION_PATH, { isStreaming: true });

		const quota = page.locator(".status-quota");
		await expect(quota.locator(".status-quota-percent")).toHaveText("18% used / 5h");
		const quotaDetails = page.locator(".status-metric-details.is-quota");
		await expect(quotaDetails.locator(":scope > summary")).toHaveAttribute(
			"title",
			"Claude quota used: 18% in the 5-hour window; 42% in the weekly window. Click for session details.",
		);
		const context = page.locator(".status-context");
		await expect(context).toHaveClass(/is-warning/);
		await expect(context.locator(".status-context-percent")).toHaveText("76%");
		const contextDetails = page.locator(".status-metric-details.is-context");
		await expect(contextDetails.locator(":scope > summary"))
			.toHaveAttribute("title", "Context window: 76% used of 200k. Click for session details.");
		const quotaIsLeftOfSpacer = await quota.evaluate((element) => {
			const spacer = document.querySelector(".status-toolbar-spacer");
			return !!spacer && !!(element.compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING);
		});
		expect(quotaIsLeftOfSpacer).toBe(true);
		await expect(page.locator(".status-model-button"))
			.toHaveAttribute("title", "Change model (currently claude-sonnet-4-20250514)");
		const costDetails = page.locator(".status-metric-details.is-cost");
		await expect(costDetails.locator(":scope > summary"))
			.toHaveAttribute("title", "Session cost: $0.116. Click for session details.");
		await expect(page.locator(".status-escape-hint")).toHaveCount(0);
		await expect(page.locator(".status-stop-button"))
			.toHaveAttribute("title", "Stop generation (Esc)");
		const thinking = page.locator(".thinking-icon-btn");
		for (const level of ["minimal", "low", "medium", "high", "xhigh"]) {
			await thinking.click();
			await expect(thinking.locator(".thinking-level-label")).toHaveText(level);
		}
		await expect(thinking).toHaveAttribute("title", "Reasoning: xhigh (click to switch to off)");
		await expect(page.locator(".status-stop-button")).toBeVisible();
		await captureAndCompare(page.locator("message-editor"), "status-calm-default.png");
		await page.evaluate(() => document.documentElement.classList.add("dark"));
		await captureAndCompare(page.locator("message-editor"), "status-calm-default-dark.png");

		for (const details of [quotaDetails, contextDetails, costDetails]) {
			const summary = details.locator(":scope > summary");
			const popover = details.locator(".status-details-popover");
			await summary.click();
			await expect(popover).toBeVisible();
			await expect(details.locator(".extension-status-value")).toHaveText("claude 18% 5h 42% wk");
			await details.locator(".status-details-title").click();
			await expect(popover).toBeVisible();
			await page.evaluate(() => document.body.click());
			await expect(details).not.toHaveAttribute("open", "");
		}

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.locator(".mobile-sidebar-btn")).toBeVisible();
		await expect(quota).toBeVisible();
		await expect(context).toBeVisible();
		const statusMetrics = await page.locator(".conversation-status-bar").evaluate((element) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			right: Math.round(element.getBoundingClientRect().right),
			viewportWidth: window.innerWidth,
			children: Array.from(element.children).map((child) => ({
				className: child.className,
				width: Math.round(child.getBoundingClientRect().width),
			})),
		}));
		expect(statusMetrics.scrollWidth, JSON.stringify(statusMetrics)).toBeLessThanOrEqual(statusMetrics.clientWidth);
		expect(statusMetrics.right).toBeLessThanOrEqual(statusMetrics.viewportWidth);
	});

	test("steering queue", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		mock.sendSessionStatus(SESSION_PATH, "running");
		mock.sendSessionState(SESSION_PATH, {
			isStreaming: true,
			steeringQueue: ["Also update error handling", "Add retry logic"],
		});

		const queue = page.locator(".steering-queue");
		await expect(queue).toBeVisible();
		await captureAndCompare(queue, "steering-queue.png");
		await captureAndCompare(page, "steering-queue-in-context.png");
	});

	test("tool in progress", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		const assistantMsg = { role: "assistant", content: [{ type: "toolCall", id: "t-progress", name: "Bash", arguments: { command: "npm run build" } }], usage: usage(500, 40, 0.005), timestamp: 3001, stopReason: "tool_use" };
		mock.sendSessionStatus(SESSION_PATH, "running");
		mock.sendSessionState(SESSION_PATH, {
			messages: [
				...toolMessages,
				{ role: "user", content: [{ type: "text", text: "run build" }], timestamp: 3000 },
				assistantMsg,
			],
			isStreaming: true,
			pendingToolCalls: ["t-progress"],
			toolCallTimings: {
				...completedToolCallTimings,
				"t-progress": { startedAt: Date.now() },
			},
			steeringQueue: [],
		});

		await expect.poll(async () => page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			return {
				sessionPath: picker?.agent?.sessionFile,
				messageCount: picker?.agent?.state?.messages?.length,
				pending: [...(picker?.agent?.pendingToolCallIds ?? [])],
			};
		})).toEqual({
			sessionPath: SESSION_PATH,
			messageCount: toolMessages.length + 2,
			pending: ["t-progress"],
		});
		const tools = page.locator("tool-message");
		await expect(tools).toHaveCount(8);
		await expect(page.getByText("npm run build", { exact: false }).last()).toBeVisible();
		const runtime = tools.last().locator("tool-runtime");
		const initialRuntime = await runtime.textContent();
		await expect.poll(() => runtime.textContent()).not.toBe(initialRuntime);
		await captureAndCompare(page, "tool-bash-in-progress.png");
	});

	test("completed compaction", async ({ page }) => {
		// Reset the shared mock before loading so the regular session-open helper
		// can observe the initial tool tree.
		mock.sendSessionState(SESSION_PATH, {
			messages: toolMessages,
			isStreaming: false,
			pendingToolCalls: [],
			toolCallTimings: completedToolCallTimings,
			steeringQueue: [],
		});
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);
		const canvasCloseBtn = page.locator("button.canvas-close");
		if (await canvasCloseBtn.count() > 0) await canvasCloseBtn.click();

		mock.sendSessionState(SESSION_PATH, {
			messages: [
				{ role: "user", content: "Keep the auth migration constraints", timestamp: 4000 },
				{
					role: "assistant",
					content: [{ type: "text", text: "I’ll retain the decisions made so far." }],
					timestamp: 4001,
				},
				{
					role: "compactionSummary",
					summary: "## Goal\nFinish the auth migration.\n\n## Decisions\n- Use short-lived JWT access tokens\n- Keep refresh-token rotation\n- Run the full test suite before release",
					tokensBefore: 187701,
					timestamp: 4002,
				},
			],
			isStreaming: false,
			pendingToolCalls: [],
			steeringQueue: [],
		});

		const context = page.locator(".status-context");
		await expect(context).toBeVisible();
		await expect(context.locator(".status-context-percent")).toHaveText("?");
		await expect(page.locator(".status-metric-details.is-context > summary")).toHaveAttribute(
			"title",
			"Context window usage is unknown after compaction (200k window). Click for session details.",
		);

		const compaction = page.locator(".compaction-event.is-complete");
		await expect(compaction).toBeVisible();
		await expect(compaction.locator(".compaction-title")).toHaveText("Conversation compacted");
		await expect(compaction.locator(".compaction-meta")).toHaveText("188k tokens summarized");
		await captureAndCompare(compaction, "compaction-collapsed.png");

		await compaction.locator("summary").click();
		await expect(compaction.locator("details")).toHaveAttribute("open", "");
		await expect(compaction.locator("markdown-block")).toContainText("Finish the auth migration");
		await captureAndCompare(compaction, "compaction-expanded.png");
	});

	test("disabled token usage hides conversation totals but keeps context progress", async ({ page }) => {
		const hiddenUsageMock = await createMockServer(false);
		try {
			await page.goto(`http://localhost:${hiddenUsageMock.port}`);
			await openMainSession(page);
			await expect(page.locator("html")).toHaveClass(/hide-token-usage/);

			hiddenUsageMock.sendSessionState(SESSION_PATH, {
				messages: toolMessages,
				isStreaming: false,
				pendingToolCalls: [],
				toolCallTimings: completedToolCallTimings,
				steeringQueue: [],
			});

			const messageUsage = page.locator(".message-token-usage");
			await expect(messageUsage).toHaveCount(7);
			await expect(messageUsage.first()).toBeHidden();
			await expect(page.locator(".status-context-percent")).toHaveText("76%");
			await expect(page.locator(".status-context")).toBeVisible();
		} finally {
			await hiddenUsageMock.close();
		}
	});

	test("context usage stays visible during an all-zero streaming response", async ({ page }) => {
		mock.sendSessionState(SESSION_PATH, {
			messages: toolMessages,
			isStreaming: false,
			pendingToolCalls: [],
			toolCallTimings: completedToolCallTimings,
			steeringQueue: [],
		});
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		const context = page.locator(".status-context");
		await expect(context.locator(".status-context-percent")).toHaveText("76%");

		mock.sendSessionState(SESSION_PATH, {
			messages: [
				...toolMessages,
				{
					role: "assistant",
					content: [{ type: "text", text: "Working…" }],
					usage: usage(0, 0, 0, 0),
					timestamp: 5000,
				},
			],
			isStreaming: true,
		});

		await expect(context).toBeVisible();
		await expect(context.locator(".status-context-percent")).toHaveText("76%");
	});
});

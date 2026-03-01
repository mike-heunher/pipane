import { test, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import express from "express";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";

const CLIENT_DIST = path.resolve(import.meta.dirname, "../dist/client");
const LATEST_DIR = path.resolve(import.meta.dirname, "latest");

fs.mkdirSync(LATEST_DIR, { recursive: true });
for (const f of fs.readdirSync(LATEST_DIR)) {
	if (f.endsWith(".png")) fs.unlinkSync(path.join(LATEST_DIR, f));
}

const usage = (input: number, output: number, total: number) => ({
	input, output, cacheRead: 0, cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const SESSION_PATH = "/tmp/mock-sessions/test-session.jsonl";
const SESSION_PATH_2 = "/tmp/mock-sessions/other-project.jsonl";
const SESSION_PATH_3 = "/tmp/mock-sessions/another-session.jsonl";

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
		content: [{ type: "text", text: "Done." }],
		usage: usage(3600, 100, 0.02),
		timestamp: 1013,
		stopReason: "end_turn",
	},
];

function createMockServer(): Promise<{ server: Server; port: number; ws: () => WebSocket | null }> {
	return new Promise((resolve) => {
		const app = express();
		const server = createServer(app);
		const wss = new WebSocketServer({ server, path: "/ws" });

		app.use(express.static(CLIENT_DIST));
		app.get("/api/sessions", (_, res) => res.json(sessions));
		app.get("/api/sessions/messages", (_, res) => res.json({ messages: toolMessages }));
		app.get("/api/browse", (_, res) => res.json({
			path: "/Users/dev",
			dirs: [
				{ name: "my-project", path: "/Users/dev/my-project" },
				{ name: "other-project", path: "/Users/dev/other-project" },
			],
		}));

		let clientWs: WebSocket | null = null;
		wss.on("connection", (ws) => {
			clientWs = ws;
			ws.send(JSON.stringify({ type: "init", sessionStatuses: { [SESSION_PATH_2]: "running" } }));
			ws.on("message", (raw) => {
				const d = JSON.parse(raw.toString());
				if (!d.id) return;
				const resp = (data: any) => ws.send(JSON.stringify({ type: "response", id: d.id, success: true, data }));
				if (d.type === "get_default_model") resp({ model: { provider: "anthropic", id: "claude-sonnet-4-20250514" }, thinkingLevel: "off" });
				else if (d.type === "get_available_models") resp({ models: [{ provider: "anthropic", id: "claude-sonnet-4-20250514" }] });
				else if (d.type === "subscribe_session") {
					// Mirror real server: push session_messages before the response
					ws.send(JSON.stringify({
						type: "session_messages",
						sessionPath: d.sessionPath,
						messages: toolMessages,
						model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
						thinkingLevel: "off",
					}));
					resp({});
				}
				else resp({});
			});
		});

		server.listen(0, () => resolve({ server, port: (server.address() as any).port, ws: () => clientWs }));
	});
}

async function captureAndCompare(target: Locator | Page, name: string) {
	await target.screenshot({ path: path.join(LATEST_DIR, name), animations: "disabled" });
	await expect(target as any).toHaveScreenshot(name, { animations: "disabled", maxDiffPixelRatio: 0.015 });
}

async function waitForSessionItems(page: Page) {
	await page.waitForFunction(() => {
		const picker = document.querySelector("session-picker") as any;
		return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) > 0;
	}, null, { timeout: 10000 });
}

async function openMainSession(page: Page) {
	await waitForSessionItems(page);
	await page.evaluate(() => {
		const picker = document.querySelector("session-picker") as any;
		const items = picker.shadowRoot.querySelectorAll(".session-item");
		if (items.length > 0) items[0].click();
	});
	await expect(page.locator("tool-message").first()).toBeVisible();
}

test.describe("UI visual goldens", () => {
	test.use({ viewport: { width: 1440, height: 900 } });
	let mock: Awaited<ReturnType<typeof createMockServer>>;

	test.beforeAll(async () => { mock = await createMockServer(); });
	test.afterAll(async () => { await new Promise<void>((r) => mock.server.close(() => r())); });

	test("session list", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);
		await captureAndCompare(page.locator("session-picker"), "session-list.png");
	});

	test("tool renderers", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		await captureAndCompare(page, "tool-renderers-full.png");

		const tools = page.locator("tool-message");
		await expect(tools).toHaveCount(6);
		const names = ["tool-read.png", "tool-edit.png", "tool-write.png", "tool-bash-success.png", "tool-bash-error.png", "tool-canvas.png"];
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
		// The page auto-loads the latest session which may open the canvas panel.
		// Close it to get a consistent editor width for the screenshot.
		await page.waitForTimeout(300);
		const canvasCloseBtn = page.locator("button.canvas-close");
		if (await canvasCloseBtn.isVisible().catch(() => false)) {
			await canvasCloseBtn.click();
			await page.waitForTimeout(200);
		}
		await captureAndCompare(editor, "input-empty.png");

		await editor.locator("textarea").first().fill("Can you help me refactor the database module to use connection pooling?");
		await page.waitForTimeout(150);
		await captureAndCompare(editor, "input-with-text.png");
	});

	test("steering queue", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		const ws = mock.ws()!;
		const send = (msg: any) => ws.send(JSON.stringify(msg));
		send({ type: "session_attached", sessionPath: SESSION_PATH });
		send({ type: "agent_start", sessionPath: SESSION_PATH });
		send({ type: "message_start", sessionPath: SESSION_PATH, message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } });
		send({ type: "message_update", sessionPath: SESSION_PATH, message: { role: "assistant", content: [{ type: "text", text: "Working..." }] } });
		send({ type: "steering_queue_update", sessionPath: SESSION_PATH, queue: ["Also update error handling", "Add retry logic"] });

		// force queue refresh in UI (main.ts re-reads steeringQueue on session switch)
		await page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			const items = picker.shadowRoot.querySelectorAll(".session-item");
			if (items.length > 1) items[1].click();
		});
		await page.waitForTimeout(100);
		await page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			const items = picker.shadowRoot.querySelectorAll(".session-item");
			if (items.length > 0) items[0].click();
		});

		const queue = page.locator(".steering-queue");
		await expect(queue).toBeVisible();
		await captureAndCompare(queue, "steering-queue.png");
		await captureAndCompare(page, "steering-queue-in-context.png");
	});

	test("tool in progress", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await openMainSession(page);

		const ws = mock.ws()!;
		const send = (msg: any) => ws.send(JSON.stringify(msg));
		send({ type: "session_attached", sessionPath: SESSION_PATH });
		send({ type: "agent_start", sessionPath: SESSION_PATH });
		send({ type: "message_end", sessionPath: SESSION_PATH, message: { role: "user", content: [{ type: "text", text: "run build" }], timestamp: 3000 } });
		const assistantMsg = { role: "assistant", content: [{ type: "toolCall", id: "t-progress", name: "Bash", arguments: { command: "npm run build" } }], usage: usage(500, 40, 0.005), timestamp: 3001, stopReason: "tool_use" };
		send({ type: "message_start", sessionPath: SESSION_PATH, message: { role: "assistant", content: [] } });
		send({ type: "message_update", sessionPath: SESSION_PATH, message: assistantMsg });
		send({ type: "message_end", sessionPath: SESSION_PATH, message: assistantMsg });
		send({ type: "tool_execution_start", sessionPath: SESSION_PATH, toolCallId: "t-progress" });
		// Wait for the in-progress tool to render (spinner indicator appears)
		await page.waitForFunction(() => {
			const tools = document.querySelectorAll("tool-message");
			// Find the tool with the progress indicator (the bash tool we just sent)
			for (const t of tools) {
				const sr = t.shadowRoot;
				if (sr?.querySelector(".spinner, .progress-indicator, .tool-running")) return true;
			}
			// Alternatively, just check the tool appeared with the right content
			return document.querySelector("tool-message:last-of-type") !== null;
		}, null, { timeout: 5000 }).catch(() => {});
		// Small buffer for rendering to settle
		await page.waitForTimeout(100);
		await captureAndCompare(page, "tool-bash-in-progress.png");
	});
});

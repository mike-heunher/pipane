/**
 * E2E regression test: "rerun renders twice" bug.
 *
 * Root cause: After message_end, the assistant message appears in BOTH
 * state.messages (rendered by message-list) AND the streaming-message-container
 * (which still holds the old streamMessage from message_update). The upstream
 * AgentInterface only clears the streaming container on agent_end, not on
 * message_end, causing duplicate rendering between message_end and agent_end.
 *
 * Run: node node_modules/@playwright/test/cli.js test -c playwright.config.ts
 */

import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import express from "express";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const CLIENT_DIST = path.resolve(import.meta.dirname, "../dist/client");
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

function createMockServer(): Promise<{ server: Server; port: number; ws: () => WebSocket | null }> {
	return new Promise((resolve) => {
		const app = express();
		const server = createServer(app);
		const wss = new WebSocketServer({ server, path: "/ws" });

		app.use(express.static(CLIENT_DIST));
		app.get("/api/sessions", (_, res) => res.json([{
			id: "s1", path: SESSION_PATH, cwd: "/tmp",
			created: new Date().toISOString(), modified: new Date().toISOString(),
			messageCount: 3, firstMessage: "sleep 200",
		}]));
		app.get("/api/sessions/messages", (_, res) => res.json({ messages }));

		let clientWs: WebSocket | null = null;
		wss.on("connection", (ws) => {
			clientWs = ws;
			ws.send(JSON.stringify({ type: "init", sessionStatuses: {} }));
			ws.on("message", (raw) => {
				const d = JSON.parse(raw.toString());
				if (!d.id) return;
				const resp = (data: any) => ws.send(JSON.stringify({ type: "response", id: d.id, success: true, data }));
				if (d.type === "get_default_model") resp({ model: { provider: "anthropic", id: "sonnet" }, thinkingLevel: "off" });
				else if (d.type === "get_available_models") resp({ models: [{ provider: "anthropic", id: "sonnet" }] });
				else resp({});
			});
		});

		server.listen(0, () => {
			const port = (server.address() as any).port;
			resolve({ server, port, ws: () => clientWs });
		});
	});
}

test.describe("Rerun duplicate rendering regression", () => {
	let mock: Awaited<ReturnType<typeof createMockServer>>;

	test.beforeAll(async () => { mock = await createMockServer(); });
	test.afterAll(async () => { await new Promise<void>((r) => mock.server.close(() => r())); });

	test("message_end should not cause duplicate tool blocks", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await page.waitForTimeout(2000);

		// Select session
		await page.evaluate(() => {
			(document.querySelector("session-picker") as any).shadowRoot.querySelector(".session-item")?.click();
		});
		await page.waitForTimeout(2000);

		// Verify initial: 1 tool-message (from aborted run)
		let toolCount = await page.evaluate(() => document.querySelectorAll("tool-message").length);
		expect(toolCount).toBe(1);

		// Simulate rerun
		const ws = mock.ws()!;
		const send = (msg: any) => ws.send(JSON.stringify(msg));
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

		send({ type: "session_attached", sessionPath: SESSION_PATH });
		send({ type: "agent_start", sessionPath: SESSION_PATH });
		send({ type: "message_end", sessionPath: SESSION_PATH, message: { role: "user", content: [{ type: "text", text: "sleep 200" }], timestamp: 2000 } });
		await page.waitForTimeout(50);

		// Stream the assistant message
		send({ type: "message_start", sessionPath: SESSION_PATH, message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } });
		send({ type: "message_update", sessionPath: SESSION_PATH, message: newAssistant });
		await page.waitForTimeout(200);

		// During streaming: old tool in message-list + new tool in streaming container = 2
		toolCount = await page.evaluate(() => document.querySelectorAll("tool-message").length);
		expect(toolCount).toBeLessThanOrEqual(2);

		// message_end: THE CRITICAL MOMENT — the tool should NOT appear 3 times
		send({ type: "message_end", sessionPath: SESSION_PATH, message: newAssistant });
		await page.waitForTimeout(300);

		toolCount = await page.evaluate(() => document.querySelectorAll("tool-message").length);
		console.log(`After message_end: ${toolCount} tool-message elements (expected ≤ 2)`);
		expect(toolCount).toBeLessThanOrEqual(2); // old + new, NOT old + new + streaming duplicate

		// tool_execution_start
		send({ type: "tool_execution_start", sessionPath: SESSION_PATH, toolCallId: "t2" });
		await page.waitForTimeout(300);

		toolCount = await page.evaluate(() => document.querySelectorAll("tool-message").length);
		console.log(`After tool_start: ${toolCount} tool-message elements (expected ≤ 2)`);
		expect(toolCount).toBeLessThanOrEqual(2);
	});
});

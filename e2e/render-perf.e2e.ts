/**
 * Render performance E2E test.
 *
 * Feeds a large synthetic session (1940 messages, ~4MB at 10x multiplier)
 * through a mock WebSocket server and measures how long the frontend takes
 * to render them all.
 *
 * Regenerate the fixture with a different multiplier:
 *   npx tsx e2e/fixtures/generate-large-session.ts 10
 *
 * Uses the same mock-server pattern as ui-screenshots.e2e.ts.
 */

import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import express from "express";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";

const CLIENT_DIST = path.resolve(import.meta.dirname, "../dist/client");

const FIXTURE_PATH = path.resolve(import.meta.dirname, "fixtures/large-session-messages.json");
if (!fs.existsSync(FIXTURE_PATH)) {
	// Auto-generate the fixture with 10x multiplier
	const { execSync } = await import("node:child_process");
	console.log("Generating large session fixture (10x)…");
	execSync("npx tsx e2e/fixtures/generate-large-session.ts 10", {
		cwd: path.resolve(import.meta.dirname, ".."),
		stdio: "inherit",
	});
}
const largeSessionMessages: any[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

const SESSION_PATH = "/tmp/mock-sessions/perf-test-session.jsonl";

const sessions = [
	{
		id: "perf-1",
		path: SESSION_PATH,
		cwd: "/Users/dev/project",
		name: "Render perf test",
		created: new Date(Date.now() - 3600000).toISOString(),
		modified: new Date(Date.now() - 600000).toISOString(),
		lastUserPromptTime: new Date(Date.now() - 600000).toISOString(),
		messageCount: largeSessionMessages.length,
		firstMessage: "Performance test session",
	},
];

function createMockServer(): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const app = express();
		const server = createServer(app);
		const wss = new WebSocketServer({ server, path: "/ws" });

		app.use(express.static(CLIENT_DIST));
		app.get("/api/sessions", (_, res) => res.json(sessions));
		app.get("/api/sessions/messages", (_, res) =>
			res.json({ messages: largeSessionMessages }),
		);
		app.get("/api/browse", (_, res) =>
			res.json({
				path: "/Users/dev",
				dirs: [{ name: "project", path: "/Users/dev/project" }],
			}),
		);
		app.post("/api/debug/load-trace/event", express.json(), (_, res) => res.json({}));

		wss.on("connection", (ws) => {
			ws.send(JSON.stringify({ type: "init", sessionStatuses: {} }));
			ws.on("message", (raw) => {
				const d = JSON.parse(raw.toString());
				if (!d.id) return;
				const resp = (data: any) =>
					ws.send(JSON.stringify({ type: "response", id: d.id, success: true, data }));

				if (d.type === "get_default_model") {
					resp({ model: { provider: "anthropic", id: "claude-sonnet-4-20250514" }, thinkingLevel: "off" });
				} else if (d.type === "get_available_models") {
					resp({ models: [{ provider: "anthropic", id: "claude-sonnet-4-20250514" }] });
				} else if (d.type === "subscribe_session") {
					ws.send(JSON.stringify({
						type: "session_messages",
						sessionPath: d.sessionPath,
						messages: largeSessionMessages,
						model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
						thinkingLevel: "off",
					}));
					resp({});
				} else {
					resp({});
				}
			});
		});

		server.listen(0, () =>
			resolve({ server, port: (server.address() as any).port }),
		);
	});
}

async function waitForSessionItems(page: Page) {
	await page.waitForFunction(
		() => {
			const picker = document.querySelector("session-picker") as any;
			return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) > 0;
		},
		null,
		{ timeout: 10000 },
	);
}

test.describe("Render performance", () => {
	test.use({ viewport: { width: 1440, height: 900 } });
	let mock: Awaited<ReturnType<typeof createMockServer>>;

	test.beforeAll(async () => {
		mock = await createMockServer();
	});
	test.afterAll(async () => {
		await new Promise<void>((r) => mock.server.close(() => r()));
	});

	test("large session render time", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await waitForSessionItems(page);

		// Install MutationObserver before clicking to track when rendering finishes
		await page.evaluate(() => {
			(window as any).__perfLastMutation = performance.now();
			const observer = new MutationObserver(() => {
				(window as any).__perfLastMutation = performance.now();
			});
			observer.observe(document.body, { childList: true, subtree: true, attributes: true });
			(window as any).__perfObserver = observer;
		});

		// Click the session — this triggers subscribe → session_messages → full render
		await page.evaluate(() => {
			(window as any).__perfStart = performance.now();
			const picker = document.querySelector("session-picker") as any;
			const items = picker.shadowRoot.querySelectorAll(".session-item");
			if (items.length > 0) items[0].click();
		});

		// Wait for tool-message elements to appear
		await page.waitForFunction(
			(min) => document.querySelectorAll("tool-message").length >= min,
			Math.min(100, largeSessionMessages.filter((m: any) => m.role === "toolResult").length),
			{ timeout: 60000 },
		);

		// Wait for DOM to settle (no mutations for 500ms)
		await page.waitForFunction(
			() => performance.now() - (window as any).__perfLastMutation > 500,
			null,
			{ timeout: 60000, polling: 200 },
		);

		const metrics = await page.evaluate(() => {
			((window as any).__perfObserver as MutationObserver).disconnect();
			const start = (window as any).__perfStart as number;
			const lastMutation = (window as any).__perfLastMutation as number;

			return {
				renderTimeMs: Number((lastMutation - start).toFixed(1)),
				toolMessages: document.querySelectorAll("tool-message").length,
				totalElements: document.querySelectorAll("*").length,
			};
		});

		const fixtureSizeKB = (Buffer.byteLength(JSON.stringify(largeSessionMessages)) / 1024).toFixed(0);

		console.log(`\n━━━ Render Performance ━━━`);
		console.log(`  Fixture: ${largeSessionMessages.length} messages (${fixtureSizeKB}KB)`);
		console.log(`  tool-message elements: ${metrics.toolMessages}`);
		console.log(`  Total DOM elements: ${metrics.totalElements}`);
		console.log(`  Render time: ${metrics.renderTimeMs}ms`);
		console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

		// Budget: 10 seconds for a 10x session. Generous — the goal is to track regressions.
		expect(metrics.renderTimeMs).toBeLessThan(10000);
	});

	test("scroll performance after render", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await waitForSessionItems(page);

		// Open session
		await page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			picker.shadowRoot.querySelectorAll(".session-item")[0]?.click();
		});

		// Wait for render to complete
		await page.waitForFunction(
			(min) => document.querySelectorAll("tool-message").length >= min,
			Math.min(100, largeSessionMessages.filter((m: any) => m.role === "toolResult").length),
			{ timeout: 60000 },
		);
		await page.waitForTimeout(500); // let async rendering settle

		// Measure scroll frame times
		const scrollMetrics = await page.evaluate(async () => {
			// Find the scrollable container
			let scrollEl: Element | null = null;
			for (const el of document.querySelectorAll("*")) {
				if (el.scrollHeight > el.clientHeight + 500) {
					const style = getComputedStyle(el);
					if (style.overflowY === "auto" || style.overflowY === "scroll") {
						scrollEl = el;
						break;
					}
				}
			}

			if (!scrollEl) return { found: false, longFrames: 0, maxFrameMs: 0, avgFrameMs: 0 };

			// Scroll in 20 steps, measuring each frame
			const frameTimes: number[] = [];
			const step = Math.floor(scrollEl.scrollHeight / 20);

			for (let i = 0; i < 20; i++) {
				const before = performance.now();
				scrollEl.scrollTop += step;
				await new Promise<void>(r => requestAnimationFrame(() => r()));
				frameTimes.push(performance.now() - before);
			}

			const longFrames = frameTimes.filter(t => t > 50).length;

			return {
				found: true,
				longFrames,
				maxFrameMs: Number(Math.max(...frameTimes).toFixed(1)),
				avgFrameMs: Number((frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length).toFixed(1)),
				frameTimes: frameTimes.map(t => Number(t.toFixed(1))),
			};
		});

		console.log(`\n━━━ Scroll Performance ━━━`);
		if (scrollMetrics.found) {
			console.log(`  Long frames (>50ms): ${scrollMetrics.longFrames}/20`);
			console.log(`  Max frame: ${scrollMetrics.maxFrameMs}ms`);
			console.log(`  Avg frame: ${scrollMetrics.avgFrameMs}ms`);
			console.log(`  Frames: [${(scrollMetrics as any).frameTimes?.join(", ")}]`);
		} else {
			console.log(`  No scrollable container found`);
		}
		console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

		if (scrollMetrics.found) {
			// Most frames should be smooth (< 50ms)
			expect(scrollMetrics.longFrames).toBeLessThan(15);
		}
	});
});

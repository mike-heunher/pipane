/**
 * Render performance E2E tests.
 *
 * The mock initially exposes no sessions so the application cannot auto-render
 * the fixture before measurement begins. Each test reveals and opens the large
 * session through an explicit, observable transition.
 */

import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const CLIENT_DIST = path.resolve(import.meta.dirname, "../dist/client");
const FIXTURE_PATH = path.resolve(import.meta.dirname, "fixtures/large-session-messages.json");
if (!fs.existsSync(FIXTURE_PATH)) {
	const { execSync } = await import("node:child_process");
	execSync("npx tsx e2e/fixtures/generate-large-session.ts 10", {
		cwd: path.resolve(import.meta.dirname, ".."),
		stdio: "inherit",
	});
}
const largeSessionMessages: any[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const expectedToolMessages = largeSessionMessages.filter((message) => message.role === "toolResult").length;

const SESSION_PATH = "/tmp/mock-sessions/perf-test-session.jsonl";
const sessions = [{
	id: "perf-1",
	path: SESSION_PATH,
	cwd: "/Users/dev/project",
	name: "Render perf test",
	created: "2026-01-01T00:00:00.000Z",
	modified: "2026-01-01T00:10:00.000Z",
	lastUserPromptTime: "2026-01-01T00:10:00.000Z",
	messageCount: largeSessionMessages.length,
	firstMessage: "Performance test session",
}];

interface PerfMockServer {
	server: Server;
	wss: WebSocketServer;
	port: number;
	revealSession(): void;
	hideSession(): void;
	close(): Promise<void>;
}

function createMockServer(): Promise<PerfMockServer> {
	return new Promise((resolve) => {
		const app = express();
		const server = createServer(app);
		const wss = new WebSocketServer({ server, path: "/ws" });
		let sessionsVisible = false;

		app.use(express.static(CLIENT_DIST));
		app.get("/api/sessions", (_req, res) => res.json(sessionsVisible ? sessions : []));
		app.get("/api/sessions/messages", (_req, res) => res.json({ messages: largeSessionMessages }));
		app.get("/api/browse", (_req, res) => res.json({
			path: "/Users/dev",
			dirs: [{ name: "project", path: "/Users/dev/project" }],
		}));
		app.post("/api/debug/load-trace/event", express.json(), (_req, res) => res.json({}));

		wss.on("connection", (ws) => {
			ws.send(JSON.stringify({ type: "init", sessionStatuses: {} }));
			ws.on("message", (raw) => {
				const command = JSON.parse(raw.toString());
				if (!command.id) return;
				const respond = (data: any) => ws.send(JSON.stringify({
					type: "response",
					id: command.id,
					success: true,
					data,
				}));
				if (command.type === "get_default_model") {
					respond({ model: { provider: "anthropic", id: "claude-sonnet-4-20250514" }, thinkingLevel: "off" });
				} else if (command.type === "get_available_models") {
					respond({ models: [{ provider: "anthropic", id: "claude-sonnet-4-20250514" }] });
				} else if (command.type === "subscribe_session") {
					ws.send(JSON.stringify({
						type: "session_messages",
						sessionPath: command.sessionPath,
						messages: largeSessionMessages,
						model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
						thinkingLevel: "off",
					}));
					respond({});
				} else {
					respond({});
				}
			});
		});

		server.listen(0, () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				server,
				wss,
				port,
				revealSession: () => {
					sessionsVisible = true;
					for (const client of wss.clients) {
						if (client.readyState === WebSocket.OPEN) {
							client.send(JSON.stringify({ type: "sessions_changed", file: SESSION_PATH }));
						}
					}
				},
				hideSession: () => { sessionsVisible = false; },
				close: async () => {
					for (const client of wss.clients) client.terminate();
					await new Promise<void>((done) => wss.close(() => done()));
					await new Promise<void>((done) => server.close(() => done()));
				},
			});
		});
	});
}

async function revealSession(page: Page, mock: PerfMockServer): Promise<void> {
	mock.revealSession();
	await page.waitForFunction(() => {
		const picker = document.querySelector("session-picker") as any;
		return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) === 1;
	});
}

async function clickMeasuredSession(page: Page): Promise<void> {
	await page.evaluate(() => {
		const start = performance.now();
		(window as any).__perfStart = start;
		(window as any).__perfLastMutation = start;
		(window as any).__perfMutationCount = 0;
		const observer = new MutationObserver(() => {
			(window as any).__perfLastMutation = performance.now();
			(window as any).__perfMutationCount++;
		});
		observer.observe(document.body, { childList: true, subtree: true, attributes: true });
		(window as any).__perfObserver = observer;

		const picker = document.querySelector("session-picker") as any;
		const item = picker?.shadowRoot?.querySelector(".session-item") as HTMLElement | null;
		if (!item) throw new Error("Performance session item was not rendered");
		item.click();
	});
}

async function waitForExactFixture(page: Page): Promise<void> {
	await expect(page.locator("tool-message")).toHaveCount(expectedToolMessages, { timeout: 60_000 });
	await page.waitForFunction(() => {
		const start = (window as any).__perfStart as number;
		const lastMutation = (window as any).__perfLastMutation as number;
		const mutationCount = (window as any).__perfMutationCount as number;
		return mutationCount > 0 && lastMutation >= start && performance.now() - lastMutation > 500;
	}, null, { timeout: 60_000, polling: 100 });
}

test.describe("Render performance", () => {
	test.use({ viewport: { width: 1440, height: 900 } });
	let mock: PerfMockServer;

	test.beforeAll(async () => { mock = await createMockServer(); });
	test.afterAll(async () => { await mock.close(); });

	test.beforeEach(async ({ page }) => {
		mock.hideSession();
		await page.goto(`http://127.0.0.1:${mock.port}`);
		await expect(page.locator("message-editor")).toBeVisible({ timeout: 10_000 });
		await revealSession(page, mock);
	});

	test("large session render time", async ({ page }) => {
		await clickMeasuredSession(page);
		await waitForExactFixture(page);

		const metrics = await page.evaluate(() => {
			((window as any).__perfObserver as MutationObserver).disconnect();
			return {
				renderTimeMs: Number(((window as any).__perfLastMutation - (window as any).__perfStart).toFixed(1)),
				mutationCount: (window as any).__perfMutationCount as number,
				toolMessages: document.querySelectorAll("tool-message").length,
				totalElements: document.querySelectorAll("*").length,
			};
		});

		const fixtureSizeKB = (Buffer.byteLength(JSON.stringify(largeSessionMessages)) / 1024).toFixed(0);
		console.log("\n━━━ Render Performance ━━━");
		console.log(`  Fixture: ${largeSessionMessages.length} messages (${fixtureSizeKB}KB)`);
		console.log(`  tool-message elements: ${metrics.toolMessages}`);
		console.log(`  Total DOM elements: ${metrics.totalElements}`);
		console.log(`  Mutations observed: ${metrics.mutationCount}`);
		console.log(`  Render time: ${metrics.renderTimeMs}ms`);
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

		expect(metrics.mutationCount).toBeGreaterThan(0);
		expect(metrics.renderTimeMs).toBeGreaterThan(0);
		expect(metrics.renderTimeMs).toBeLessThan(10_000);
		expect(metrics.toolMessages).toBe(expectedToolMessages);
		expect(metrics.totalElements).toBeLessThan(220_000);
	});

	test("scroll performance after render", async ({ page }) => {
		await clickMeasuredSession(page);
		await waitForExactFixture(page);

		const scrollMetrics = await page.evaluate(async () => {
			((window as any).__perfObserver as MutationObserver).disconnect();
			const scrollElement = document.getElementById("chat-scroll-area");
			if (!scrollElement || scrollElement.scrollHeight <= scrollElement.clientHeight + 500) {
				return { found: false, longFrames: 0, maxFrameMs: 0, avgFrameMs: 0, frameTimes: [] as number[] };
			}

			scrollElement.scrollTop = 0;
			const frameTimes: number[] = [];
			const step = Math.max(1, Math.floor(scrollElement.scrollHeight / 20));
			for (let index = 0; index < 20; index++) {
				const before = performance.now();
				scrollElement.scrollTop += step;
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				frameTimes.push(performance.now() - before);
			}
			return {
				found: true,
				longFrames: frameTimes.filter((duration) => duration > 50).length,
				maxFrameMs: Number(Math.max(...frameTimes).toFixed(1)),
				avgFrameMs: Number((frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length).toFixed(1)),
				frameTimes: frameTimes.map((duration) => Number(duration.toFixed(1))),
			};
		});

		console.log("\n━━━ Scroll Performance ━━━");
		console.log(`  Scroll container found: ${scrollMetrics.found}`);
		console.log(`  Long frames (>50ms): ${scrollMetrics.longFrames}/20`);
		console.log(`  Max frame: ${scrollMetrics.maxFrameMs}ms`);
		console.log(`  Avg frame: ${scrollMetrics.avgFrameMs}ms`);
		console.log(`  Frames: [${scrollMetrics.frameTimes.join(", ")}]`);
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

		expect(scrollMetrics.found).toBe(true);
		expect(scrollMetrics.frameTimes).toHaveLength(20);
		// Generous CI-safe ceilings catch catastrophic regressions while tolerating
		// contention from the concurrently running real-stack worker.
		expect(scrollMetrics.avgFrameMs).toBeLessThan(150);
		expect(scrollMetrics.maxFrameMs).toBeLessThan(300);
	});
});

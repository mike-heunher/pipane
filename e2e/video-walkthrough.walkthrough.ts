/**
 * Video walkthrough e2e test — drives a REAL pipane server against a REAL model.
 *
 * Records via CDP Page.screencastFrame for real-time frame capture with
 * accurate timestamps, then encodes to high-quality mp4 with ffmpeg.
 *
 * Run (requires real API keys in ~/.pi/agent):
 *   npm run test:walkthrough
 *
 * Output:
 *   e2e/videos/walkthrough.mp4             — high-quality video
 *   e2e/videos/walkthrough.gif             — README-friendly animated preview
 *   e2e/screenshots/walkthrough-hero.png   — hero screenshot mid-stream
 *   e2e/screenshots/walkthrough-final.png  — final state
 */

import { test, expect, type Page, type CDPSession } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// ── CDP screencast recorder ──────────────────────────────────────────────

class ScreenRecorder {
	private framesDir: string;
	private frameIndex = 0;
	private page: Page;
	private cdp!: CDPSession;
	private timestamps: number[] = [];

	constructor(page: Page, framesDir: string) {
		this.page = page;
		this.framesDir = framesDir;
		fs.mkdirSync(framesDir, { recursive: true });
	}

	async start() {
		this.cdp = await this.page.context().newCDPSession(this.page);
		this.cdp.on("Page.screencastFrame", async (params: any) => {
			const framePath = path.join(
				this.framesDir,
				`frame-${String(this.frameIndex).padStart(6, "0")}.png`,
			);
			fs.writeFileSync(framePath, Buffer.from(params.data, "base64"));
			this.timestamps.push(params.metadata.timestamp as number);
			this.frameIndex++;
			try {
				await this.cdp.send("Page.screencastFrameAck", {
					sessionId: params.sessionId,
				});
			} catch { /* session may be closed */ }
		});
		await this.cdp.send("Page.startScreencast", {
			format: "png",
			quality: 100,
			everyNthFrame: 1,
		});
	}

	async stop() {
		try {
			await this.cdp.send("Page.stopScreencast");
			await this.cdp.detach();
		} catch { /* already closed */ }
	}

	encode(outputPath: string) {
		if (this.frameIndex === 0) return;
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });

		// Build a concat demuxer file with per-frame durations from real timestamps
		const concatPath = path.join(this.framesDir, "frames.txt");
		const lines: string[] = [];
		for (let i = 0; i < this.frameIndex; i++) {
			const framePath = path.join(this.framesDir, `frame-${String(i).padStart(6, "0")}.png`);
			let duration: number;
			if (i < this.frameIndex - 1) {
				duration = this.timestamps[i + 1] - this.timestamps[i];
				// Clamp to sane range (10ms–2s) in case of timestamp glitches
				duration = Math.max(0.01, Math.min(2, duration));
			} else {
				duration = 0.05; // last frame: hold briefly
			}
			lines.push(`file '${framePath}'`);
			lines.push(`duration ${duration.toFixed(6)}`);
		}
		fs.writeFileSync(concatPath, lines.join("\n") + "\n");

		execSync(
			`ffmpeg -y -f concat -safe 0 -i "${concatPath}" ` +
			`-c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p ` +
			`-vf "scale=2560:1600:flags=lanczos" "${outputPath}"`,
			{ stdio: "pipe" },
		);
	}

	cleanup() {
		try { fs.rmSync(this.framesDir, { recursive: true, force: true }); } catch { /* */ }
	}

	get frameCount() { return this.frameIndex; }
}

// ── Infrastructure ────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") { server.close(); reject(new Error("no port")); return; }
			const port = addr.port;
			server.close((err) => (err ? reject(err) : resolve(port)));
		});
		server.on("error", reject);
	});
}

async function waitForPort(port: number, timeoutMs = 30000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`http://localhost:${port}/api/sessions`);
			if (res.ok) return;
		} catch { /* not ready */ }
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`Timed out waiting for port ${port}`);
}

interface RealServer {
	port: number;
	projectDir: string;
	close(): Promise<void>;
}

function seedFakeSessions(sessionsDir: string) {
	const projects = [
		{ cwd: "/Users/dev/acme-web", dir: "--Users-dev-acme-web--" },
		{ cwd: "/Users/dev/api-server", dir: "--Users-dev-api-server--" },
	];

	interface FakeSession {
		project: number;
		name: string;
		firstMessage: string;
		response: string;
		ageMs: number;
		messages: number;
	}

	const fakeSessions: FakeSession[] = [
		{
			project: 0, name: "Fix auth token refresh",
			firstMessage: "The JWT refresh token flow is broken — users get logged out after 15 minutes. Can you fix the token refresh logic in src/auth/refresh.ts?",
			response: "I'll look at the token refresh implementation and fix the timing issue.",
			ageMs: 2 * 3600_000, messages: 24,
		},
		{
			project: 0, name: "Add dark mode support",
			firstMessage: "Add dark mode support to the app. We're using Tailwind — add a theme toggle in the navbar and persist the preference.",
			response: "I'll add a dark mode toggle using Tailwind's dark variant and localStorage for persistence.",
			ageMs: 5 * 3600_000, messages: 18,
		},
		{
			project: 0, name: "Optimize bundle size",
			firstMessage: "Our production bundle is 2.4MB. Can you analyze what's large and help reduce it?",
			response: "Let me analyze the bundle and find opportunities to reduce its size.",
			ageMs: 24 * 3600_000, messages: 31,
		},
		{
			project: 1, name: "Add rate limiting middleware",
			firstMessage: "Add rate limiting to the API endpoints. Use a sliding window approach, 100 req/min per API key.",
			response: "I'll implement a sliding window rate limiter using Redis.",
			ageMs: 3 * 3600_000, messages: 16,
		},
		{
			project: 1, name: "Database migration for user roles",
			firstMessage: "We need to add role-based access control. Create a migration that adds a roles table and a user_roles join table.",
			response: "I'll create the migration with proper foreign keys and indexes.",
			ageMs: 48 * 3600_000, messages: 12,
		},
		{
			project: 1, name: "Write integration tests",
			firstMessage: "Write integration tests for the /api/orders endpoints. Cover create, list, get by id, and cancel flows.",
			response: "I'll write comprehensive integration tests for the orders API.",
			ageMs: 72 * 3600_000, messages: 42,
		},
	];

	for (const session of fakeSessions) {
		const proj = projects[session.project];
		const dir = path.join(sessionsDir, proj.dir);
		fs.mkdirSync(dir, { recursive: true });

		const created = new Date(Date.now() - session.ageMs);
		const id = crypto.randomUUID();
		const ts = created.toISOString();
		const msgTs = created.getTime();

		const lines = [
			JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: proj.cwd }),
			JSON.stringify({ type: "session_info", id: crypto.randomUUID().slice(0, 8), parentId: null, timestamp: ts, name: session.name }),
			JSON.stringify({
				type: "message", id: crypto.randomUUID().slice(0, 8), parentId: null, timestamp: ts,
				message: { role: "user", content: [{ type: "text", text: session.firstMessage }], timestamp: msgTs },
			}),
			JSON.stringify({
				type: "message", id: crypto.randomUUID().slice(0, 8), parentId: null, timestamp: ts,
				message: {
					role: "assistant",
					content: [{ type: "text", text: session.response }],
					usage: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 1280, cost: { input: 0.006, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.008 } },
					stopReason: "end_turn", timestamp: msgTs + 3000,
				},
			}),
		];

		// Pad extra empty message pairs to hit the message count
		for (let i = 2; i < session.messages; i += 2) {
			const t = msgTs + i * 30000;
			lines.push(JSON.stringify({
				type: "message", id: crypto.randomUUID().slice(0, 8), parentId: null, timestamp: new Date(t).toISOString(),
				message: { role: "user", content: [{ type: "text", text: "continue" }], timestamp: t },
			}));
			lines.push(JSON.stringify({
				type: "message", id: crypto.randomUUID().slice(0, 8), parentId: null, timestamp: new Date(t + 2000).toISOString(),
				message: {
					role: "assistant", content: [{ type: "text", text: "Done." }],
					usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 520, cost: { input: 0.0025, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
					stopReason: "end_turn", timestamp: t + 2000,
				},
			}));
		}

		const filename = `${ts.replace(/[:.]/g, "-")}_${id}.jsonl`;
		fs.writeFileSync(path.join(dir, filename), lines.join("\n") + "\n");
	}
}

async function startRealServer(): Promise<RealServer> {
	const port = await getFreePort();
	const tmpBase = path.join("/tmp", `pi-walkthrough-${Date.now()}`);
	const projectDir = path.join(tmpBase, "project");
	const agentDir = path.join(tmpBase, "agent");
	const sessionsDir = path.join(agentDir, "sessions");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(sessionsDir, { recursive: true });

	// Copy real models.json + settings so the real model config is available
	const realAgentDir = path.join(process.env.HOME!, ".pi", "agent");
	for (const f of ["models.json", "settings.json", "auth.json"]) {
		const src = path.join(realAgentDir, f);
		if (fs.existsSync(src)) {
			fs.cpSync(src, path.join(agentDir, f));
		}
	}

	// Force thinking level to medium for the walkthrough
	const piSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
	piSettings.defaultThinkingLevel = "medium";
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(piSettings, null, 2));

	// Seed fake old sessions so the sidebar looks populated
	seedFakeSessions(sessionsDir);

	// Write pipane local settings
	const piwebDir = path.join(tmpBase, "home", ".piweb");
	fs.mkdirSync(piwebDir, { recursive: true });
	fs.writeFileSync(
		path.join(piwebDir, "settings.json"),
		JSON.stringify({
			version: 1,
			sidebar: { cwdTitle: { filters: [] }, sessionsPerProject: 5 },
			canvas: { enabled: false },
			appearance: { colorTheme: "gruvbox", darkMode: "dark", showTokenUsage: true },
			toolCollapse: { keepOpen: 1 },
		}, null, 2),
	);

	const serverScript = path.resolve(import.meta.dirname, "../dist/server/server/server.js");
	if (!fs.existsSync(serverScript)) throw new Error("Run 'npm run build' first");

	const fakeHome = path.join(tmpBase, "home");
	const child: ChildProcess = spawn("node", [serverScript], {
		env: {
			...process.env,
			PORT: String(port),
			PI_CWD: projectDir,
			PI_CODING_AGENT_DIR: agentDir,
			HOME: fakeHome,
			NODE_ENV: "production",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "", stderr = "";
	child.stdout?.on("data", (d) => { stdout += d.toString(); });
	child.stderr?.on("data", (d) => { stderr += d.toString(); });

	try {
		await waitForPort(port);
	} catch (err) {
		console.error("[pipane] stdout:", stdout);
		console.error("[pipane] stderr:", stderr);
		child.kill("SIGTERM");
		throw err;
	}

	return {
		port,
		projectDir,
		close: async () => {
			child.kill("SIGTERM");
			await new Promise<void>((r) => {
				child.on("exit", () => r());
				setTimeout(r, 3000);
			});
			try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* */ }
		},
	};
}

// ── Test ──────────────────────────────────────────────────────────────────

test.use({
	viewport: { width: 1280, height: 800 },
	colorScheme: "dark",
	deviceScaleFactor: 2,
});
test.skip(!process.env.RUN_WALKTHROUGH, "Skipped unless RUN_WALKTHROUGH=1 is set");

let server: RealServer;
let activeRecorder: ScreenRecorder | undefined;

test.beforeAll(async () => {
	// Fail before starting a real model run if media encoding is unavailable.
	execSync("ffmpeg -version", { stdio: "ignore" });
	server = await startRealServer();
}, 60000);

test.afterAll(async () => {
	await server?.close();
});

test.afterEach(async () => {
	await activeRecorder?.stop();
	activeRecorder?.cleanup();
	activeRecorder = undefined;
});

test("walkthrough — build todo app + parallel bash counter", async ({ page }) => {
	test.setTimeout(180000);

	const screenshotDir = path.resolve(import.meta.dirname, "screenshots");
	fs.mkdirSync(screenshotDir, { recursive: true });

	const framesDir = path.join("/tmp", `pi-walkthrough-frames-${Date.now()}`);
	const recorder = new ScreenRecorder(page, framesDir);
	activeRecorder = recorder;

	// Force dark + gruvbox theme
	await page.addInitScript(() => {
		localStorage.setItem("theme", "dark");
		localStorage.setItem("color-theme", "gruvbox");
	});

	await page.goto(`http://localhost:${server.port}`);

	// Wait for the editor to be ready
	const editor = page.locator("message-editor");
	await expect(editor).toBeVisible({ timeout: 15000 });
	await expect(editor.locator("textarea").first()).toBeEnabled({ timeout: 10000 });

	// Wait for initial seeded-session restoration to finish before replacing it.
	// Otherwise the late auto-load can race and overwrite the virtual session.
	await page.waitForFunction(() => {
		const picker = document.querySelector("session-picker") as any;
		const itemCount = picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0;
		return itemCount > 0 && !!picker?.agent?.sessionFile;
	});
	await page.evaluate(async (cwd) => {
		const picker = document.querySelector("session-picker") as any;
		await picker.agent.newSession(cwd);
	}, server.projectDir);
	await page.waitForFunction((cwd) => {
		const agent = (document.querySelector("session-picker") as any)?.agent;
		return agent?.sessionStatus === "virtual"
			&& agent?.cwd === cwd
			&& !agent?.sessionFile
			&& agent?.state?.messages?.length === 0;
	}, server.projectDir);

	/** Type text character by character with a natural delay. */
	async function typeNaturally(text: string, delayMs = 40) {
		await editor.locator("textarea").first().pressSequentially(text, { delay: delayMs });
	}

	// ── Start recording ───────────────────────────────────────────
	await recorder.start();

	// Pause — let viewer see the empty state
	await page.waitForTimeout(2000);

	// ── Session 1: Build a Todo App ───────────────────────────────
	await typeNaturally("Build a polished single-page todo app in the current directory using index.html, styles.css, and app.js. Use tools to create the files, then briefly summarize what you built. Do not start a server.");
	await page.waitForTimeout(800);
	await editor.locator("textarea").first().press("Enter");

	await page.waitForFunction((cwd) => {
		const agent = (document.querySelector("session-picker") as any)?.agent;
		return agent?.sessionStatus !== "virtual" && agent?.cwd === cwd && !!agent?.sessionFile;
	}, server.projectDir, { timeout: 30_000 });
	const sessionOnePath = await page.evaluate(() =>
		(document.querySelector("session-picker") as any).agent.sessionFile as string,
	);

	// This task must visibly exercise tools; an error-only response is not media.
	await expect(page.locator("tool-message").first()).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => page.evaluate(() =>
		(document.querySelector("session-picker") as any)?.agent?.state?.error,
	)).toBeFalsy();
	await page.waitForTimeout(8000);

	// ── Hero screenshot ───────────────────────────────────────────
	await page.screenshot({
		path: path.join(screenshotDir, "walkthrough-hero.png"),
	});

	// Let it keep working
	await page.waitForTimeout(5000);

	// ── Session 2: Parallel bash counter ──────────────────────────
	await page.evaluate(async (cwd) => {
		const picker = document.querySelector("session-picker") as any;
		await picker.agent.newSession(cwd);
	}, server.projectDir);
	await page.waitForFunction((cwd) => {
		const agent = (document.querySelector("session-picker") as any)?.agent;
		return agent?.sessionStatus === "virtual" && agent?.cwd === cwd && !agent?.sessionFile;
	}, server.projectDir);

	await expect(editor.locator("textarea").first()).toBeEnabled({ timeout: 5000 });
	await typeNaturally("Count from 1 to 100 in bash, with a small sleep between each number");
	await page.waitForTimeout(800);
	await editor.locator("textarea").first().press("Enter");
	await page.waitForFunction(([cwd, firstPath]) => {
		const agent = (document.querySelector("session-picker") as any)?.agent;
		return agent?.sessionStatus !== "virtual"
			&& agent?.cwd === cwd
			&& !!agent?.sessionFile
			&& agent.sessionFile !== firstPath;
	}, [server.projectDir, sessionOnePath], { timeout: 30_000 });
	const sessionTwoPath = await page.evaluate(() =>
		(document.querySelector("session-picker") as any).agent.sessionFile as string,
	);

	const switchToSession = async (sessionPath: string) => {
		await page.evaluate(async (targetPath) => {
			const picker = document.querySelector("session-picker") as any;
			await picker.agent.switchSession(targetPath);
		}, sessionPath);
		await page.waitForFunction((targetPath) => {
			const agent = (document.querySelector("session-picker") as any)?.agent;
			return agent?.sessionFile === targetPath && agent?.state?.messages?.length > 0;
		}, sessionPath);
	};

	// Watch session 2 work for a bit, then demonstrate parallel navigation.
	await page.waitForTimeout(5000);
	await switchToSession(sessionOnePath);
	await page.waitForTimeout(4000);
	await switchToSession(sessionTwoPath);
	await page.waitForTimeout(4000);
	await switchToSession(sessionOnePath);
	await page.waitForTimeout(4000);

	// Wait for session 1 to settle and reject failed/error-only recordings.
	await page.waitForFunction((targetPath) => {
		const agent = (document.querySelector("session-picker") as any)?.agent;
		return agent?.sessionFile === targetPath
			&& agent?.getSessionStatus(targetPath) !== "running"
			&& agent?.state?.isStreaming === false;
	}, sessionOnePath, { timeout: 120_000 });
	await expect.poll(() => page.evaluate(() =>
		(document.querySelector("session-picker") as any)?.agent?.state?.error,
	)).toBeFalsy();
	await expect(page.getByText(/Prompt failed:/)).toHaveCount(0);
	await page.waitForTimeout(2000);

	// ── Final screenshot ──────────────────────────────────────────
	await page.screenshot({
		path: path.join(screenshotDir, "walkthrough-final.png"),
	});
	await page.waitForTimeout(2000);

	// ── Stop recording & encode ───────────────────────────────────
	await recorder.stop();

	const videoDir = path.resolve(import.meta.dirname, "videos");
	const outputPath = path.join(videoDir, "walkthrough.mp4");
	const gifPath = path.join(videoDir, "walkthrough.gif");
	const palettePath = path.join(videoDir, "walkthrough-palette.png");
	console.log(`Captured ${recorder.frameCount} frames, encoding...`);
	recorder.encode(outputPath);
	recorder.cleanup();
	activeRecorder = undefined;

	// Convert MP4 -> GIF for README embedding
	execSync(
		`ffmpeg -y -i "${outputPath}" -vf "fps=12,scale=1600:-1:flags=lanczos,palettegen" "${palettePath}"`,
		{ stdio: "pipe" },
	);
	execSync(
		`ffmpeg -y -i "${outputPath}" -i "${palettePath}" -lavfi "fps=12,scale=1600:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" "${gifPath}"`,
		{ stdio: "pipe" },
	);
	try { fs.rmSync(palettePath, { force: true }); } catch { /* */ }

	console.log(`Video: ${outputPath}`);
	console.log(`GIF: ${gifPath}`);

	// Done — the video and screenshots are the real output
	expect(fs.existsSync(path.join(screenshotDir, "walkthrough-hero.png"))).toBe(true);
	expect(fs.existsSync(gifPath)).toBe(true);
});

/**
 * E2E test: new sessions stay in their project/cwd group in the sidebar.
 *
 * Verifies that when a user creates a new session via the "+" button on a
 * project group, the session remains in that group throughout the lifecycle:
 * before sending a message, while the LLM responds, and after the response.
 */

import { test, expect, type Page } from "@playwright/test";
import { startHarness, type E2EHarness } from "./harness.js";
import { textChunks } from "./mock-llm-server.js";

/**
 * Get the cwd of the group that contains the active (.active) session item.
 * Returns null if no active session is found.
 */
async function getActiveSessionGroupCwd(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const picker = document.querySelector("session-picker");
		if (!picker?.shadowRoot) return null;

		const active = picker.shadowRoot.querySelector(".session-item.active");
		if (!active) return null;

		// Walk backwards from the active item to find its group header
		let el: Element | null = active;
		while (el) {
			el = el.previousElementSibling;
			if (el?.classList.contains("group-header")) {
				return el.getAttribute("title");
			}
		}
		return null;
	});
}

/**
 * Get all group cwds visible in the session picker.
 */
async function getAllGroupCwds(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const picker = document.querySelector("session-picker");
		if (!picker?.shadowRoot) return [];
		const headers = picker.shadowRoot.querySelectorAll(".group-header");
		return Array.from(headers).map((h) => h.getAttribute("title") || "");
	});
}

/**
 * Count session items in the session picker.
 */
async function getSessionCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const picker = document.querySelector("session-picker");
		if (!picker?.shadowRoot) return 0;
		return picker.shadowRoot.querySelectorAll(".session-item").length;
	});
}

/**
 * Click the "+" button on the group with the given cwd.
 */
async function clickGroupNewButton(page: Page, cwd: string): Promise<void> {
	await page.evaluate((targetCwd) => {
		const picker = document.querySelector("session-picker");
		if (!picker?.shadowRoot) throw new Error("No session-picker");
		const headers = picker.shadowRoot.querySelectorAll(".group-header");
		for (const header of headers) {
			if (header.getAttribute("title") === targetCwd) {
				const btn = header.querySelector(".group-new-btn") as HTMLButtonElement;
				if (!btn) throw new Error("No + button found in group header");
				btn.click();
				return;
			}
		}
		throw new Error(`No group with cwd "${targetCwd}" found`);
	}, cwd);
}

test.describe("Session CWD stability", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	let harness: E2EHarness;

	test.beforeAll(async () => {
		harness = await startHarness();
	}, 30000);

	test.afterAll(async () => {
		await harness?.close();
	});

	test("new session from group '+' stays in the correct project group", async ({ page }) => {
		// Use a slow response so we can observe the session during streaming
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("This is the first response from the mock LLM.") },
		]);

		// Step 1: Go to the app and send a first prompt to establish a project group
		await page.goto(`http://localhost:${harness.piWebPort}`);
		await page.waitForTimeout(2000);

		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible();
		const textarea = editor.locator("textarea").first();
		await textarea.fill("First session message");
		await textarea.press("Meta+Enter");

		// Wait for the response to complete
		await expect(
			page.getByText("first response from the mock", { exact: false }),
		).toBeVisible({ timeout: 15000 });

		// Wait for sidebar to settle
		await page.waitForTimeout(2000);

		// Discover the actual project cwd as the server sees it (may differ due to
		// macOS /tmp → /private/tmp symlink resolution).
		const groups = await getAllGroupCwds(page);
		expect(groups.length).toBeGreaterThanOrEqual(1);
		// Find the group whose cwd ends with our project dir's basename
		const projectBasename = harness.projectDir.split("/").pop()!;
		const projectCwd = groups.find((g) => g.endsWith(projectBasename));
		expect(projectCwd).toBeTruthy();

		// The active session should be in the project group
		const activeCwd1 = await getActiveSessionGroupCwd(page);
		expect(activeCwd1).toBe(projectCwd);

		// Step 2: Click the "+" button on the project group to create a new session
		await clickGroupNewButton(page, projectCwd!);
		await page.waitForTimeout(500);

		// The new (virtual) session should immediately appear in the correct group
		const activeCwdAfterNew = await getActiveSessionGroupCwd(page);
		expect(activeCwdAfterNew).toBe(projectCwd);

		// Step 3: Set up a new scenario and send a message in the new session
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("This is the second session response.") },
		]);

		const textarea2 = editor.locator("textarea").first();
		await textarea2.fill("Second session message");

		// Check the session is still in the right group right before sending
		const activeCwdBeforeSend = await getActiveSessionGroupCwd(page);
		expect(activeCwdBeforeSend).toBe(projectCwd);

		// Send the message
		await textarea2.press("Meta+Enter");

		// Step 4: Poll the active session's group cwd repeatedly during streaming.
		// The session must NEVER leave the project group.
		const pollResults: Array<{ time: number; cwd: string | null; debug?: string }> = [];
		const startTime = Date.now();

		// Poll for up to 10 seconds (covers the streaming + settlement period)
		while (Date.now() - startTime < 10000) {
			const info = await page.evaluate(() => {
				const picker = document.querySelector("session-picker") as any;
				if (!picker?.shadowRoot) return { cwd: null, debug: "no picker" };

				// Dump all sessions data for debugging
				const allSessions = (picker as any).sessions as Array<{id: string, path: string, cwd: string, firstMessage: string}>;
				const sessionSummary = allSessions?.map((s: any) => `[${s.id?.slice(0,8)} cwd=${s.cwd?.slice(-30)||'""'} msg=${s.firstMessage?.slice(0,20)}]`).join(", ") || "?";

				const active = picker.shadowRoot.querySelector(".session-item.active");
				if (!active) {
					return { cwd: null, debug: `no active | sessions: ${sessionSummary}` };
				}

				// Walk backwards to find group header
				let el: Element | null = active;
				let groupCwd: string | null = null;
				while (el) {
					el = el.previousElementSibling;
					if (el?.classList.contains("group-header")) {
						groupCwd = el.getAttribute("title");
						break;
					}
				}

				const title = active.getAttribute("title") || "";
				return { cwd: groupCwd, debug: `active: ${title.slice(0, 60)} | sessions: ${sessionSummary}` };
			});
			pollResults.push({ time: Date.now() - startTime, cwd: info.cwd, debug: info.debug });

			// Break early once we see the response is complete
			const hasResponse = await page
				.getByText("second session response", { exact: false })
				.isVisible()
				.catch(() => false);
			if (hasResponse) {
				// Poll a few more times to catch any post-completion drift
				for (let i = 0; i < 5; i++) {
					await page.waitForTimeout(200);
					const cwdPost = await getActiveSessionGroupCwd(page);
					pollResults.push({ time: Date.now() - startTime, cwd: cwdPost });
				}
				break;
			}
			await page.waitForTimeout(100);
		}

		// Verify: the session was NEVER outside the project group
		const wrongResults = pollResults.filter(
			(r) => r.cwd !== null && r.cwd !== projectCwd,
		);

		if (wrongResults.length > 0) {
			const summary = pollResults
				.map((r) => `  ${r.time}ms: cwd=${r.cwd} | ${r.debug || ""}`)
				.join("\n");
			throw new Error(
				`Session moved out of project group during streaming!\n` +
				`Expected: ${projectCwd}\n` +
				`Wrong results: ${JSON.stringify(wrongResults)}\n` +
				`Full timeline:\n${summary}`,
			);
		}

		// Also verify the session eventually settled in the right group
		const finalCwd = pollResults[pollResults.length - 1]?.cwd;
		expect(finalCwd).toBe(projectCwd);
	});
});

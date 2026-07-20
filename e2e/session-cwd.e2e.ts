/**
 * E2E test: new sessions stay in their project/cwd group in the sidebar.
 *
 * Verifies that when a user creates a new session via the "+" button on a
 * project group, the session remains in that group throughout the lifecycle:
 * before sending a message, while the LLM responds, and after the response.
 */

import { type Page } from "@playwright/test";
import { test, expect } from "./real-stack-fixture.js";
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

	test("new session from group '+' stays in the correct project group", async ({ page, harness }) => {
		// Use a slow response so we can observe the session during streaming
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("This is the first response from the mock LLM.") },
		]);

		// Step 1: Go to the app and send a first prompt to establish a project group
		await page.goto(`http://localhost:${harness.pipanePort}`);

		const editor = page.locator("message-editor");
		await expect(editor).toBeVisible({ timeout: 10000 });
		const textarea = editor.locator("textarea").first();
		const existingSessionCount = await getSessionCount(page);
		if (existingSessionCount > 0) {
			const existingGroups = await getAllGroupCwds(page);
			const projectBasename = harness.projectDir.split("/").pop()!;
			const existingProjectCwd = existingGroups.find((cwd) => cwd.endsWith(projectBasename));
			expect(existingProjectCwd).toBeTruthy();
			await clickGroupNewButton(page, existingProjectCwd!);
			await expect.poll(async () => page.evaluate(() => {
				const picker = document.querySelector("session-picker") as any;
				return picker?.agent?.sessionStatus;
			})).toBe("virtual");
		}
		await textarea.fill("First session message");
		await textarea.press("Meta+Enter");

		// Wait for the response to complete
		await expect(
			page.getByText("first response from the mock", { exact: false }),
		).toBeVisible({ timeout: 15000 });

		// Wait for sidebar to have at least one session item
		await page.waitForFunction(() => {
			const picker = document.querySelector("session-picker") as any;
			return (picker?.shadowRoot?.querySelectorAll(".session-item")?.length ?? 0) >= 1;
		}, null, { timeout: 10000 });

		// Discover the actual project cwd as the server sees it (may differ due to
		// macOS /tmp → /private/tmp symlink resolution).
		const groups = await getAllGroupCwds(page);
		expect(groups.length).toBeGreaterThanOrEqual(1);
		// Find the group whose cwd ends with our project dir's basename
		const projectBasename = harness.projectDir.split("/").pop()!;
		const projectCwd = groups.find((g) => g.endsWith(projectBasename));
		expect(projectCwd).toBeTruthy();

		// On macOS, /tmp is a symlink to /private/tmp. The server may resolve it
		// to the real path after session creation. Normalize for comparison.
		const normalizeCwd = (p: string) => p.replace(/^\/private\/tmp\//, "/tmp/");

		// Session-list refresh can briefly replace the active Lit node after the
		// response; wait for the authoritative active item to settle.
		await expect.poll(async () => {
			const activeCwd = await getActiveSessionGroupCwd(page);
			return activeCwd ? normalizeCwd(activeCwd) : null;
		}).toBe(normalizeCwd(projectCwd!));

		// Step 2: Click the "+" button on the project group to create a new session.
		// The visible count can remain capped when the shared harness already has
		// several sessions, so observe the authoritative virtual-session state.
		await clickGroupNewButton(page, projectCwd!);
		await expect.poll(async () => page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			return picker?.agent?.sessionStatus;
		})).toBe("virtual");

		// The new (virtual) session should appear in the correct group.
		await expect.poll(async () => {
			const activeCwd = await getActiveSessionGroupCwd(page);
			return activeCwd ? normalizeCwd(activeCwd) : null;
		}).toBe(normalizeCwd(projectCwd!));

		// Step 3: Set up a new scenario and send a message in the new session
		harness.setScenarios([
			{ match: /.*/, chunks: textChunks("This is the second session response.") },
		]);

		const textarea2 = editor.locator("textarea").first();
		await textarea2.fill("Second session message");

		// Check the session is still in the right group right before sending.
		await expect.poll(async () => {
			const activeCwd = await getActiveSessionGroupCwd(page);
			return activeCwd ? normalizeCwd(activeCwd) : null;
		}).toBe(normalizeCwd(projectCwd!));

		// Observe every sidebar mutation before sending. This catches transient
		// regrouping without wall-clock polling sleeps.
		await page.evaluate(() => {
			const picker = document.querySelector("session-picker") as any;
			if (!picker?.shadowRoot) throw new Error("No session picker to observe");
			const startedAt = performance.now();
			const observations: Array<{ time: number; cwd: string | null; debug: string }> = [];
			const record = () => {
				const allSessions = picker.sessions as Array<{ id: string; cwd: string; firstMessage: string }>;
				const sessionSummary = allSessions?.map((session: any) =>
					`[${session.id?.slice(0, 8)} cwd=${session.cwd?.slice(-30) || '""'} msg=${session.firstMessage?.slice(0, 20)}]`
				).join(", ") || "?";
				const active = picker.shadowRoot.querySelector(".session-item.active");
				let element: Element | null = active;
				let groupCwd: string | null = null;
				while (element) {
					element = element.previousElementSibling;
					if (element?.classList.contains("group-header")) {
						groupCwd = element.getAttribute("title");
						break;
					}
				}
				observations.push({
					time: Number((performance.now() - startedAt).toFixed(1)),
					cwd: groupCwd,
					debug: active
						? `active: ${(active.getAttribute("title") || "").slice(0, 60)} | sessions: ${sessionSummary}`
						: `no active | sessions: ${sessionSummary}`,
				});
			};
			record();
			const observer = new MutationObserver(record);
			observer.observe(picker.shadowRoot, { childList: true, subtree: true, attributes: true });
			(window as any).__cwdObserver = observer;
			(window as any).__cwdObservations = observations;
		});

		await textarea2.press("Meta+Enter");
		await expect(page.getByText("second session response", { exact: false })).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(".status-stop-button")).toBeHidden({ timeout: 10_000 });
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));
		const pollResults = await page.evaluate(() => {
			((window as any).__cwdObserver as MutationObserver).disconnect();
			return (window as any).__cwdObservations as Array<{ time: number; cwd: string | null; debug: string }>;
		});

		// Verify: the session was NEVER outside the project group
		// (normalize to handle macOS /tmp → /private/tmp symlink)
		const normalizedProjectCwd = normalizeCwd(projectCwd!);
		const wrongResults = pollResults.filter(
			(r) => r.cwd !== null && normalizeCwd(r.cwd) !== normalizedProjectCwd,
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

		// Also verify the current authoritative DOM eventually settled in the
		// right group; a Lit replacement may produce a transient no-active item.
		await expect.poll(async () => {
			const finalCwd = await getActiveSessionGroupCwd(page);
			return finalCwd ? normalizeCwd(finalCwd) : null;
		}, {
			timeout: 10_000,
			message: "Expected the settled session to remain active in its project group",
		}).toBe(normalizedProjectCwd);
	});
});

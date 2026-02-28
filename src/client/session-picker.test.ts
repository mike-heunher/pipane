/**
 * Tests for the session-picker sidebar component.
 *
 * Verifies:
 * - Sessions are sorted by lastUserPromptTime (most recent first)
 * - Running sessions are pinned to top within their group
 * - Status badges ("running" / "done") render correctly
 * - Groups are sorted by most recent session activity
 * - Search filtering works
 * - "Show more" truncation works
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockAgent, createSession, resetSessionCounter, type SessionOptions } from "../test/mock-agent.js";
import "./session-picker.js";
import type { SessionPicker } from "./session-picker.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a session-picker element wired to a MockAgent, wait for first render. */
async function createPicker(agent: MockAgent): Promise<SessionPicker> {
	const el = document.createElement("session-picker") as SessionPicker;
	(el as any).agent = agent;
	document.body.appendChild(el);
	// Wait for connectedCallback + loadSessions + Lit render
	await el.updateComplete;
	// loadSessions is async, wait for it to finish and re-render
	await new Promise((r) => setTimeout(r, 50));
	await el.updateComplete;
	return el;
}

/** Query rendered session items from the shadow DOM. */
function getSessionItems(el: SessionPicker): HTMLButtonElement[] {
	return Array.from(el.shadowRoot!.querySelectorAll(".session-item"));
}

/** Query rendered group headers from the shadow DOM. */
function getGroupHeaders(el: SessionPicker): HTMLElement[] {
	return Array.from(el.shadowRoot!.querySelectorAll(".group-header"));
}

/** Get the session display name from a rendered session item. */
function getSessionName(item: HTMLElement): string {
	return item.querySelector(".session-name")?.textContent?.trim() ?? "";
}

/** Get the group label text from a group header. */
function getGroupLabel(header: HTMLElement): string {
	return header.querySelector(".group-label")?.textContent?.trim() ?? "";
}

/** Get all status badges from a session item. */
function getStatusBadges(item: HTMLElement): HTMLElement[] {
	return Array.from(item.querySelectorAll(".status-badge"));
}

/** Check if a session item has a "running" badge. */
function hasRunningBadge(item: HTMLElement): boolean {
	return getStatusBadges(item).some((b) => b.classList.contains("running"));
}

/** Check if a session item has a "done" badge. */
function hasDoneBadge(item: HTMLElement): boolean {
	return getStatusBadges(item).some((b) => b.classList.contains("done"));
}

/** Get the search input element. */
function getSearchInput(el: SessionPicker): HTMLInputElement | null {
	return el.shadowRoot!.querySelector(".search input");
}

/** Get "show more" buttons. */
function getShowMoreButtons(el: SessionPicker): HTMLButtonElement[] {
	return Array.from(el.shadowRoot!.querySelectorAll(".show-more-btn"));
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	resetSessionCounter();
	document.body.innerHTML = "";
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("session-picker", () => {
	describe("sorting by lastUserPromptTime", () => {
		it("sorts sessions with most recent user prompt first", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					name: "Old session",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T08:00:00.000Z",
				}),
				createSession({
					name: "Recent session",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T11:00:00.000Z",
				}),
				createSession({
					name: "Middle session",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T09:30:00.000Z",
				}),
			]);

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items).toHaveLength(3);
			expect(getSessionName(items[0])).toBe("Recent session");
			expect(getSessionName(items[1])).toBe("Middle session");
			expect(getSessionName(items[2])).toBe("Old session");
		});

		it("falls back to modified time when lastUserPromptTime is missing", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					name: "No prompt time",
					cwd: "/home/user/project",
					modified: "2026-02-28T10:00:00.000Z",
					// no lastUserPromptTime
				}),
				createSession({
					name: "Has prompt time",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T11:00:00.000Z",
				}),
			]);

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items).toHaveLength(2);
			expect(getSessionName(items[0])).toBe("Has prompt time");
			expect(getSessionName(items[1])).toBe("No prompt time");
		});
	});

	describe("running sessions pinned to top", () => {
		it("pins running sessions above non-running sessions", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({
					name: "Idle old",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T08:00:00.000Z",
				}),
				createSession({
					name: "Idle recent",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T11:00:00.000Z",
				}),
				createSession({
					name: "Running session",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T07:00:00.000Z",
				}),
			];
			agent.setSessions(sessions);
			// Mark the third session as running
			agent.setSessionStatus(sessions[2].path, "running");

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items).toHaveLength(3);
			// Running session should be first, despite having the oldest prompt time
			expect(getSessionName(items[0])).toBe("Running session");
			// Then sorted by lastUserPromptTime
			expect(getSessionName(items[1])).toBe("Idle recent");
			expect(getSessionName(items[2])).toBe("Idle old");
		});

		it("sorts multiple running sessions alphabetically for stability", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({
					name: "Zebra running",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T11:00:00.000Z",
				}),
				createSession({
					name: "Alpha running",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T08:00:00.000Z",
				}),
				createSession({
					name: "Idle session",
					cwd: "/home/user/project",
					lastUserPromptTime: "2026-02-28T10:00:00.000Z",
				}),
			];
			agent.setSessions(sessions);
			agent.setSessionStatus(sessions[0].path, "running");
			agent.setSessionStatus(sessions[1].path, "running");

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items).toHaveLength(3);
			// Running sessions first, alphabetically
			expect(getSessionName(items[0])).toBe("Alpha running");
			expect(getSessionName(items[1])).toBe("Zebra running");
			// Then idle
			expect(getSessionName(items[2])).toBe("Idle session");
		});
	});

	describe("status badges", () => {
		it("shows running badge with pulsing dot for running sessions", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({
					name: "Running session",
					cwd: "/home/user/project",
				}),
			];
			agent.setSessions(sessions);
			agent.setSessionStatus(sessions[0].path, "running");

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items).toHaveLength(1);
			expect(hasRunningBadge(items[0])).toBe(true);
			expect(hasDoneBadge(items[0])).toBe(false);

			// Check the pulsing dot is present
			const badge = items[0].querySelector(".status-badge.running")!;
			expect(badge.querySelector(".status-dot")).not.toBeNull();
			expect(badge.textContent?.trim()).toBe("running");
		});

		it("shows done badge for completed sessions", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({
					name: "Done session",
					cwd: "/home/user/project",
				}),
			];
			agent.setSessions(sessions);
			agent.setSessionStatus(sessions[0].path, "done");

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items).toHaveLength(1);
			expect(hasDoneBadge(items[0])).toBe(true);
			expect(hasRunningBadge(items[0])).toBe(false);

			const badge = items[0].querySelector(".status-badge.done")!;
			expect(badge.textContent?.trim()).toBe("done");
		});

		it("shows no badge for sessions without status", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({
					name: "No status session",
					cwd: "/home/user/project",
				}),
			];
			agent.setSessions(sessions);
			// Don't set any status

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items).toHaveLength(1);
			expect(hasRunningBadge(items[0])).toBe(false);
			expect(hasDoneBadge(items[0])).toBe(false);
			expect(getStatusBadges(items[0])).toHaveLength(0);
		});

		it("updates badges when global status changes", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({
					name: "Session A",
					cwd: "/home/user/project",
				}),
			];
			agent.setSessions(sessions);

			const el = await createPicker(agent);

			// Initially no badge
			let items = getSessionItems(el);
			expect(getStatusBadges(items[0])).toHaveLength(0);

			// Set to running and emit change
			agent.setSessionStatus(sessions[0].path, "running");
			agent.emitGlobalStatusChange();
			await el.updateComplete;
			await new Promise((r) => setTimeout(r, 50));
			await el.updateComplete;

			items = getSessionItems(el);
			expect(hasRunningBadge(items[0])).toBe(true);

			// Set to done and emit change
			agent.setSessionStatus(sessions[0].path, "done");
			agent.emitGlobalStatusChange();
			await el.updateComplete;
			await new Promise((r) => setTimeout(r, 50));
			await el.updateComplete;

			items = getSessionItems(el);
			expect(hasDoneBadge(items[0])).toBe(true);
			expect(hasRunningBadge(items[0])).toBe(false);
		});
	});

	describe("group sorting", () => {
		it("sorts groups by most recent session activity", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					name: "Old project session",
					cwd: "/home/user/old-project",
					lastUserPromptTime: "2026-02-28T08:00:00.000Z",
				}),
				createSession({
					name: "Recent project session",
					cwd: "/home/user/recent-project",
					lastUserPromptTime: "2026-02-28T11:00:00.000Z",
				}),
				createSession({
					name: "Middle project session",
					cwd: "/home/user/middle-project",
					lastUserPromptTime: "2026-02-28T09:30:00.000Z",
				}),
			]);

			const el = await createPicker(agent);
			const headers = getGroupHeaders(el);

			expect(headers).toHaveLength(3);
			expect(getGroupLabel(headers[0])).toBe("recent-project");
			expect(getGroupLabel(headers[1])).toBe("middle-project");
			expect(getGroupLabel(headers[2])).toBe("old-project");
		});

		it("groups with running sessions sort to the top", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({
					name: "Old running",
					cwd: "/home/user/old-project",
					lastUserPromptTime: "2026-02-28T06:00:00.000Z",
				}),
				createSession({
					name: "Very recent idle",
					cwd: "/home/user/recent-project",
					lastUserPromptTime: "2026-02-28T11:00:00.000Z",
				}),
			];
			agent.setSessions(sessions);
			// Mark the old-project session as running
			agent.setSessionStatus(sessions[0].path, "running");

			const el = await createPicker(agent);
			const headers = getGroupHeaders(el);

			expect(headers).toHaveLength(2);
			// Group with running session should be first
			expect(getGroupLabel(headers[0])).toBe("old-project");
			expect(getGroupLabel(headers[1])).toBe("recent-project");
		});
	});

	describe("search filtering", () => {
		it("filters sessions by name", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ name: "Fix login bug", cwd: "/home/user/app" }),
				createSession({ name: "Add dark mode", cwd: "/home/user/app" }),
				createSession({ name: "Refactor tests", cwd: "/home/user/app" }),
			]);

			const el = await createPicker(agent);

			// Initially all visible
			expect(getSessionItems(el)).toHaveLength(3);

			// Type in search
			const input = getSearchInput(el)!;
			input.value = "dark";
			input.dispatchEvent(new Event("input"));
			await el.updateComplete;

			const items = getSessionItems(el);
			expect(items).toHaveLength(1);
			expect(getSessionName(items[0])).toBe("Add dark mode");
		});

		it("filters sessions by cwd", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ name: "Session A", cwd: "/home/user/frontend" }),
				createSession({ name: "Session B", cwd: "/home/user/backend" }),
			]);

			const el = await createPicker(agent);
			expect(getSessionItems(el)).toHaveLength(2);

			const input = getSearchInput(el)!;
			input.value = "frontend";
			input.dispatchEvent(new Event("input"));
			await el.updateComplete;

			const items = getSessionItems(el);
			expect(items).toHaveLength(1);
			expect(getSessionName(items[0])).toBe("Session A");
		});

		it("filters sessions by firstMessage", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ firstMessage: "help me with TypeScript", cwd: "/home/user/app" }),
				createSession({ firstMessage: "fix the Python script", cwd: "/home/user/app" }),
			]);

			const el = await createPicker(agent);

			const input = getSearchInput(el)!;
			input.value = "typescript";
			input.dispatchEvent(new Event("input"));
			await el.updateComplete;

			const items = getSessionItems(el);
			expect(items).toHaveLength(1);
			// No name set, so firstMessage is the display name
			expect(getSessionName(items[0])).toBe("help me with TypeScript");
		});

		it("shows empty state when no sessions match", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ name: "Some session", cwd: "/home/user/app" }),
			]);

			const el = await createPicker(agent);

			const input = getSearchInput(el)!;
			input.value = "xyznonexistent";
			input.dispatchEvent(new Event("input"));
			await el.updateComplete;

			expect(getSessionItems(el)).toHaveLength(0);
			const empty = el.shadowRoot!.querySelector(".empty");
			expect(empty).not.toBeNull();
			expect(empty!.textContent?.trim()).toBe("No sessions found");
		});
	});

	describe("show more / truncation", () => {
		it("shows at most 5 sessions by default and offers show more", async () => {
			const agent = new MockAgent();
			const sessions: SessionInfoDTO[] = [];
			for (let i = 0; i < 8; i++) {
				sessions.push(
					createSession({
						name: `Session ${i + 1}`,
						cwd: "/home/user/project",
						lastUserPromptTime: `2026-02-28T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
					}),
				);
			}
			agent.setSessions(sessions);

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			// Should show 5 (the default limit)
			expect(items).toHaveLength(5);

			// Should have a "show more" button
			const showMoreBtns = getShowMoreButtons(el);
			expect(showMoreBtns).toHaveLength(1);
			expect(showMoreBtns[0].textContent).toContain("3 more");
		});

		it("shows all sessions after clicking show more", async () => {
			const agent = new MockAgent();
			const sessions: SessionInfoDTO[] = [];
			for (let i = 0; i < 8; i++) {
				sessions.push(
					createSession({
						name: `Session ${i + 1}`,
						cwd: "/home/user/project",
						lastUserPromptTime: `2026-02-28T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
					}),
				);
			}
			agent.setSessions(sessions);

			const el = await createPicker(agent);

			// Click show more
			const showMoreBtn = getShowMoreButtons(el)[0];
			showMoreBtn.click();
			await el.updateComplete;

			// Now all 8 should be visible
			expect(getSessionItems(el)).toHaveLength(8);

			// Should now show "show less" button
			const btns = getShowMoreButtons(el);
			expect(btns).toHaveLength(1);
			expect(btns[0].textContent).toContain("Show less");
		});

		it("increases default limit to show all running sessions", async () => {
			const agent = new MockAgent();
			const sessions: SessionInfoDTO[] = [];
			for (let i = 0; i < 8; i++) {
				sessions.push(
					createSession({
						name: `Session ${i + 1}`,
						cwd: "/home/user/project",
						lastUserPromptTime: `2026-02-28T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
					}),
				);
			}
			agent.setSessions(sessions);
			// Mark 6 sessions as running (more than the default limit of 5)
			for (let i = 0; i < 6; i++) {
				agent.setSessionStatus(sessions[i].path, "running");
			}

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			// Default limit expands to cover all 6 running sessions
			// So at least 6 should be visible
			expect(items.length).toBeGreaterThanOrEqual(6);
		});
	});

	describe("display name", () => {
		it("uses session name when available", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					name: "Custom Name",
					firstMessage: "some first message",
					cwd: "/home/user/project",
				}),
			]);

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(getSessionName(items[0])).toBe("Custom Name");
		});

		it("falls back to firstMessage when no name", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					firstMessage: "help me debug this issue",
					cwd: "/home/user/project",
				}),
			]);

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(getSessionName(items[0])).toBe("help me debug this issue");
		});

		it("shows 'New session' when no name and no messages", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					firstMessage: "(no messages)",
					cwd: "/home/user/project",
				}),
			]);

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(getSessionName(items[0])).toBe("New session");
		});

		it("truncates long firstMessage to 100 chars", async () => {
			const agent = new MockAgent();
			const longMsg = "a".repeat(150);
			agent.setSessions([
				createSession({
					firstMessage: longMsg,
					cwd: "/home/user/project",
				}),
			]);

			const el = await createPicker(agent);
			const items = getSessionItems(el);
			const name = getSessionName(items[0]);

			expect(name.length).toBeLessThanOrEqual(101); // 100 + "…"
			expect(name).toContain("…");
		});
	});

	describe("collapse expanded groups on session pick", () => {
		it("collapses all expanded groups when a session is clicked", async () => {
			const agent = new MockAgent();
			const sessions: SessionInfoDTO[] = [];
			for (let i = 0; i < 8; i++) {
				sessions.push(
					createSession({
						name: `Session ${i + 1}`,
						cwd: "/home/user/project",
						lastUserPromptTime: `2026-02-28T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
					}),
				);
			}
			agent.setSessions(sessions);

			const el = await createPicker(agent);

			// Initially truncated to 5
			expect(getSessionItems(el)).toHaveLength(5);

			// Expand the group
			const showMoreBtn = getShowMoreButtons(el)[0];
			showMoreBtn.click();
			await el.updateComplete;
			expect(getSessionItems(el)).toHaveLength(8);

			// Click a session (not the active one)
			const items = getSessionItems(el);
			items[3].click();
			await el.updateComplete;

			// Group should be collapsed back to 5
			expect(getSessionItems(el)).toHaveLength(5);

			// "Show more" button should be back
			const btns = getShowMoreButtons(el);
			expect(btns).toHaveLength(1);
			expect(btns[0].textContent).toContain("3 more");
		});
	});

	describe("active session highlighting", () => {
		it("marks the active session with the 'active' class", async () => {
			const agent = new MockAgent();
			const sessions = [
				createSession({ name: "Session A", cwd: "/home/user/project" }),
				createSession({ name: "Session B", cwd: "/home/user/project" }),
			];
			agent.setSessions(sessions);
			agent.sessionId = sessions[1].id;

			const el = await createPicker(agent);
			const items = getSessionItems(el);

			expect(items[0].classList.contains("active")).toBe(false);
			expect(items[1].classList.contains("active")).toBe(true);
		});
	});
});

// Need this import for the type used in the show-more test
import type { SessionInfoDTO } from "./ws-agent-adapter.js";

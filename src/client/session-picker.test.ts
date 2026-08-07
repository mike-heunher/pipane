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
import { MockAgent, createSession, resetSessionCounter } from "../test/mock-agent.js";
import "./session-picker.js";
import { isPreviewHostname, type SessionPicker } from "./session-picker.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a session-picker element wired to a MockAgent, wait for first render. */
async function createPicker(agent: MockAgent): Promise<SessionPicker> {
	const el = document.createElement("session-picker") as SessionPicker;
	(el as any).agent = agent;
	document.body.appendChild(el);
	// Wait for the observable async load state and its Lit render; no timing sleep.
	await vi.waitFor(() => expect((el as any).loading).toBe(false));
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

/** Get the worktree label from a rendered session item. */
function getWorktreeName(item: HTMLElement): string {
	return item.querySelector(".session-worktree")?.textContent?.trim() ?? "";
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

/** Check if a session item has an "idle" badge. */
function hasIdleBadge(item: HTMLElement): boolean {
	return getStatusBadges(item).some((b) => b.classList.contains("idle"));
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
	it("renders the PIPANE logo without an environment badge on live deployments", async () => {
		const el = await createPicker(new MockAgent());
		el.previewMode = false;
		await el.updateComplete;

		expect(el.shadowRoot!.querySelector(".header-logo")?.textContent).toBe("PIPANE");
		expect(el.shadowRoot!.querySelector(".header-brand")?.getAttribute("aria-label")).toBe("Pipane");
		expect(el.shadowRoot!.querySelector(".header-environment-badge.preview")).toBeNull();
	});

	it("adds the outlined preview badge only in preview mode", async () => {
		const el = await createPicker(new MockAgent());
		el.previewMode = true;
		await el.updateComplete;

		expect(el.shadowRoot!.querySelector(".header-logo")?.textContent).toBe("PIPANE");
		expect(el.shadowRoot!.querySelector(".header-brand")?.getAttribute("aria-label")).toBe("Pipane preview");
		expect(el.shadowRoot!.querySelector(".header-environment-badge.preview")?.textContent).toBe("preview");
	});

	it("recognizes only the dedicated preview hostname", () => {
		expect(isPreviewHostname("preview.pipane.dev")).toBe(true);
		expect(isPreviewHostname("PREVIEW.PIPANE.DEV")).toBe(true);
		expect(isPreviewHostname("pipane.dev")).toBe(false);
		expect(isPreviewHostname("preview.pipane.dev.example.com")).toBe(false);
	});

	it("prefetches a cached session before pointer selection", async () => {
		const agent = new MockAgent();
		const target = createSession({ id: "target", cwd: "/sessions" });
		agent.sessionId = "active";
		agent.setSessions([target]);
		const prefetchSession = vi.fn();
		(agent as any).prefetchSession = prefetchSession;
		const el = await createPicker(agent);

		getSessionItems(el)[0].dispatchEvent(new Event("pointerenter"));

		expect(prefetchSession).toHaveBeenCalledWith(target.path, undefined);
	});

	it("places Pipane settings beside the compact new-project action", async () => {
		const agent = new MockAgent();
		const onOpenSettings = vi.fn();
		const onInviteDevice = vi.fn();
		const el = await createPicker(agent);
		(el as any).settingsMenu = { onOpenSettings, onInviteDevice, isDevMode: false };
		await el.updateComplete;

		const headerActions = el.shadowRoot!.querySelector(".header-right")!;
		expect(headerActions.querySelector<HTMLButtonElement>(".new-btn")?.textContent).toBe("+ NEW");
		const settings = headerActions.querySelector<HTMLButtonElement>('button[title="Pipane settings"]');
		expect(settings).not.toBeNull();
		expect(headerActions.querySelector('button[title="Add device"]')).toBeNull();
		expect(el.shadowRoot!.querySelector('button[title="Menu"]')).toBeNull();
		settings!.click();
		expect(onOpenSettings).toHaveBeenCalledOnce();
	});

	it("shows selectable updates beside the matching backend name", async () => {
		const agent = new MockAgent();
		agent.setWorkspace([
			{ backendId: "b_one", name: "alpha", protocolVersions: [1, 2], online: true, connected: true, reconnecting: false },
			{ backendId: "b_two", name: "beta", protocolVersions: [1, 2], online: true, connected: true, reconnecting: false },
		], "b_one");
		const onRunUpdates = vi.fn();
		const onSnoozeUpdate = vi.fn();
		const el = await createPicker(agent);
		(el as any).settingsMenu = {
			onOpenSettings: vi.fn(),
			onRunUpdates,
			onSnoozeUpdate,
			updatesByBackend: new Map([
				["b_one", [{ target: "pipane", currentVersion: "1", latestVersion: "2" }, { target: "pi", currentVersion: "3", latestVersion: "4" }]],
				["b_two", []],
			]),
			updatingByBackend: new Map(),
			updateFeedbackByBackend: new Map(),
			isDevMode: false,
		};
		await el.updateComplete;

		const alpha = el.shadowRoot!.querySelector('[data-backend-id="b_one"]')!;
		const beta = el.shadowRoot!.querySelector('[data-backend-id="b_two"]')!;
		expect(alpha.querySelector(".update-indicator")?.textContent).toBe("↑");
		expect(beta.querySelector(".update-indicator")).toBeNull();
		(alpha.querySelector(".update-indicator") as HTMLButtonElement).click();
		await el.updateComplete;
		expect(alpha.querySelectorAll(".update-option")).toHaveLength(2);

		(alpha.querySelector('[data-update-target="pi"] input') as HTMLInputElement).click();
		await el.updateComplete;
		(alpha.querySelector(".update-run") as HTMLButtonElement).click();
		expect(onRunUpdates).toHaveBeenCalledWith("b_one", [{ target: "pipane", currentVersion: "1", latestVersion: "2" }]);

		(alpha.querySelector('[data-update-target="pi"] .update-later') as HTMLButtonElement).click();
		expect(onSnoozeUpdate).toHaveBeenCalledWith("b_one", { target: "pi", currentVersion: "3", latestVersion: "4" });
	});

	it("lists host controls above one backend-prefixed project stream sorted by recency", async () => {
		const agent = new MockAgent();
		agent.setWorkspace([
			{ backendId: "b_one", name: "alpha", protocolVersions: [1, 2], online: true, connected: true, reconnecting: false },
			{ backendId: "b_two", name: "beta", protocolVersions: [1, 2], online: true, connected: true, reconnecting: false },
		], "b_one");
		agent.setSessions([
			createSession({
				id: "same",
				backendId: "b_one",
				name: "Alpha work",
				cwd: "/srv/project",
				lastUserPromptTime: "2026-07-22T08:00:00.000Z",
			}),
			createSession({
				id: "same",
				backendId: "b_two",
				name: "Beta work",
				cwd: "/srv/project",
				lastUserPromptTime: "2026-07-22T11:00:00.000Z",
			}),
		]);
		const switchSession = vi.spyOn(agent, "switchSession");
		const onOpenSettings = vi.fn();
		const onOpenRelaySettings = vi.fn();
		const onInviteDevice = vi.fn();

		const el = await createPicker(agent);
		(el as any).settingsMenu = { onOpenSettings, onOpenRelaySettings, onInviteDevice, isDevMode: false };
		await el.updateComplete;

		const hosts = el.shadowRoot!.querySelectorAll(".host-row");
		expect(hosts).toHaveLength(2);
		expect(hosts[0].querySelector(".host-name")?.textContent).toBe("alpha");
		expect(hosts[1].querySelector(".host-name")?.textContent).toBe("beta");
		expect(el.shadowRoot!.querySelector(".header + .host-list")).not.toBeNull();
		const workspaceSettings = el.shadowRoot!.querySelector<HTMLButtonElement>(".header .settings-btn");
		expect(workspaceSettings).not.toBeNull();
		workspaceSettings!.click();
		expect(onOpenSettings).toHaveBeenCalledWith();
		const addDevice = el.shadowRoot!.querySelector<HTMLButtonElement>('.header button[title="Add device"]');
		expect(addDevice).not.toBeNull();
		addDevice!.click();
		expect(onInviteDevice).toHaveBeenCalledOnce();
		expect(Array.from(el.shadowRoot!.querySelectorAll(".group-label"), (label) => label.textContent)).toEqual([
			"beta / project",
			"alpha / project",
		]);
		expect(getSessionItems(el).map(getSessionName)).toEqual(["Beta work", "Alpha work"]);
		expect(hosts[0].querySelector(".project-group")).toBeNull();

		getSessionItems(el)[0].click();
		await vi.waitFor(() => expect(switchSession).toHaveBeenCalledWith(
			"/srv/project/.pi/sessions/same.jsonl",
			"/srv/project",
			"b_two",
		));

		hosts[1].querySelector<HTMLButtonElement>('[aria-label="Manage beta"]')!.click();
		await el.updateComplete;
		el.shadowRoot!.querySelector<HTMLButtonElement>(".host-menu button")!.click();
		expect(onOpenSettings).toHaveBeenCalledWith("b_two");

		hosts[1].querySelector<HTMLButtonElement>('[aria-label="Manage beta"]')!.click();
		await el.updateComplete;
		const relay = [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".host-menu button")]
			.find((button) => button.textContent === "TURN relay settings")!;
		relay.click();
		expect(onOpenRelaySettings).toHaveBeenCalledOnce();

		hosts[1].querySelector<HTMLButtonElement>('[aria-label="Manage beta"]')!.click();
		await el.updateComplete;
		expect(el.shadowRoot!.querySelector(".host-menu")?.textContent).not.toContain("Add another device");
	});

	it("omits the backend prefix when a workspace has only one host", async () => {
		const agent = new MockAgent();
		agent.setWorkspace([
			{ backendId: "b_one", name: "alpha", protocolVersions: [1, 2], online: true, connected: true, reconnecting: false },
		], "b_one");
		agent.setSessions([
			createSession({ backendId: "b_one", name: "Alpha work", cwd: "/srv/project" }),
		]);

		const el = await createPicker(agent);

		expect(getGroupLabel(getGroupHeaders(el)[0])).toBe("project");
		expect(el.shadowRoot!.querySelectorAll(".host-row")).toHaveLength(1);
	});

	it("offers common shortcuts in the new-project folder selector", async () => {
		const agent = new MockAgent();
		const browseDirectory = vi.spyOn(agent, "browseDirectory").mockImplementation(async (requestedPath) => ({
			path: requestedPath === "~"
				? "/home/user"
				: requestedPath.replace(/^~/u, "/home/user"),
			dirs: [],
		}));
		const newSession = vi.spyOn(agent, "newSession");
		const el = await createPicker(agent);

		el.shadowRoot!.querySelector<HTMLButtonElement>(".new-btn")!.click();
		await vi.waitFor(() => expect(browseDirectory).toHaveBeenCalledWith("~"));
		await vi.waitFor(() => expect(el.shadowRoot!.querySelector<HTMLButtonElement>('[data-shortcut="desktop"]')?.disabled).toBe(false));

		const shortcuts = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".folder-shortcut"));
		expect(shortcuts.map((button) => button.textContent?.trim())).toEqual([
			"Home",
			"Desktop",
			"Documents",
			"Downloads",
			"Root",
		]);

		el.shadowRoot!.querySelector<HTMLButtonElement>('[data-shortcut="desktop"]')!.click();
		await vi.waitFor(() => expect(browseDirectory).toHaveBeenCalledWith("~/Desktop"));
		await vi.waitFor(() => expect(el.shadowRoot!.querySelector(".folder-picker-location-path")?.textContent).toBe("/home/user/Desktop"));
		el.shadowRoot!.querySelector<HTMLButtonElement>(".folder-picker-actions button")!.click();

		expect(newSession).toHaveBeenCalledWith("/home/user/Desktop");
	});

	it("creates and enters a new folder from the project explorer", async () => {
		const agent = new MockAgent();
		const browseDirectory = vi.spyOn(agent, "browseDirectory").mockImplementation(async (requestedPath) => ({
			path: requestedPath === "~" ? "/home/user" : requestedPath,
			dirs: [],
		}));
		const createDirectory = vi.spyOn(agent, "createDirectory").mockResolvedValue({
			name: "my-project",
			path: "/home/user/my-project",
		});
		const el = await createPicker(agent);

		el.shadowRoot!.querySelector<HTMLButtonElement>(".new-btn")!.click();
		await vi.waitFor(() => expect(browseDirectory).toHaveBeenCalledWith("~"));
		await vi.waitFor(() => expect(el.shadowRoot!.querySelector<HTMLButtonElement>(".folder-new-btn")?.disabled).toBe(false));

		el.shadowRoot!.querySelector<HTMLButtonElement>(".folder-new-btn")!.click();
		await el.updateComplete;
		const input = el.shadowRoot!.querySelector<HTMLInputElement>('input[aria-label="New folder name"]')!;
		input.value = "my-project";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;
		el.shadowRoot!.querySelector<HTMLButtonElement>(".new-folder-confirm")!.click();

		await vi.waitFor(() => expect(createDirectory).toHaveBeenCalledWith("/home/user", "my-project"));
		await vi.waitFor(() => expect(browseDirectory).toHaveBeenCalledWith("/home/user/my-project"));
		await el.updateComplete;
		expect(el.shadowRoot!.querySelector(".folder-picker-location-path")?.textContent).toBe("/home/user/my-project");
		expect(el.shadowRoot!.querySelector(".folder-picker-actions")?.textContent).toContain("Open in my-project");
	});

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
		it("shows running badge for running sessions", async () => {
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

			const badge = items[0].querySelector(".status-badge.running")!;
			expect(badge.textContent?.trim()).toBe("");
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
			expect(badge.textContent?.trim()).toBe("");
		});

		it("shows idle badge for sessions without status", async () => {
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
			expect(hasIdleBadge(items[0])).toBe(true);
			expect(hasRunningBadge(items[0])).toBe(false);
			expect(hasDoneBadge(items[0])).toBe(false);
			const badge = items[0].querySelector(".status-badge.idle")!;
			expect(badge.textContent?.trim()).toBe("");
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

			// Initially idle badge
			let items = getSessionItems(el);
			expect(hasIdleBadge(items[0])).toBe(true);

			// Set to running and emit change
			agent.setSessionStatus(sessions[0].path, "running");
			agent.emitGlobalStatusChange();
			await el.updateComplete;

			items = getSessionItems(el);
			expect(hasRunningBadge(items[0])).toBe(true);

			// Set to done and emit change
			agent.setSessionStatus(sessions[0].path, "done");
			agent.emitGlobalStatusChange();
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
			expect(getGroupLabel(headers[0])).toBe("/home/user/recent-project");
			expect(getGroupLabel(headers[1])).toBe("/home/user/middle-project");
			expect(getGroupLabel(headers[2])).toBe("/home/user/old-project");
		});

		it("does not promote a project when one of its sessions starts running", async () => {
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
			agent.setSessionStatus(sessions[0].path, "running");

			const el = await createPicker(agent);
			const headers = getGroupHeaders(el);

			expect(headers).toHaveLength(2);
			expect(getGroupLabel(headers[0])).toBe("/home/user/recent-project");
			expect(getGroupLabel(headers[1])).toBe("/home/user/old-project");
		});

		it("ignores modified time for projects without a user prompt", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					name: "Assistant-only session",
					cwd: "/home/user/z-no-prompt-project",
					modified: "2026-02-28T12:00:00.000Z",
				}),
				createSession({
					name: "Prompted session",
					cwd: "/home/user/a-prompted-project",
					modified: "2026-02-28T09:00:00.000Z",
					lastUserPromptTime: "2026-02-28T08:00:00.000Z",
				}),
			]);

			const el = await createPicker(agent);
			const headers = getGroupHeaders(el);

			expect(headers).toHaveLength(2);
			expect(getGroupLabel(headers[0])).toBe("/home/user/a-prompted-project");
			expect(getGroupLabel(headers[1])).toBe("/home/user/z-no-prompt-project");
		});
	});

	describe("cwd display labels", () => {
		it("uses cwdDisplay from the backend when available", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ name: "Session A", cwd: "/home/user/project", cwdDisplay: "~/dev/project" }),
			]);

			const el = await createPicker(agent);
			const headers = getGroupHeaders(el);

			expect(headers).toHaveLength(1);
			expect(getGroupLabel(headers[0])).toBe("~/dev/project");
		});
	});

	describe("worktree labels", () => {
		it("shows a linked worktree name below the conversation title", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					name: "Fix login",
					cwd: "/home/user/project--wt-fix-login",
					worktreeName: "project--wt-fix-login",
				}),
			]);

			const el = await createPicker(agent);
			const item = getSessionItems(el)[0];

			expect(getWorktreeName(item)).toBe("project--wt-fix-login");
			expect(item.querySelector(".session-name")?.nextElementSibling?.classList.contains("session-meta")).toBe(true);
		});

		it("shows root for a conversation in the root checkout", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ name: "Root work", cwd: "/home/user/project", worktreeName: "root" }),
			]);

			const el = await createPicker(agent);

			expect(getWorktreeName(getSessionItems(el)[0])).toBe("root");
		});

		it("defaults optimistic sessions to root instead of inheriting a worktree", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({
					name: "Indexed session",
					cwd: "/home/user/project--wt-feature",
					worktreeName: "project--wt-feature",
				}),
				createSession({ name: "Optimistic session", cwd: "/home/user/project--wt-feature" }),
			]);

			const el = await createPicker(agent);
			const item = getSessionItems(el).find((candidate) => getSessionName(candidate) === "Optimistic session")!;

			expect(getWorktreeName(item)).toBe("root");
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

		it("does not clear search on repeated status updates while attached", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ name: "Some session", cwd: "/home/user/app" }),
			]);
			agent.sessionStatus = "attached";

			const el = await createPicker(agent);
			const input = getSearchInput(el)!;
			input.value = "keepme";
			input.dispatchEvent(new Event("input"));
			await el.updateComplete;

			agent.emitStatusChange();
			await el.updateComplete;
			agent.emitStatusChange();
			await el.updateComplete;

			expect(getSearchInput(el)!.value).toBe("keepme");
		});

		it("clears search when status transitions into attached", async () => {
			const agent = new MockAgent();
			agent.setSessions([
				createSession({ name: "Some session", cwd: "/home/user/app" }),
			]);
			agent.sessionStatus = "detached";

			const el = await createPicker(agent);
			const input = getSearchInput(el)!;
			input.value = "clearme";
			input.dispatchEvent(new Event("input"));
			await el.updateComplete;

			agent.sessionStatus = "attached";
			agent.emitStatusChange();
			await el.updateComplete;

			expect(getSearchInput(el)!.value).toBe("");
		});

		it("clears search when selecting a different session", async () => {
			const agent = new MockAgent();
			const target = createSession({ id: "target-session", name: "Target", cwd: "/home/user/app" });
			agent.setSessions([target]);
			agent.sessionId = "active-session";
			const switchSpy = vi.spyOn(agent, "switchSession");

			const el = await createPicker(agent);
			const input = getSearchInput(el)!;
			input.value = "target";
			input.dispatchEvent(new Event("input"));
			await el.updateComplete;

			getSessionItems(el)[0].click();
			await el.updateComplete;

			expect(getSearchInput(el)!.value).toBe("");
			expect(switchSpy).toHaveBeenCalledWith(target.path, target.cwd);
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

		it("respects custom sessionsPerProject property", async () => {
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
			// Set a custom limit of 3
			el.sessionsPerProject = 3;
			await el.updateComplete;

			const items = getSessionItems(el);
			expect(items).toHaveLength(3);

			// Should have a "show more" button with 5 hidden
			const showMoreBtns = getShowMoreButtons(el);
			expect(showMoreBtns).toHaveLength(1);
			expect(showMoreBtns[0].textContent).toContain("5 more");
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
import type { SessionInfoDTO } from "./backend-client.js";

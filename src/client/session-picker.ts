/**
 * Session picker sidebar component.
 *
 * Shows a list of all sessions from the pi CLI state files,
 * grouped by project (cwd). Each group has a "+" button to create
 * a new session in that folder. The top "+ New" button opens a
 * folder picker to choose a CWD for a new session.
 */

import { html, css, LitElement, nothing, render, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { WsAgentAdapter, SessionInfoDTO } from "./ws-agent-adapter.js";
import { getColorTheme, setColorTheme, getDarkMode, setDarkMode, type ColorTheme, type DarkMode } from "./theme-selector.js";

export interface BurgerMenuCallbacks {
	onToggleTokenUsage: () => void;
	onOpenSettings: () => void;
	onToggleJsonl: () => void;
	isTokenUsageHidden: boolean;
	isJsonlVisible: boolean;
	isDevMode: boolean;
}

interface SessionGroup {
	cwd: string;
	label: string;
	displayCwd: string;
	sessions: SessionInfoDTO[];
}

interface DirEntry {
	name: string;
	path: string;
}

const PINNED_STORAGE_KEY = "pipane-pinned-sessions";

function loadPinnedSessions(): Set<string> {
	try {
		const raw = localStorage.getItem(PINNED_STORAGE_KEY);
		if (raw) return new Set(JSON.parse(raw));
	} catch { /* */ }
	return new Set();
}

function savePinnedSessions(pinned: Set<string>) {
	try {
		localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...pinned]));
	} catch { /* */ }
}

@customElement("session-picker")
export class SessionPicker extends LitElement {
	static styles = css`
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			overflow: hidden;
			font-family: inherit;
			--picker-bg: var(--background, #fff);
			--picker-border: var(--border, #e5e7eb);
			--picker-text: var(--foreground, #111);
			--picker-muted: var(--muted-foreground, #6b7280);
			--picker-hover: var(--accent, #f3f4f6);
			--picker-active: var(--primary, #2563eb);
			--picker-active-bg: color-mix(in srgb, var(--picker-active) 10%, transparent);
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.5rem 0.75rem;
			border-bottom: 1px solid var(--picker-border);
			flex-shrink: 0;
		}

		.header.dev {
			background: color-mix(in srgb, #dc2626 15%, var(--picker-bg));
			border-bottom-color: color-mix(in srgb, #dc2626 30%, var(--picker-border));
		}

		.header-left {
			display: flex;
			align-items: center;
			gap: 0.4rem;
		}

		.header-right {
			display: flex;
			align-items: center;
			gap: 0.25rem;
		}

		.burger-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 1.5rem;
			height: 1.5rem;
			border: none;
			border-radius: 0.25rem;
			background: transparent;
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0;
			transition: background 0.15s, color 0.15s;
		}

		.burger-btn:hover {
			background: var(--picker-hover);
			color: var(--picker-text);
		}

		.header-title {
			font-size: 0.8rem;
			font-weight: 600;
			color: var(--picker-text);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.new-btn {
			background: none;
			border: none;
			color: var(--picker-active, #7c9a5e);
			cursor: pointer;
			padding: 0;
			font-size: 0.55rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			opacity: 0.6;
			transition: opacity 0.15s;
		}

		.new-btn:hover {
			opacity: 1;
		}

		.search {
			padding: 0.5rem 0.75rem;
			border-bottom: 1px solid var(--picker-border);
			flex-shrink: 0;
		}

		.search input {
			width: 100%;
			box-sizing: border-box;
			padding: 0.35rem 0.5rem;
			border: 1px solid var(--picker-border);
			border-radius: 4px;
			background: var(--picker-bg);
			color: var(--picker-text);
			font-size: 0.8rem;
			outline: none;
		}

		.search input:focus {
			border-color: var(--picker-active);
		}

		.sessions-list {
			flex: 1;
			overflow-y: auto;
			padding: 0.25rem 0;
		}

		.group-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.4rem 0.75rem 0.15rem;
			margin-top: 0.15rem;
			background: transparent;
			border: none;
		}

		.group-header:first-child {
			margin-top: 0;
		}

		.group-label {
			font-size: 0.58rem;
			font-weight: 600;
			color: var(--picker-muted);
			text-transform: uppercase;
			letter-spacing: 0.06em;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			flex: 1;
			min-width: 0;
		}

		.group-new-btn {
			background: none;
			border: none;
			color: var(--picker-active, #7c9a5e);
			cursor: pointer;
			padding: 0;
			font-size: 0.55rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			opacity: 0.6;
			transition: opacity 0.15s;
			flex-shrink: 0;
		}

		.group-new-btn:hover {
			opacity: 1;
		}

		.group-new-btn:focus-visible {
			outline: none;
			opacity: 1;
		}

		.session-item {
			display: block;
			width: 100%;
			box-sizing: border-box;
			padding: 0.24rem 0.65rem 0.24rem 0.8rem;
			border: none;
			background: none;
			color: var(--picker-text);
			text-align: left;
			cursor: pointer;
			font-size: 0.78rem;
			line-height: 1.22;
			transition: background 0.1s;
		}

		.session-item:hover {
			background: var(--picker-hover);
		}

		.session-item.active {
			background: var(--picker-active-bg);
			border-left: 2px solid var(--picker-active);
			padding-left: calc(0.8rem - 2px);
		}

		.session-name {
			font-size: 0.735rem;
			font-weight: 500;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
			text-overflow: ellipsis;
			word-break: break-word;
			line-height: 1.24;
		}

		.session-meta {
			font-size: 0.6rem;
			color: var(--picker-muted);
			white-space: nowrap;
			display: flex;
			align-items: center;
			gap: 0.32rem;
			margin-top: 2px;
			line-height: 1.12;
		}

		.msg-count-badge {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-width: 1.03rem;
			height: 0.84rem;
			padding: 0 0.24rem;
			border-radius: 0.42rem;
			background: color-mix(in srgb, var(--picker-muted) 18%, transparent);
			color: var(--picker-muted);
			font-size: 0.55rem;
			font-weight: 600;
			line-height: 1;
			flex-shrink: 0;
		}

		.status-badge {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			align-self: center;
			min-width: 0.66rem;
			height: 0.66rem;
			margin-left: -0.35rem;
			margin-right: 0.42rem;
			font-size: 0.46rem;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.03em;
			border-radius: 999px;
			white-space: nowrap;
			flex-shrink: 0;
			overflow: hidden;
			padding: 0 0.18rem;
			line-height: 1;
		}

		.status-badge .status-text {
			display: inline-block;
		}

		.status-badge.running {
			min-width: 0.46rem;
			height: 0.46rem;
			padding: 0;
			margin-left: -0.25rem;
			margin-right: 0.5rem;
			color: #ef4444;
			background: color-mix(in srgb, #ef4444 58%, transparent);
		}

		.status-badge.done {
			min-width: 0.46rem;
			height: 0.46rem;
			padding: 0;
			margin-left: -0.25rem;
			margin-right: 0.5rem;
			color: #22c55e;
			background: color-mix(in srgb, #22c55e 55%, transparent);
		}

		.status-badge.idle {
			min-width: 0.42rem;
			height: 0.42rem;
			padding: 0;
			margin-left: -0.25rem;
			margin-right: 0.5rem;
			color: #9ca3af;
			background: color-mix(in srgb, #9ca3af 45%, transparent);
		}

		.session-item-row {
			display: flex;
			align-items: flex-start;
			gap: 0;
		}

		.session-item-content {
			flex: 1;
			min-width: 0;
		}

		.pin-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: none;
			border: none;
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.1rem;
			border-radius: 3px;
			opacity: 0;
			transition: all 0.15s;
			flex-shrink: 0;
			margin-top: 0;
		}

		.pin-btn.pinned {
			opacity: 0.6;
			color: var(--picker-active);
		}

		.session-item:hover .pin-btn {
			opacity: 0.5;
		}

		.pin-btn:hover {
			opacity: 1 !important;
			color: var(--picker-active);
			background: var(--picker-active-bg);
		}

		.pin-indicator {
			font-size: 0.65rem;
		}

		.delete-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: none;
			border: none;
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.1rem;
			border-radius: 3px;
			opacity: 0;
			transition: all 0.15s;
			flex-shrink: 0;
			margin-top: 0;
		}

		.session-item:hover .delete-btn {
			opacity: 0.5;
		}

		.delete-btn:hover {
			opacity: 1 !important;
			color: #ef4444;
			background: color-mix(in srgb, #ef4444 10%, transparent);
		}

		.show-more-btn {
			display: block;
			width: 100%;
			box-sizing: border-box;
			padding: 0.2rem 0.75rem 0.2rem 1.25rem;
			border: none;
			background: none;
			color: var(--picker-muted);
			text-align: left;
			cursor: pointer;
			font-size: 0.65rem;
			font-weight: 500;
			transition: all 0.15s;
		}

		.show-more-btn:hover {
			color: var(--picker-active);
			background: var(--picker-hover);
		}

		.empty {
			padding: 1rem 0.75rem;
			text-align: center;
			color: var(--picker-muted);
			font-size: 0.8rem;
		}

		.loading {
			padding: 1rem 0.75rem;
			text-align: center;
			color: var(--picker-muted);
			font-size: 0.8rem;
		}

		/* ── Skeleton loading ─────────────────────────────────── */

		@keyframes skeleton-pulse {
			0%, 100% { opacity: 0.6; }
			50% { opacity: 0.25; }
		}

		.skeleton-group-header {
			padding: 0.35rem 0.75rem;
			margin-top: 0.25rem;
		}

		.skeleton-bar {
			background: var(--picker-muted);
			border-radius: 3px;
			animation: skeleton-pulse 1.5s ease-in-out infinite;
			opacity: 0.3;
		}

		.skeleton-item {
			padding: 0.4rem 0.75rem;
		}

		.skeleton-name {
			height: 11px;
			border-radius: 3px;
			margin-bottom: 5px;
		}

		.skeleton-meta {
			height: 9px;
			border-radius: 3px;
		}

		/* ── Folder picker overlay ────────────────────────────────── */

		.folder-picker {
			position: absolute;
			inset: 0;
			z-index: 10;
			display: flex;
			flex-direction: column;
			background: var(--picker-bg);
		}

		.folder-picker-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.5rem 0.75rem;
			border-bottom: 1px solid var(--picker-border);
			flex-shrink: 0;
		}

		.folder-picker-title {
			font-size: 0.8rem;
			font-weight: 600;
			color: var(--picker-text);
		}

		.folder-picker-close {
			background: none;
			border: none;
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.15rem 0.3rem;
			border-radius: 3px;
			font-size: 0.85rem;
			line-height: 1;
		}

		.folder-picker-close:hover {
			color: var(--picker-text);
			background: var(--picker-hover);
		}

		.folder-picker-input {
			padding: 0.5rem 0.75rem;
			border-bottom: 1px solid var(--picker-border);
			flex-shrink: 0;
		}

		.folder-picker-input input {
			width: 100%;
			box-sizing: border-box;
			padding: 0.35rem 0.5rem;
			border: 1px solid var(--picker-border);
			border-radius: 4px;
			background: var(--picker-bg);
			color: var(--picker-text);
			font-size: 0.75rem;
			font-family: monospace;
			outline: none;
		}

		.folder-picker-input input:focus {
			border-color: var(--picker-active);
		}

		.folder-picker-list {
			flex: 1;
			overflow-y: auto;
			padding: 0.25rem 0;
		}

		.folder-picker-section {
			padding: 0.4rem 0.75rem 0.2rem;
			font-size: 0.65rem;
			font-weight: 600;
			color: var(--picker-muted);
			text-transform: uppercase;
			letter-spacing: 0.03em;
		}

		.folder-item {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			width: 100%;
			box-sizing: border-box;
			padding: 0.3rem 0.75rem;
			border: none;
			background: none;
			color: var(--picker-text);
			text-align: left;
			cursor: pointer;
			font-size: 0.8rem;
			transition: background 0.1s;
		}

		.folder-item:hover {
			background: var(--picker-hover);
		}

		.folder-item.known-cwd {
			color: var(--picker-active);
		}

		.folder-icon {
			flex-shrink: 0;
			color: var(--picker-muted);
		}

		.folder-name {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.folder-go-btn {
			background: none;
			border: 1px solid var(--picker-border);
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.1rem 0.35rem;
			border-radius: 3px;
			font-size: 0.65rem;
			flex-shrink: 0;
			transition: all 0.15s;
		}

		.folder-go-btn:hover {
			color: var(--picker-text);
			border-color: var(--picker-active);
		}

		.folder-picker-actions {
			padding: 0.5rem 0.75rem;
			border-top: 1px solid var(--picker-border);
			flex-shrink: 0;
		}

		.folder-picker-actions button {
			width: 100%;
			padding: 0.4rem;
			border: 1px solid var(--picker-active);
			border-radius: 4px;
			background: var(--picker-active);
			color: white;
			cursor: pointer;
			font-size: 0.8rem;
			font-weight: 500;
			transition: opacity 0.15s;
		}

		.folder-picker-actions button:hover {
			opacity: 0.9;
		}
	`;

	@property({ attribute: false })
	agent!: WsAgentAdapter;

	/**
	 * Optional prefetched session list.  When provided, the picker skips
	 * its initial REST call and renders immediately (no skeleton flash).
	 * Subsequent refreshes still go through the normal fetch path.
	 */
	@property({ attribute: false })
	prefetchedSessions: SessionInfoDTO[] | undefined;

	/** Callbacks for the burger menu actions (settings, theme, etc.) */
	@property({ attribute: false })
	burgerMenu: BurgerMenuCallbacks | undefined;

	/** Max visible sessions per project before "show more" truncation. Default: 5. */
	@property({ type: Number, attribute: false })
	sessionsPerProject = 5;

	@state() private sessions: SessionInfoDTO[] = [];
	@state() private loading = true;
	@state() private showSkeleton = false;
	@state() private searchQuery = "";
	@state() private expandedGroups = new Set<string>();
	@state() private pinnedSessions = loadPinnedSessions();
	@state() private burgerMenuOpen = false;
	@state() private themeSubmenuOpen = false;
	@state() private burgerMenuPos = { top: 0, left: 0 };

	// Folder picker state
	@state() private showFolderPicker = false;
	@state() private folderPath = "~";
	@state() private folderDirs: DirEntry[] = [];
	@state() private folderLoading = false;

	private unsubSessionChange?: () => void;
	private unsubSessionsChanged?: () => void;
	private unsubGlobalStatus?: () => void;
	private unsubStatusChange?: () => void;

	// ── Single-flight coalescing fetch state ────────────────────────────────
	private _fetchInFlight = false;
	private _fetchDirty = false;
	private _sessionsChangedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _skeletonGraceTimer: ReturnType<typeof setTimeout> | null = null;
	private _lastObservedSessionStatus: "virtual" | "attached" | "detached" | undefined;

	connectedCallback() {
		super.connectedCallback();

		// If the parent prefetched the session list, use it directly —
		// skip the initial REST call entirely and never show a skeleton.
		if (this.prefetchedSessions) {
			this.sessions = this.prefetchedSessions;
			this.loading = false;
			// Clear so subsequent updates go through normal refresh
			this.prefetchedSessions = undefined;
		} else {
			// Only show skeleton after a 300ms grace period — avoids flicker on fast loads
			this._skeletonGraceTimer = setTimeout(() => {
				if (this.loading) this.showSkeleton = true;
			}, 300);
			this.refreshSessions();
		}
		if (this.agent) {
			this._lastObservedSessionStatus = this.agent.sessionStatus;
			this.unsubSessionChange = this.agent.onSessionChange(() => {
				// Merge optimistic/virtual immediately (no REST call needed)
				this.mergeOptimisticSessions();
				this.requestUpdate();
				this.refreshSessions();
			});
			this.unsubSessionsChanged = this.agent.onSessionsChanged(() => {
				// Immediately merge any optimistic sessions into the current list
				// so they appear without waiting for the async REST call.
				this.mergeOptimisticSessions();
				// Debounce the REST fetch — file watcher events arrive in bursts
				this.debouncedRefreshSessions();
			});
			this.unsubGlobalStatus = this.agent.onGlobalStatusChange(() => {
				this.requestUpdate();
			});
			this.unsubStatusChange = this.agent.onStatusChange(() => {
				const prev = this._lastObservedSessionStatus;
				const next = this.agent.sessionStatus;
				this._lastObservedSessionStatus = next;
				// Clear only on transition into "attached" (prompt just sent),
				// not on every status update while still attached.
				if (next === "attached" && prev !== "attached") {
					this.clearSearchFilter();
				}
			});
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		this.unsubSessionChange?.();
		this.unsubSessionsChanged?.();
		this.unsubGlobalStatus?.();
		this.unsubStatusChange?.();
		this._removeBurgerPortal();
		if (this._sessionsChangedDebounceTimer) {
			clearTimeout(this._sessionsChangedDebounceTimer);
			this._sessionsChangedDebounceTimer = null;
		}
		if (this._skeletonGraceTimer) {
			clearTimeout(this._skeletonGraceTimer);
			this._skeletonGraceTimer = null;
		}
	}

	/**
	 * Immediately merge optimistic and virtual sessions into the current cached list.
	 * This makes new sessions appear in the sidebar instantly (same frame)
	 * without waiting for the async REST call to /api/sessions.
	 */
	private mergeOptimisticSessions() {
		const optimistic = this.agent.optimisticSessions;
		const virtual = this.agent.virtualSessionInfo;

		// Collect all entries to merge
		const toMerge = [...optimistic];
		if (virtual) toMerge.push(virtual);
		if (toMerge.length === 0) return;

		// Remove any stale virtual entries before merging
		let sessions = this.sessions.filter((s) => !s.path.startsWith("__virtual__"));
		const existingPaths = new Set(sessions.map((s) => s.path));
		let changed = sessions.length !== this.sessions.length;

		for (const opt of toMerge) {
			if (existingPaths.has(opt.path)) {
				// Path exists — backfill cwd if the cached entry has none.
				// This happens when a file watcher notification arrives before
				// session_attached, and the REST API returns the session with
				// an empty cwd (JSONL header not yet fully written).
				if (opt.cwd) {
					const existing = sessions.find((s) => s.path === opt.path);
					if (existing && !existing.cwd) {
						existing.cwd = opt.cwd;
						changed = true;
					}
				}
			} else {
				sessions = [...sessions, opt];
				changed = true;
			}
		}
		if (changed) {
			this.sessions = sessions;
			this.requestUpdate();
		}
	}

	/**
	 * Debounced version of refreshSessions for file-watcher events.
	 * Coalesces rapid-fire sessions_changed signals into a single fetch.
	 */
	private debouncedRefreshSessions() {
		if (this._sessionsChangedDebounceTimer) {
			clearTimeout(this._sessionsChangedDebounceTimer);
		}
		this._sessionsChangedDebounceTimer = setTimeout(() => {
			this._sessionsChangedDebounceTimer = null;
			this.refreshSessions();
		}, 500);
	}

	/**
	 * Single-flight, coalescing session list fetch.
	 *
	 * If a fetch is already in-flight, marks dirty so a re-fetch happens
	 * when the current one completes. At most 1 request is in-flight
	 * at any time, and at most 1 is queued behind it.
	 */
	async refreshSessions() {
		if (this._fetchInFlight) {
			this._fetchDirty = true;
			return;
		}

		this._fetchInFlight = true;
		const isInitial = this.sessions.length === 0;
		if (isInitial) this.loading = true;

		try {
			this.sessions = await this.agent.listSessions();
		} catch (err) {
			console.error("Failed to load sessions:", err);
			this.sessions = [];
		}
		this.loading = false;
		this.showSkeleton = false;
		if (this._skeletonGraceTimer) {
			clearTimeout(this._skeletonGraceTimer);
			this._skeletonGraceTimer = null;
		}
		this._fetchInFlight = false;

		// If something changed while we were fetching, re-fetch once more.
		if (this._fetchDirty) {
			this._fetchDirty = false;
			this.refreshSessions();
		}
	}

	private get knownCwds(): string[] {
		const cwds = new Set<string>();
		for (const s of this.sessions) {
			if (s.cwd) cwds.add(s.cwd);
		}
		return Array.from(cwds).sort();
	}

	private get filteredGroups(): SessionGroup[] {
		const query = this.searchQuery.toLowerCase().trim();
		let filtered = this.sessions;

		if (query) {
			filtered = filtered.filter(
				(s) =>
					(s.name?.toLowerCase().includes(query)) ||
					s.firstMessage.toLowerCase().includes(query) ||
					s.cwd.toLowerCase().includes(query) ||
					(s.cwdDisplay?.toLowerCase().includes(query) ?? false),
			);
		}

		const groupMap = new Map<string, SessionInfoDTO[]>();
		for (const s of filtered) {
			const key = s.cwd || "(unknown)";
			if (!groupMap.has(key)) groupMap.set(key, []);
			groupMap.get(key)!.push(s);
		}

		const groups: SessionGroup[] = [];
		for (const [cwd, sessions] of groupMap) {
			const displayCwd = sessions[0]?.cwdDisplay || cwd;
			groups.push({ cwd, displayCwd, label: displayCwd, sessions });
		}

		// Sort sessions within each group:
		//   1. Running sessions (sorted by name for stability)
		//   2. Pinned sessions (sorted by recency)
		//   3. Unpinned sessions (sorted by recency)
		for (const g of groups) {
			g.sessions.sort((a, b) => {
				const aRunning = this.agent.getSessionStatus(a.path) === "running";
				const bRunning = this.agent.getSessionStatus(b.path) === "running";

				if (aRunning && bRunning) {
					const aName = this.getSessionDisplayName(a);
					const bName = this.getSessionDisplayName(b);
					return aName.localeCompare(bName, undefined, { sensitivity: "base" });
				}
				if (aRunning) return -1;
				if (bRunning) return 1;

				const aPinned = this.pinnedSessions.has(a.path);
				const bPinned = this.pinnedSessions.has(b.path);
				if (aPinned && !bPinned) return -1;
				if (!aPinned && bPinned) return 1;

				const aTime = a.lastUserPromptTime ? new Date(a.lastUserPromptTime).getTime() : new Date(a.modified).getTime();
				const bTime = b.lastUserPromptTime ? new Date(b.lastUserPromptTime).getTime() : new Date(b.modified).getTime();
				return bTime - aTime;
			});
		}

		// Sort groups by the most recent user prompt across their sessions.
		// Running sessions count as "now" (most recent possible).
		groups.sort((a, b) => {
			const groupRecency = (g: SessionGroup): number => {
				let best = 0;
				for (const s of g.sessions) {
					if (this.agent.getSessionStatus(s.path) === "running") return Infinity;
					const t = s.lastUserPromptTime ? new Date(s.lastUserPromptTime).getTime() : new Date(s.modified).getTime();
					best = Math.max(best, t);
				}
				return best;
			};
			const diff = groupRecency(b) - groupRecency(a);
			// If equal recency (e.g. both have running sessions), sort by label for stability
			if (diff === 0) return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
			return diff;
		});

		return groups;
	}

	private getSessionDisplayName(s: SessionInfoDTO): string {
		if (s.name) return s.name;
		const msg = s.firstMessage;
		if (!msg || msg === "(no messages)") return "New session";
		return msg.length > 100 ? msg.slice(0, 100) + "…" : msg;
	}

	private formatTime(isoString: string): string {
		const d = new Date(isoString);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return "just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return d.toLocaleDateString();
	}

	// ── Actions ─────────────────────────────────────────────────────────────

	private async handleSessionClick(session: SessionInfoDTO) {
		if (session.id === this.agent?.sessionId) return;
		if (session.path.startsWith("__virtual__")) return; // Can't switch to another virtual session
		this.clearSearchFilter();
		// Collapse all expanded groups when picking a session
		if (this.expandedGroups.size > 0) {
			this.expandedGroups = new Set();
		}
		try {
			await this.agent.switchSession(session.path);
		} catch (err) {
			console.error("Failed to switch session:", err);
		}
	}

	private async handleNewSessionInGroup(cwd: string) {
		this.clearSearchFilter();
		try {
			await this.agent.newSession(cwd);
		} catch (err) {
			console.error("Failed to create new session:", err);
		}
	}

	private handleTogglePin(e: Event, session: SessionInfoDTO) {
		e.stopPropagation();
		e.preventDefault();
		const next = new Set(this.pinnedSessions);
		if (next.has(session.path)) {
			next.delete(session.path);
		} else {
			next.add(session.path);
		}
		this.pinnedSessions = next;
		savePinnedSessions(next);
	}

	private async handleDeleteSession(e: Event, session: SessionInfoDTO) {
		e.stopPropagation();
		e.preventDefault();

		// Virtual sessions have no file to delete — just create a fresh session
		if (session.path.startsWith("__virtual__")) {
			this.agent.newSession();
			return;
		}

		const isActive = session.id === this.agent?.sessionId;
		const name = session.name || session.firstMessage || "this session";
		if (!confirm(`Delete "${name.slice(0, 60)}"?`)) return;

		// Optimistically remove from UI immediately
		this.sessions = this.sessions.filter((s) => s.path !== session.path);
		if (this.pinnedSessions.has(session.path)) {
			const next = new Set(this.pinnedSessions);
			next.delete(session.path);
			this.pinnedSessions = next;
			savePinnedSessions(next);
		}
		if (isActive) {
			this.agent.newSession();
		}

		// Delete in background — restore on failure
		try {
			await this.agent.deleteSession(session.path);
		} catch (err) {
			console.error("Failed to delete session:", err);
			// Restore the session on failure
			await this.refreshSessions();
		}
	}

	private handleSearch(e: Event) {
		this.searchQuery = (e.target as HTMLInputElement).value;
	}

	/** Clear the session search filter (e.g. after creating a new session or sending input). */
	private clearSearchFilter() {
		if (this.searchQuery) {
			this.searchQuery = "";
		}
	}

	// ── Folder picker ───────────────────────────────────────────────────────

	private openFolderPicker() {
		this.showFolderPicker = true;
		this.folderPath = "~";
		this.browseTo("~");
	}

	private closeFolderPicker() {
		this.showFolderPicker = false;
	}

	private async browseTo(dirPath: string) {
		this.folderLoading = true;
		try {
			const res = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`);
			if (!res.ok) throw new Error("Failed to browse");
			const data = await res.json();
			this.folderPath = data.path;
			this.folderDirs = data.dirs;
		} catch (err) {
			console.error("Failed to browse directory:", err);
			this.folderDirs = [];
		}
		this.folderLoading = false;
	}

	private handleFolderInputChange(e: Event) {
		this.folderPath = (e.target as HTMLInputElement).value;
	}

	private handleFolderInputKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			this.browseTo(this.folderPath);
		}
	}

	private handleFolderClick(dir: DirEntry) {
		// Set the input to the clicked folder's path
		this.folderPath = dir.path;
		// Also browse into it to show subfolders
		this.browseTo(dir.path);
	}

	private handleFolderSelect() {
		this.showFolderPicker = false;
		this.clearSearchFilter();
		this.agent.newSession(this.folderPath);
	}

	private handleParentFolder() {
		const parent = this.folderPath.replace(/\/[^/]+\/?$/, "") || "/";
		this.folderPath = parent;
		this.browseTo(parent);
	}

	// ── Render ──────────────────────────────────────────────────────────────

	private _burgerPortal: HTMLDivElement | null = null;

	private closeBurgerMenu() {
		this.burgerMenuOpen = false;
		this.themeSubmenuOpen = false;
		this._removeBurgerPortal();
	}

	private _removeBurgerPortal() {
		if (this._burgerPortal) {
			this._burgerPortal.remove();
			this._burgerPortal = null;
		}
	}

	private _ensureBurgerPortal(): HTMLDivElement {
		if (!this._burgerPortal) {
			this._burgerPortal = document.createElement("div");
			this._burgerPortal.id = "burger-menu-portal";
			document.body.appendChild(this._burgerPortal);
		}
		return this._burgerPortal;
	}

	updated(changedProperties: Map<string, unknown>) {
		super.updated(changedProperties);
		if (this.burgerMenuOpen && this.burgerMenu) {
			this._renderBurgerPortal();
		} else {
			this._removeBurgerPortal();
		}
	}

	private _renderBurgerPortal() {
		if (!this.burgerMenuOpen || !this.burgerMenu) return;

		const portal = this._ensureBurgerPortal();
		const bm = this.burgerMenu;
		const currentTheme = getColorTheme();
		const currentMode = getDarkMode();
		const pos = this.burgerMenuPos;

		const colorThemes: { id: ColorTheme; label: string }[] = [
			{ id: "default", label: "Legacy" },
			{ id: "gruvbox", label: "Gruvbox" },
		];
		const darkModes: { id: DarkMode; label: string; icon: string }[] = [
			{ id: "light", label: "Light", icon: "☀️" },
			{ id: "dark", label: "Dark", icon: "🌙" },
			{ id: "system", label: "System", icon: "💻" },
		];

		const tpl = html`
			<div class="burger-dropdown-backdrop" @click=${() => this.closeBurgerMenu()}></div>
			<div class="burger-dropdown" style="top: ${pos.top}px; left: ${pos.left}px;">
				<button
					class="burger-item"
					@click=${() => { this.closeBurgerMenu(); bm.onOpenSettings(); }}
				>
					<span class="burger-item-icon">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
					</span>
					<span class="burger-item-label">Settings</span>
				</button>
				<div class="burger-divider"></div>
				<button
					class="burger-item ${!bm.isTokenUsageHidden ? 'is-active' : ''}"
					@click=${() => { this.closeBurgerMenu(); bm.onToggleTokenUsage(); }}
				>
					<span class="burger-item-icon">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
						</svg>
					</span>
					<span class="burger-item-label">Token usage</span>
					<span class="burger-item-check">${!bm.isTokenUsageHidden ? '✓' : ''}</span>
				</button>
				<button
					class="burger-item ${bm.isJsonlVisible ? 'is-active' : ''}"
					@click=${() => { this.closeBurgerMenu(); bm.onToggleJsonl(); }}
				>
					<span class="burger-item-icon">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="16 18 22 12 16 6"></polyline>
							<polyline points="8 6 2 12 8 18"></polyline>
						</svg>
					</span>
					<span class="burger-item-label">JSONL viewer</span>
					<span class="burger-item-check">${bm.isJsonlVisible ? '✓' : ''}</span>
				</button>
				<div class="burger-divider"></div>
				<div class="burger-section-label">Color Theme</div>
				${colorThemes.map(t => html`
					<button
						class="burger-item ${currentTheme === t.id ? 'is-active' : ''}"
						@click=${() => { this.closeBurgerMenu(); setColorTheme(t.id); }}
					>
						<span class="burger-item-icon"></span>
						<span class="burger-item-label">${t.label}</span>
						<span class="burger-item-check">${currentTheme === t.id ? '✓' : ''}</span>
					</button>
				`)}
				<div class="burger-divider"></div>
				<div class="burger-section-label">Appearance</div>
				${darkModes.map(m => html`
					<button
						class="burger-item ${currentMode === m.id ? 'is-active' : ''}"
						@click=${() => { this.closeBurgerMenu(); setDarkMode(m.id); }}
					>
						<span class="burger-item-icon">${m.icon}</span>
						<span class="burger-item-label">${m.label}</span>
						<span class="burger-item-check">${currentMode === m.id ? '✓' : ''}</span>
					</button>
				`)}
			</div>
		`;

		render(tpl, portal);
	}

	render() {
		const groups = this.filteredGroups;
		const activeId = this.agent?.sessionId;

		return html`
			<div style="position: relative; height: 100%; display: flex; flex-direction: column;">
				<div class="header ${this.burgerMenu?.isDevMode ? 'dev' : ''}">
					<div class="header-left">
						<button
							class="burger-btn"
							@click=${(e: Event) => {
								e.stopPropagation();
								if (!this.burgerMenuOpen) {
									const btn = e.currentTarget as HTMLElement;
									const rect = btn.getBoundingClientRect();
									this.burgerMenuPos = { top: rect.bottom + 4, left: rect.left };
								}
								this.burgerMenuOpen = !this.burgerMenuOpen;
								this.themeSubmenuOpen = false;
							}}
							title="Menu"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<line x1="3" y1="12" x2="21" y2="12"></line>
								<line x1="3" y1="6" x2="21" y2="6"></line>
								<line x1="3" y1="18" x2="21" y2="18"></line>
							</svg>
						</button>
						<span class="header-title">${this.burgerMenu?.isDevMode ? 'pipane · dev' : 'pipane'}</span>
					</div>
					<div class="header-right">
						<button class="new-btn" @click=${this.openFolderPicker}>+ NEW</button>
					</div>
				</div>
				<div class="search">
					<input
						type="text"
						placeholder="Search sessions…"
						.value=${this.searchQuery}
						@input=${this.handleSearch}
					/>
				</div>
				<div class="sessions-list">
					${this.loading && this.showSkeleton
						? this.renderSkeletonSessions()
						: this.loading
							? nothing
							: groups.length === 0
							? html`<div class="empty">No sessions found</div>`
							: repeat(groups, (g) => g.cwd, (group) => this.renderGroup(group, activeId))}
				</div>

				${this.showFolderPicker ? this.renderFolderPicker() : nothing}
			</div>
		`;
	}

	private renderSkeletonSessions(): TemplateResult {
		// Skeleton placeholders that match the geometry of real session items.
		// Widths vary to look natural.
		const items = [
			{ nameW: "80%", metaW: "45%" },
			{ nameW: "65%", metaW: "55%" },
			{ nameW: "90%", metaW: "40%" },
			{ nameW: "70%", metaW: "50%" },
			{ nameW: "85%", metaW: "35%" },
			{ nameW: "60%", metaW: "48%" },
		];
		return html`
			<!-- Skeleton group header -->
			<div class="skeleton-group-header">
				<div class="skeleton-bar" style="width:72px;height:10px;"></div>
			</div>
			${items.map((item) => html`
				<div class="skeleton-item">
					<div class="skeleton-bar skeleton-name" style="width:${item.nameW};"></div>
					<div class="skeleton-bar skeleton-meta" style="width:${item.metaW};"></div>
				</div>
			`)}
		`;
	}

	private renderGroup(group: SessionGroup, activeId: string): TemplateResult {
		const isExpanded = this.expandedGroups.has(group.cwd);

		// Count running sessions in this group
		const runningCount = group.sessions.filter(
			(s) => this.agent.getSessionStatus(s.path) === "running"
		).length;

		// Show at least sessionsPerProject or all running sessions, whichever is more
		const defaultLimit = Math.max(this.sessionsPerProject, runningCount);
		const totalCount = group.sessions.length;
		const needsTruncation = totalCount > defaultLimit;
		const visibleSessions = isExpanded || !needsTruncation
			? group.sessions
			: group.sessions.slice(0, defaultLimit);
		const hiddenCount = totalCount - visibleSessions.length;

		return html`
			<div class="group-header" title=${group.cwd}>
				<span class="group-label">${group.label}</span>
				<button
					class="group-new-btn"
					@click=${(e: Event) => { e.stopPropagation(); this.handleNewSessionInGroup(group.cwd); }}
					title="New session in ${group.cwd}"
				>+ NEW</button>
			</div>
			${repeat(
				visibleSessions,
				(s) => s.id,
				(s) => {
					const status = this.agent.getSessionStatus(s.path);
					const effectiveStatus = status ?? "idle";
					const isPinned = this.pinnedSessions.has(s.path);
					return html`
					<button
						class="session-item ${s.id === activeId ? "active" : ""}"
						@click=${() => this.handleSessionClick(s)}
						title="${s.cwd}\n${s.firstMessage}"
					>
						<div class="session-item-row">
							<span class="status-badge ${effectiveStatus}">${nothing}</span>
							<div class="session-item-content">
								<span class="session-name">${this.getSessionDisplayName(s)}</span>
								<span class="session-meta">
									${this.formatTime(s.lastUserPromptTime || s.modified)}
									<span class="msg-count-badge">${s.messageCount}</span>
									<span
										class="pin-btn ${isPinned ? "pinned" : ""}"
										@click=${(e: Event) => this.handleTogglePin(e, s)}
										title="${isPinned ? "Unpin session" : "Pin to top"}"
									>
										<svg width="14" height="14" viewBox="0 0 24 24" fill="${isPinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M12 17v5"></path>
											<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"></path>
										</svg>
									</span>
									<span
										class="delete-btn"
										@click=${(e: Event) => this.handleDeleteSession(e, s)}
										title="Delete session"
									>
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<polyline points="3 6 5 6 21 6"></polyline>
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
										</svg>
									</span>
								</span>
							</div>
						</div>
					</button>
				`;
				},
			)}
			${needsTruncation
				? isExpanded
					? html`<button class="show-more-btn" @click=${() => this.toggleGroupExpansion(group.cwd)}>▴ Show less</button>`
					: html`<button class="show-more-btn" @click=${() => this.toggleGroupExpansion(group.cwd)}>▾ Show ${hiddenCount} more…</button>`
				: nothing}
		`;
	}

	private toggleGroupExpansion(cwd: string) {
		if (this.expandedGroups.has(cwd)) {
			this.expandedGroups.delete(cwd);
		} else {
			this.expandedGroups.add(cwd);
		}
		this.requestUpdate();
	}

	private renderFolderPicker(): TemplateResult {
		const knownCwds = this.knownCwds;
		// Folder icon SVG
		const folderIcon = html`
			<svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
			</svg>
		`;

		return html`
			<div class="folder-picker">
				<div class="folder-picker-header">
					<span class="folder-picker-title">Open Folder</span>
					<button class="folder-picker-close" @click=${this.closeFolderPicker}>✕</button>
				</div>

				<div class="folder-picker-input">
					<input
						type="text"
						.value=${this.folderPath}
						@input=${this.handleFolderInputChange}
						@keydown=${this.handleFolderInputKeydown}
						placeholder="/path/to/project"
					/>
				</div>

				<div class="folder-picker-list">
					${knownCwds.length > 0 ? html`
						<div class="folder-picker-section">Recent projects</div>
						${knownCwds.map((cwd) => {
							const label = cwd.split("/").filter(Boolean).pop() || cwd;
							return html`
								<button class="folder-item known-cwd" @click=${() => { this.folderPath = cwd; this.browseTo(cwd); }} title=${cwd}>
									${folderIcon}
									<span class="folder-name">${label}</span>
								</button>
							`;
						})}
					` : nothing}

					<div class="folder-picker-section">
						${this.folderPath}
						${this.folderPath !== "/" ? html`
							<button class="folder-go-btn" @click=${this.handleParentFolder} title="Go up">↑ up</button>
						` : nothing}
					</div>

					${this.folderLoading
						? html`<div class="loading">Loading…</div>`
						: this.folderDirs.length === 0
							? html`<div class="empty">No subfolders</div>`
							: this.folderDirs.map((dir) => html`
								<button class="folder-item" @click=${() => this.handleFolderClick(dir)} title=${dir.path}>
									${folderIcon}
									<span class="folder-name">${dir.name}</span>
								</button>
							`)
					}
				</div>

				<div class="folder-picker-actions">
					<button @click=${this.handleFolderSelect}>
						Open in ${this.folderPath.split("/").filter(Boolean).pop() || this.folderPath}
					</button>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"session-picker": SessionPicker;
	}
}

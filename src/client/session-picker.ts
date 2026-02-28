/**
 * Session picker sidebar component.
 *
 * Shows a list of all sessions from the pi CLI state files,
 * grouped by project (cwd). Each group has a "+" button to create
 * a new session in that folder. The top "+ New" button opens a
 * folder picker to choose a CWD for a new session.
 */

import { html, css, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { WsAgentAdapter, SessionInfoDTO } from "./ws-agent-adapter.js";

interface SessionGroup {
	cwd: string;
	label: string;
	sessions: SessionInfoDTO[];
}

interface DirEntry {
	name: string;
	path: string;
}

const PINNED_STORAGE_KEY = "pi-web-pinned-sessions";

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

		.header-title {
			font-size: 0.8rem;
			font-weight: 600;
			color: var(--picker-text);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.new-btn {
			background: none;
			border: 1px solid var(--picker-border);
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.2rem 0.5rem;
			border-radius: 4px;
			font-size: 0.75rem;
			transition: all 0.15s;
		}

		.new-btn:hover {
			color: var(--picker-text);
			border-color: var(--picker-muted);
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
			padding: 0.35rem 0.75rem;
			margin-top: 0.25rem;
			background: color-mix(in srgb, var(--picker-text) 5%, transparent);
			border-top: 1px solid var(--picker-border);
			border-bottom: 1px solid color-mix(in srgb, var(--picker-border) 60%, transparent);
		}

		.group-header:first-child {
			margin-top: 0;
			border-top: none;
		}

		.group-label {
			font-size: 0.72rem;
			font-weight: 700;
			color: var(--picker-text);
			text-transform: uppercase;
			letter-spacing: 0.04em;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			flex: 1;
			min-width: 0;
			opacity: 0.8;
		}

		.group-new-btn {
			background: none;
			border: 1px solid var(--picker-border);
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.05rem 0.35rem;
			font-size: 0.8rem;
			font-weight: 600;
			line-height: 1.2;
			border-radius: 4px;
			opacity: 0.7;
			transition: all 0.15s;
			flex-shrink: 0;
		}

		.group-header:hover .group-new-btn {
			opacity: 1;
			border-color: var(--picker-muted);
		}

		.group-new-btn:hover {
			opacity: 1 !important;
			color: var(--picker-active);
			border-color: var(--picker-active);
			background: var(--picker-active-bg);
		}

		.session-item {
			display: block;
			width: 100%;
			box-sizing: border-box;
			padding: 0.4rem 0.75rem;
			border: none;
			background: none;
			color: var(--picker-text);
			text-align: left;
			cursor: pointer;
			font-size: 0.8rem;
			line-height: 1.3;
			transition: background 0.1s;
		}

		.session-item:hover {
			background: var(--picker-hover);
		}

		.session-item.active {
			background: var(--picker-active-bg);
			border-left: 2px solid var(--picker-active);
		}

		.session-name {
			font-weight: 500;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
			text-overflow: ellipsis;
			word-break: break-word;
		}

		.session-meta {
			font-size: 0.7rem;
			color: var(--picker-muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			display: flex;
			align-items: center;
			gap: 0.35rem;
			margin-top: 1px;
		}

		.status-badge {
			display: inline-flex;
			align-items: center;
			gap: 0.2rem;
			font-size: 0.6rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			padding: 0.05rem 0.3rem;
			border-radius: 3px;
			white-space: nowrap;
			flex-shrink: 0;
		}

		.status-badge.running {
			color: #ef4444;
			background: color-mix(in srgb, #ef4444 12%, transparent);
		}

		.status-badge.running .status-dot {
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: #ef4444;
			animation: pulse-dot 1.5s ease-in-out infinite;
		}

		@keyframes pulse-dot {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.3; }
		}

		.status-badge.done {
			color: #22c55e;
			background: color-mix(in srgb, #22c55e 12%, transparent);
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
			background: none;
			border: none;
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.15rem;
			border-radius: 3px;
			opacity: 0;
			transition: all 0.15s;
			flex-shrink: 0;
			margin-top: 0.1rem;
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
			background: none;
			border: none;
			color: var(--picker-muted);
			cursor: pointer;
			padding: 0.15rem;
			border-radius: 3px;
			opacity: 0;
			transition: all 0.15s;
			flex-shrink: 0;
			margin-top: 0.1rem;
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
			padding: 0.3rem 0.75rem;
			border: none;
			background: none;
			color: var(--picker-muted);
			text-align: left;
			cursor: pointer;
			font-size: 0.72rem;
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

	@state() private sessions: SessionInfoDTO[] = [];
	@state() private loading = true;
	@state() private searchQuery = "";
	@state() private expandedGroups = new Set<string>();
	@state() private pinnedSessions = loadPinnedSessions();

	// Folder picker state
	@state() private showFolderPicker = false;
	@state() private folderPath = "~";
	@state() private folderDirs: DirEntry[] = [];
	@state() private folderLoading = false;

	private unsubSessionChange?: () => void;
	private unsubSessionsChanged?: () => void;
	private unsubGlobalStatus?: () => void;

	connectedCallback() {
		super.connectedCallback();
		this.loadSessions();
		if (this.agent) {
			this.unsubSessionChange = this.agent.onSessionChange(() => {
				this.requestUpdate();
				this.loadSessions();
			});
			this.unsubSessionsChanged = this.agent.onSessionsChanged(() => {
				// Immediately merge any optimistic sessions into the current list
				// so they appear without waiting for the async REST call.
				this.mergeOptimisticSessions();
				this.loadSessions();
			});
			this.unsubGlobalStatus = this.agent.onGlobalStatusChange(() => {
				this.requestUpdate();
			});
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		this.unsubSessionChange?.();
		this.unsubSessionsChanged?.();
		this.unsubGlobalStatus?.();
	}

	/**
	 * Immediately merge optimistic sessions into the current cached list.
	 * This makes new sessions appear in the sidebar instantly (same frame)
	 * without waiting for the async REST call to /api/sessions.
	 */
	private mergeOptimisticSessions() {
		const optimistic = this.agent.optimisticSessions;
		if (optimistic.length === 0) return;

		const existingPaths = new Set(this.sessions.map((s) => s.path));
		let changed = false;
		for (const opt of optimistic) {
			if (!existingPaths.has(opt.path)) {
				this.sessions = [...this.sessions, opt];
				changed = true;
			}
		}
		if (changed) {
			this.requestUpdate();
		}
	}

	async loadSessions() {
		const isInitial = this.sessions.length === 0;
		if (isInitial) this.loading = true;
		try {
			this.sessions = await this.agent.listSessions();
		} catch (err) {
			console.error("Failed to load sessions:", err);
			this.sessions = [];
		}
		this.loading = false;
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
					s.cwd.toLowerCase().includes(query),
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
			const parts = cwd.split("/").filter(Boolean);
			const label = parts[parts.length - 1] || cwd;
			groups.push({ cwd, label, sessions });
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
		try {
			await this.agent.switchSession(session.path);
		} catch (err) {
			console.error("Failed to switch session:", err);
		}
	}

	private async handleNewSessionInGroup(cwd: string) {
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
			await this.loadSessions();
		}
	}

	private handleSearch(e: Event) {
		this.searchQuery = (e.target as HTMLInputElement).value;
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
		this.agent.newSession(this.folderPath);
	}

	private handleParentFolder() {
		const parent = this.folderPath.replace(/\/[^/]+\/?$/, "") || "/";
		this.folderPath = parent;
		this.browseTo(parent);
	}

	// ── Render ──────────────────────────────────────────────────────────────

	render() {
		const groups = this.filteredGroups;
		const activeId = this.agent?.sessionId;

		return html`
			<div style="position: relative; height: 100%; display: flex; flex-direction: column;">
				<div class="header">
					<span class="header-title">Sessions</span>
					<button class="new-btn" @click=${this.openFolderPicker}>+ New</button>
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
					${this.loading
						? html`<div class="loading">Loading sessions…</div>`
						: groups.length === 0
							? html`<div class="empty">No sessions found</div>`
							: repeat(groups, (g) => g.cwd, (group) => this.renderGroup(group, activeId))}
				</div>

				${this.showFolderPicker ? this.renderFolderPicker() : nothing}
			</div>
		`;
	}

	private renderGroup(group: SessionGroup, activeId: string): TemplateResult {
		const isExpanded = this.expandedGroups.has(group.cwd);

		// Count running sessions in this group
		const runningCount = group.sessions.filter(
			(s) => this.agent.getSessionStatus(s.path) === "running"
		).length;

		// Show at least 5 or all running sessions, whichever is more
		const defaultLimit = Math.max(5, runningCount);
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
				>+</button>
			</div>
			${repeat(
				visibleSessions,
				(s) => s.id,
				(s) => {
					const status = this.agent.getSessionStatus(s.path);
					const isPinned = this.pinnedSessions.has(s.path);
					return html`
					<button
						class="session-item ${s.id === activeId ? "active" : ""}"
						@click=${() => this.handleSessionClick(s)}
						title="${s.cwd}\n${s.firstMessage}"
					>
						<div class="session-item-row">
							<div class="session-item-content">
								<span class="session-name">${isPinned ? html`<span class="pin-indicator">📌</span> ` : nothing}${this.getSessionDisplayName(s)}</span>
								<span class="session-meta">
									${status === "running"
										? html`<span class="status-badge running"><span class="status-dot"></span>running</span>`
										: status === "done"
											? html`<span class="status-badge done">done</span>`
											: nothing}
									${this.formatTime(s.lastUserPromptTime || s.modified)} · ${s.messageCount} msgs
								</span>
							</div>
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

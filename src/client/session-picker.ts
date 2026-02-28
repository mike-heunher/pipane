/**
 * Session picker sidebar component.
 *
 * Shows a list of all sessions from the pi CLI state files,
 * grouped by project (cwd). Allows switching sessions and creating new ones.
 */

import { html, css, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WsAgentAdapter, SessionInfoDTO } from "./ws-agent-adapter.js";

interface SessionGroup {
	cwd: string;
	label: string;
	sessions: SessionInfoDTO[];
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
			padding: 0.4rem 0.75rem 0.2rem;
			font-size: 0.7rem;
			font-weight: 600;
			color: var(--picker-muted);
			text-transform: uppercase;
			letter-spacing: 0.03em;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
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
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			display: block;
		}

		.session-meta {
			font-size: 0.7rem;
			color: var(--picker-muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			display: block;
			margin-top: 1px;
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
	`;

	@property({ attribute: false })
	agent!: WsAgentAdapter;

	@state()
	private sessions: SessionInfoDTO[] = [];

	@state()
	private loading = true;

	@state()
	private searchQuery = "";

	private unsubSessionChange?: () => void;

	connectedCallback() {
		super.connectedCallback();
		this.loadSessions();
		if (this.agent) {
			this.unsubSessionChange = this.agent.onSessionChange(() => {
				this.requestUpdate();
				this.loadSessions();
			});
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		this.unsubSessionChange?.();
	}

	async loadSessions() {
		this.loading = true;
		try {
			this.sessions = await this.agent.listSessions();
		} catch (err) {
			console.error("Failed to load sessions:", err);
			this.sessions = [];
		}
		this.loading = false;
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

		// Group by cwd
		const groupMap = new Map<string, SessionInfoDTO[]>();
		for (const s of filtered) {
			const key = s.cwd || "(unknown)";
			if (!groupMap.has(key)) groupMap.set(key, []);
			groupMap.get(key)!.push(s);
		}

		// Convert to array, label is last path segment
		const groups: SessionGroup[] = [];
		for (const [cwd, sessions] of groupMap) {
			const parts = cwd.split("/").filter(Boolean);
			const label = parts[parts.length - 1] || cwd;
			groups.push({ cwd, label, sessions });
		}

		// Sort groups: group with active session first, then by most recent
		const activeSessionId = this.agent?.sessionId;
		groups.sort((a, b) => {
			const aHasActive = a.sessions.some((s) => s.id === activeSessionId);
			const bHasActive = b.sessions.some((s) => s.id === activeSessionId);
			if (aHasActive && !bHasActive) return -1;
			if (bHasActive && !aHasActive) return 1;
			const aTime = Math.max(...a.sessions.map((s) => new Date(s.modified).getTime()));
			const bTime = Math.max(...b.sessions.map((s) => new Date(s.modified).getTime()));
			return bTime - aTime;
		});

		return groups;
	}

	private getSessionDisplayName(s: SessionInfoDTO): string {
		if (s.name) return s.name;
		const msg = s.firstMessage;
		if (!msg || msg === "(no messages)") return "New session";
		return msg.length > 60 ? msg.slice(0, 60) + "…" : msg;
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

	private async handleSessionClick(session: SessionInfoDTO) {
		if (session.id === this.agent?.sessionId) return;
		try {
			await this.agent.switchSession(session.path);
		} catch (err) {
			console.error("Failed to switch session:", err);
		}
	}

	private async handleNewSession() {
		try {
			await this.agent.newSession();
		} catch (err) {
			console.error("Failed to create new session:", err);
		}
	}

	private handleSearch(e: Event) {
		this.searchQuery = (e.target as HTMLInputElement).value;
	}

	render() {
		const groups = this.filteredGroups;
		const activeId = this.agent?.sessionId;

		return html`
			<div class="header">
				<span class="header-title">Sessions</span>
				<button class="new-btn" @click=${this.handleNewSession}>+ New</button>
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
						: groups.map((group) => this.renderGroup(group, activeId))}
			</div>
		`;
	}

	private renderGroup(group: SessionGroup, activeId: string): TemplateResult {
		return html`
			<div class="group-header" title=${group.cwd}>${group.label}</div>
			${group.sessions.map(
				(s) => html`
					<button
						class="session-item ${s.id === activeId ? "active" : ""}"
						@click=${() => this.handleSessionClick(s)}
						title="${s.cwd}\n${s.firstMessage}"
					>
						<span class="session-name">${this.getSessionDisplayName(s)}</span>
						<span class="session-meta">${this.formatTime(s.modified)} · ${s.messageCount} msgs</span>
					</button>
				`,
			)}
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"session-picker": SessionPicker;
	}
}

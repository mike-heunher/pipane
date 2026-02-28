/**
 * Fork modal component.
 *
 * Shows a searchable list of user messages from the current session.
 * Selecting one forks the session from that message's parent,
 * creating a new session with the history up to that point and
 * pre-filling the editor with the selected message text.
 */

import { html, css, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WsAgentAdapter } from "./ws-agent-adapter.js";

export interface ForkResult {
	/** The text of the selected user message (to pre-fill editor). */
	text: string;
	/** The path of the newly created session file. */
	newSessionPath: string | null;
}

@customElement("fork-modal")
export class ForkModal extends LitElement {
	static styles = css`
		:host {
			position: fixed;
			inset: 0;
			z-index: 100;
			display: flex;
			align-items: flex-start;
			justify-content: center;
			padding-top: 10vh;
		}

		.backdrop {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.5);
		}

		.modal {
			position: relative;
			width: 90%;
			max-width: 640px;
			max-height: 70vh;
			display: flex;
			flex-direction: column;
			background: var(--background, #fff);
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.75rem;
			box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
			overflow: hidden;
			animation: modal-in 0.15s ease-out;
		}

		@keyframes modal-in {
			from {
				opacity: 0;
				transform: translateY(-8px) scale(0.98);
			}
			to {
				opacity: 1;
				transform: translateY(0) scale(1);
			}
		}

		.header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.75rem 1rem;
			border-bottom: 1px solid var(--border, #e5e7eb);
			flex-shrink: 0;
		}

		.header svg {
			color: var(--muted-foreground, #6b7280);
			flex-shrink: 0;
		}

		.header-title {
			font-size: 0.875rem;
			font-weight: 600;
			color: var(--foreground, #111);
		}

		.header-hint {
			margin-left: auto;
			font-size: 0.7rem;
			color: var(--muted-foreground, #6b7280);
		}

		.search-wrapper {
			padding: 0.5rem 1rem;
			border-bottom: 1px solid var(--border, #e5e7eb);
			flex-shrink: 0;
		}

		.search-input {
			width: 100%;
			padding: 0.5rem 0.75rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-size: 0.8125rem;
			font-family: inherit;
			outline: none;
			box-sizing: border-box;
		}

		.search-input:focus {
			border-color: var(--primary, #2563eb);
			box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary, #2563eb) 20%, transparent);
		}

		.search-input::placeholder {
			color: var(--muted-foreground, #6b7280);
		}

		.messages-list {
			flex: 1;
			overflow-y: auto;
			padding: 0.25rem 0;
		}

		.message-item {
			display: flex;
			align-items: flex-start;
			gap: 0.75rem;
			padding: 0.625rem 1rem;
			cursor: pointer;
			transition: background 0.1s;
			border: none;
			background: none;
			width: 100%;
			text-align: left;
			font-family: inherit;
			color: inherit;
		}

		.message-item:hover,
		.message-item.selected {
			background: var(--accent, #f3f4f6);
		}

		.message-item.selected {
			background: color-mix(in srgb, var(--primary, #2563eb) 10%, transparent);
		}

		.message-index {
			flex-shrink: 0;
			width: 1.5rem;
			height: 1.5rem;
			display: flex;
			align-items: center;
			justify-content: center;
			border-radius: 50%;
			background: color-mix(in srgb, var(--primary, #2563eb) 10%, transparent);
			color: var(--primary, #2563eb);
			font-size: 0.7rem;
			font-weight: 700;
			margin-top: 0.05rem;
		}

		.message-text {
			flex: 1;
			font-size: 0.8125rem;
			line-height: 1.5;
			color: var(--foreground, #111);
			overflow: hidden;
			display: -webkit-box;
			-webkit-line-clamp: 3;
			-webkit-box-orient: vertical;
			word-break: break-word;
		}

		.empty {
			padding: 2rem 1rem;
			text-align: center;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.8125rem;
		}

		.loading {
			padding: 2rem 1rem;
			text-align: center;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.8125rem;
		}

		.forking-overlay {
			position: absolute;
			inset: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			background: color-mix(in srgb, var(--background, #fff) 80%, transparent);
			z-index: 10;
			border-radius: 0.75rem;
		}

		.forking-text {
			font-size: 0.875rem;
			color: var(--foreground, #111);
			font-weight: 500;
		}

		kbd {
			display: inline-flex;
			align-items: center;
			padding: 0.1rem 0.35rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.25rem;
			background: var(--accent, #f3f4f6);
			font-size: 0.65rem;
			font-family: inherit;
			color: var(--muted-foreground, #6b7280);
		}
	`;

	@property({ attribute: false })
	agent!: WsAgentAdapter;

	@state() private messages: Array<{ entryId: string; text: string }> = [];
	@state() private loading = true;
	@state() private forking = false;
	@state() private search = "";
	@state() private selectedIndex = 0;

	private onComplete?: (result: ForkResult | null) => void;

	/** Open the modal. Returns the fork result or null if cancelled. */
	open(agent: WsAgentAdapter): Promise<ForkResult | null> {
		this.agent = agent;
		this.loading = true;
		this.forking = false;
		this.search = "";
		this.selectedIndex = 0;
		this.messages = [];

		this.loadMessages();

		return new Promise((resolve) => {
			this.onComplete = resolve;
		});
	}

	private async loadMessages() {
		try {
			this.messages = await this.agent.getForkMessages();
		} catch (err) {
			console.error("Failed to load fork messages:", err);
			this.messages = [];
		}
		this.loading = false;
	}

	private get filteredMessages() {
		if (!this.search.trim()) return this.messages;
		const q = this.search.toLowerCase();
		return this.messages.filter((m) => m.text.toLowerCase().includes(q));
	}

	private close(result: ForkResult | null = null) {
		this.onComplete?.(result);
		this.onComplete = undefined;
		this.remove();
	}

	private async selectMessage(msg: { entryId: string; text: string }) {
		this.forking = true;
		try {
			const result = await this.agent.fork(msg.entryId);
			if (result.cancelled) {
				this.forking = false;
				return;
			}
			this.close({
				text: result.text,
				newSessionPath: result.newSessionPath,
			});
		} catch (err) {
			console.error("Fork failed:", err);
			this.forking = false;
		}
	}

	private onKeyDown(e: KeyboardEvent) {
		const filtered = this.filteredMessages;

		if (e.key === "Escape") {
			e.preventDefault();
			this.close();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			this.selectedIndex = Math.min(this.selectedIndex + 1, filtered.length - 1);
			this.scrollSelectedIntoView();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
			this.scrollSelectedIntoView();
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (filtered.length > 0 && this.selectedIndex < filtered.length) {
				this.selectMessage(filtered[this.selectedIndex]);
			}
		}
	}

	private scrollSelectedIntoView() {
		requestAnimationFrame(() => {
			const list = this.shadowRoot?.querySelector(".messages-list");
			const items = list?.querySelectorAll(".message-item");
			if (items && items[this.selectedIndex]) {
				items[this.selectedIndex].scrollIntoView({ block: "nearest" });
			}
		});
	}

	private onSearchInput(e: Event) {
		this.search = (e.target as HTMLInputElement).value;
		this.selectedIndex = 0;
	}

	protected firstUpdated() {
		// Focus search input
		requestAnimationFrame(() => {
			const input = this.shadowRoot?.querySelector(".search-input") as HTMLInputElement;
			input?.focus();
		});
	}

	render() {
		const filtered = this.filteredMessages;

		return html`
			<div class="backdrop" @click=${() => this.close()}></div>
			<div class="modal" @keydown=${(e: KeyboardEvent) => this.onKeyDown(e)}>
				${this.forking
					? html`<div class="forking-overlay"><span class="forking-text">Forking session…</span></div>`
					: nothing}

				<div class="header">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="18" r="3"></circle>
						<circle cx="6" cy="6" r="3"></circle>
						<circle cx="18" cy="6" r="3"></circle>
						<path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"></path>
						<path d="M12 12v3"></path>
					</svg>
					<span class="header-title">Fork from message</span>
					<span class="header-hint"><kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> fork · <kbd>Esc</kbd> cancel</span>
				</div>

				<div class="search-wrapper">
					<input
						class="search-input"
						type="text"
						placeholder="Search messages…"
						.value=${this.search}
						@input=${this.onSearchInput}
					/>
				</div>

				<div class="messages-list">
					${this.loading
						? html`<div class="loading">Loading messages…</div>`
						: filtered.length === 0
							? html`<div class="empty">${this.search ? "No matching messages" : "No user messages in this session"}</div>`
							: filtered.map(
									(msg, i) => html`
										<button
											class="message-item ${i === this.selectedIndex ? "selected" : ""}"
											@click=${() => this.selectMessage(msg)}
											@mouseenter=${() => { this.selectedIndex = i; }}
										>
											<span class="message-index">${this.messages.indexOf(msg) + 1}</span>
											<span class="message-text">${msg.text}</span>
										</button>
									`,
								)}
				</div>
			</div>
		`;
	}
}

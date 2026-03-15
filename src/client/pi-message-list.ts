/**
 * Flat message list renderer.
 *
 * Renders a single flat array of messages. No two-zone split, no streaming
 * container, no fixups. The server provides a flat messages array that includes
 * everything (committed messages, in-flight stream message, partial tool results).
 * This component just iterates and renders.
 *
 * When `initialCount` is set (> 0), only the last N renderable messages are shown
 * on initial load or session switch. A "Show earlier messages" button allows
 * loading more. During streaming, new messages are always shown.
 *
 * Uses upstream leaf components: assistant-message, user-message, tool-message,
 * markdown-block, thinking-block — but NOT AgentInterface, MessageList, or
 * StreamingMessageContainer.
 */

import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { renderMessage } from "@mariozechner/pi-web-ui";

@customElement("pi-message-list")
export class PiMessageList extends LitElement {
	@property({ type: Array }) messages: AgentMessage[] = [];
	@property({ type: Boolean }) isStreaming = false;
	@property({ type: Object }) pendingToolCalls: Set<string> = new Set();

	/**
	 * Maximum number of renderable messages to show initially.
	 * 0 = show all (no truncation). Set from user settings (default 50).
	 */
	@property({ type: Number }) initialCount = 0;

	/**
	 * Internal: how many renderable messages are currently visible.
	 * Starts at `initialCount` and grows when user clicks "show more".
	 * Reset on session switch (when messages array identity changes).
	 */
	private _visibleCount = 0;

	/** Track the previous messages array identity to detect session switches */
	private _prevMessagesRef: AgentMessage[] | null = null;

	createRenderRoot() {
		return this; // light DOM for shared styles
	}

	connectedCallback() {
		super.connectedCallback();
		this.style.display = "block";
	}

	/** Reset visible count when switching sessions (messages array changes entirely) */
	resetVisibleCount() {
		this._visibleCount = this.initialCount > 0 ? this.initialCount : 0;
		this._prevMessagesRef = null;
	}

	render() {
		// Detect session switch: if the messages array reference changed entirely
		// (not just grew), reset the visible count. We detect this by checking
		// if the first message changed or if the array shrank.
		if (this._prevMessagesRef !== null && this.messages !== this._prevMessagesRef) {
			const prev = this._prevMessagesRef;
			const isSameSession = this.messages.length >= prev.length
				&& prev.length > 0
				&& this.messages[0] === prev[0];
			if (!isSameSession) {
				this._visibleCount = this.initialCount > 0 ? this.initialCount : 0;
			}
		}
		this._prevMessagesRef = this.messages;

		// Build toolResultsById map for inline tool result rendering
		const toolResultsById = new Map<string, any>();
		for (const msg of this.messages) {
			if ((msg as any).role === "toolResult") {
				toolResultsById.set((msg as any).toolCallId, msg);
			}
		}

		const allItems = this.buildRenderItems(toolResultsById);

		// Apply truncation if initialCount is set and we have more items than visible
		const isTruncationEnabled = this.initialCount > 0;
		const effectiveVisible = this._visibleCount > 0 ? this._visibleCount : (isTruncationEnabled ? this.initialCount : allItems.length);
		const hiddenCount = isTruncationEnabled ? Math.max(0, allItems.length - effectiveVisible) : 0;
		const visibleItems = hiddenCount > 0 ? allItems.slice(hiddenCount) : allItems;

		return html`<div class="flex flex-col gap-3">
			${hiddenCount > 0
				? html`<button
					class="show-earlier-btn"
					@click=${this._showMore}
				>Show ${Math.min(hiddenCount, effectiveVisible)} earlier messages (${hiddenCount} hidden)</button>`
				: ""}
			${repeat(
				visibleItems,
				(it) => it.key,
				(it) => html`<div data-message-index=${String(it.messageIndex)} style="display: contents;">${it.template}</div>`,
			)}
			${this.isStreaming ? html`<span class="mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse"></span>` : ""}
		</div>`;
	}

	private _showMore() {
		const step = this.initialCount > 0 ? this.initialCount : 50;
		this._visibleCount = (this._visibleCount || this.initialCount || 50) + step;
		this.requestUpdate();
	}

	private buildRenderItems(toolResultsById: Map<string, any>): Array<{ key: string; template: TemplateResult; messageIndex: number }> {
		const items: Array<{ key: string; template: TemplateResult; messageIndex: number }> = [];
		let index = 0;

		for (const msg of this.messages) {
			// Skip artifact messages — they're for session persistence only
			if ((msg as any).role === "artifact") continue;
			// Skip standalone toolResult — rendered inline via assistant-message
			if ((msg as any).role === "toolResult") continue;

			// Try custom renderer first (registered via registerMessageRenderer)
			const customTemplate = renderMessage(msg);
			if (customTemplate) {
				items.push({ key: `msg:${index}`, template: customTemplate, messageIndex: index });
				index++;
				continue;
			}

			if (msg.role === "user" || (msg as any).role === "user-with-attachments") {
				items.push({
					key: `msg:${index}`,
					template: html`<user-message .message=${msg}></user-message>`,
					messageIndex: index,
				});
				index++;
			} else if (msg.role === "assistant") {
				// Determine if THIS specific message is the one currently streaming
				// (it would be the last assistant message when isStreaming is true)
				const isThisMessageStreaming = this.isStreaming && this.isLastAssistantMessage(msg);

				items.push({
					key: `msg:${index}`,
					template: html`<assistant-message
						.message=${msg}
						.tools=${[]}
						.isStreaming=${isThisMessageStreaming}
						.pendingToolCalls=${this.pendingToolCalls}
						.toolResultsById=${toolResultsById}
						.hideToolCalls=${false}
						.hidePendingToolCalls=${false}
					></assistant-message>`,
					messageIndex: index,
				});
				index++;
			}
		}

		return items;
	}

	/** Check if a message is the last assistant message in the array */
	private isLastAssistantMessage(msg: AgentMessage): boolean {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (this.messages[i].role === "assistant") {
				return this.messages[i] === msg;
			}
		}
		return false;
	}
}

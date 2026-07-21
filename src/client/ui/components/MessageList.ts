/**
 * Flat message list renderer.
 *
 * Renders a single flat array of messages. No two-zone split, no streaming
 * container, no fixups. The server provides a flat messages array that includes
 * everything (committed messages, in-flight stream message, partial tool results).
 * This component just iterates and renders.
 *
 * This is the only conversation renderer. It composes pipane-owned user,
 * assistant, thinking, and tool components without a second streaming zone.
 * Long conversations initially show their most recent renderable messages and
 * can be expanded in fixed-size batches.
 */

import { html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCallTimings } from "../../../shared/tool-runtime.js";
import { renderMessage } from "../message-registry.js";
import "./Messages.js";

function countThinkingParts(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	let count = 0;
	for (const part of message.content) {
		if (part.type === "thinking" && part.thinking.trim() !== "") count++;
	}
	return count;
}

@customElement("pi-message-list")
export class PiMessageList extends LitElement {
	@property({ type: Array }) messages: AgentMessage[] = [];
	@property({ type: Boolean }) isStreaming = false;
	@property({ type: Object }) pendingToolCalls: ReadonlySet<string> = new Set();
	@property({ type: Object }) toolCallTimings: Readonly<ToolCallTimings> = {};
	@property({ type: String }) sessionPath = "";
	/** 0 disables truncation. */
	@property({ type: Number }) initialCount = 0;
	@property({ type: Boolean }) hideOlderThinking = false;
	@property({ type: Number }) keepThinkingParts = 3;

	private visibleCount = 0;

	createRenderRoot() {
		return this; // light DOM for shared styles
	}

	connectedCallback() {
		super.connectedCallback();
		this.style.display = "block";
	}

	protected override willUpdate(changedProperties: PropertyValues<this>): void {
		if (changedProperties.has("sessionPath") || changedProperties.has("initialCount")) {
			this.visibleCount = this.initialCount;
		}
	}

	render() {
		// Build toolResultsById map for inline tool result rendering
		const toolResultsById = new Map<string, any>();
		for (const msg of this.messages) {
			if ((msg as any).role === "toolResult") {
				toolResultsById.set((msg as any).toolCallId, msg);
			}
		}

		const items = this.buildRenderItems(toolResultsById);
		const visibleLimit = this.initialCount > 0 ? this.visibleCount || this.initialCount : items.length;
		const hiddenCount = this.initialCount > 0 ? Math.max(0, items.length - visibleLimit) : 0;
		const visibleItems = hiddenCount > 0 ? items.slice(hiddenCount) : items;
		const nextBatchSize = Math.min(hiddenCount, this.initialCount);

		return html`<div class="flex flex-col gap-3">
			${hiddenCount > 0
				? html`<button
					type="button"
					class="show-earlier-btn"
					@click=${this.showEarlierMessages}
				>Show ${nextBatchSize} earlier messages (${hiddenCount} hidden)</button>`
				: ""}
			${repeat(
				visibleItems,
				(it) => it.key,
				(it) => html`<div data-message-index=${String(it.messageIndex)} style="display: contents;">${it.template}</div>`,
			)}
			${this.isStreaming ? html`<span class="mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse"></span>` : ""}
		</div>`;
	}

	private showEarlierMessages(): void {
		this.visibleCount = (this.visibleCount || this.initialCount) + this.initialCount;
		this.requestUpdate();
	}

	private buildRenderItems(toolResultsById: Map<string, any>): Array<{ key: string; template: TemplateResult; messageIndex: number }> {
		const items: Array<{ key: string; template: TemplateResult; messageIndex: number }> = [];
		let index = 0;
		const keepThinkingParts = Number.isFinite(this.keepThinkingParts)
			? Math.max(0, Math.floor(this.keepThinkingParts))
			: 0;
		let thinkingPartsToHide = this.hideOlderThinking
			? Math.max(0, this.messages.reduce((total, message) => total + countThinkingParts(message), 0) - keepThinkingParts)
			: 0;

		for (const msg of this.messages) {
			// Skip standalone toolResult — rendered inline via assistant-message
			if ((msg as any).role === "toolResult") continue;

			// Try custom renderer first (registered via registerMessageRenderer)
			const customTemplate = renderMessage(msg);
			if (customTemplate) {
				items.push({ key: `msg:${index}`, template: customTemplate, messageIndex: index });
				index++;
				continue;
			}

			if (msg.role === "user") {
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
				const hiddenThinkingParts = Math.min(thinkingPartsToHide, countThinkingParts(msg));
				thinkingPartsToHide -= hiddenThinkingParts;

				items.push({
					key: `msg:${index}`,
					template: html`<assistant-message
						.message=${msg}
						.isStreaming=${isThisMessageStreaming}
						.pendingToolCalls=${this.pendingToolCalls}
						.toolCallTimings=${this.toolCallTimings}
						.toolResultsById=${toolResultsById}
						.hiddenThinkingParts=${hiddenThinkingParts}
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

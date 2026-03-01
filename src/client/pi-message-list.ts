/**
 * Flat message list renderer.
 *
 * Renders a single flat array of messages. No two-zone split, no streaming
 * container, no fixups. The server provides a flat messages array that includes
 * everything (committed messages, in-flight stream message, partial tool results).
 * This component just iterates and renders.
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

	createRenderRoot() {
		return this; // light DOM for shared styles
	}

	connectedCallback() {
		super.connectedCallback();
		this.style.display = "block";
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

		return html`<div class="flex flex-col gap-3">
			${repeat(
				items,
				(it) => it.key,
				(it) => html`<div data-message-index=${String(it.messageIndex)} style="display: contents;">${it.template}</div>`,
			)}
			${this.isStreaming ? html`<span class="mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse"></span>` : ""}
		</div>`;
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

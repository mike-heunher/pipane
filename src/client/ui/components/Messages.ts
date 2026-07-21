import type {
	AssistantMessage as AssistantMessageType,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage as ToolResultMessageType,
	UserMessage as UserMessageType,
} from "@earendil-works/pi-ai";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ToolCallTiming, ToolCallTimings } from "../../../shared/tool-runtime.js";
import { linkifyPreviewableInlineCode } from "../../file-preview-panel.js";
import { renderTool } from "../tool-registry.js";
import { formatUsage } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { escapeStrikethrough } from "../utils/markdown.js";
import "./ThinkingBlock.js";

function openImageFullscreen(image: HTMLImageElement): void {
	const overlay = document.createElement("div");
	overlay.className = "image-preview-overlay";
	overlay.style.cssText =
		"position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out;";

	const fullImage = document.createElement("img");
	fullImage.src = image.src;
	fullImage.alt = image.alt;
	fullImage.style.cssText = "max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px;";
	overlay.appendChild(fullImage);

	const close = () => {
		document.removeEventListener("keydown", onKeyDown);
		overlay.remove();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") close();
	};
	overlay.addEventListener("click", close);
	document.addEventListener("keydown", onKeyDown);
	document.body.appendChild(overlay);
}

@customElement("user-message")
export class UserMessage extends LitElement {
	@property({ type: Object }) message!: UserMessageType;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		const blocks = typeof this.message.content === "string" ? [] : this.message.content;
		const content =
			typeof this.message.content === "string"
				? this.message.content
				: (blocks.find((block) => block.type === "text") as TextContent | undefined)?.text || "";
		const inlineImages = blocks.filter((block): block is ImageContent => block.type === "image");

		return html`
			<div class="flex justify-start mx-4">
				<div class="user-message-container py-2 px-4 rounded-xl">
					<markdown-block .content=${linkifyPreviewableInlineCode(escapeStrikethrough(content))}></markdown-block>
					${inlineImages.length > 0
						? html`<div class="mt-3 flex flex-wrap gap-2">
							${inlineImages.map((image) => html`<img
								src="data:${image.mimeType};base64,${image.data}"
								alt="Attached image"
								class="max-w-xs max-h-64 rounded-md border border-border object-contain cursor-pointer"
								@click=${(event: Event) => openImageFullscreen(event.currentTarget as HTMLImageElement)}
							/>`)}
						</div>`
						: ""}
				</div>
			</div>
		`;
	}
}

const TOOL_RUNTIME_TICK_MS = 100;

export function formatToolRuntime(milliseconds: number): string {
	const totalTenths = Math.floor(Math.max(0, milliseconds) / 100);
	const hours = Math.floor(totalTenths / 36_000);
	const minutes = Math.floor((totalTenths % 36_000) / 600);
	const seconds = (totalTenths % 600) / 10;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${seconds.toFixed(1).padStart(4, "0")}s`;
	if (minutes > 0) return `${minutes}m ${seconds.toFixed(1).padStart(4, "0")}s`;
	return `${seconds.toFixed(1)}s`;
}

@customElement("tool-runtime")
export class ToolRuntime extends LitElement {
	@property({ type: Number }) startedAt = 0;
	@property({ type: Number }) completedAt?: number;
	@property({ type: Boolean, reflect: true }) running = false;
	@state() private now = Date.now();
	private tickTimer?: number;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.syncTimer();
	}

	protected override updated(changedProperties: PropertyValues<this>): void {
		if (changedProperties.has("running") || changedProperties.has("startedAt")) this.syncTimer();
	}

	override disconnectedCallback(): void {
		this.clearTimer();
		super.disconnectedCallback();
	}

	private syncTimer(): void {
		this.clearTimer();
		if (this.running) {
			this.tickTimer = window.setInterval(() => {
				this.now = Date.now();
			}, TOOL_RUNTIME_TICK_MS);
		}
	}

	private clearTimer(): void {
		if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
		this.tickTimer = undefined;
	}

	override render() {
		if (!Number.isFinite(this.startedAt) || this.startedAt <= 0) return "";
		const completedAt = Number.isFinite(this.completedAt) ? this.completedAt as number : this.now;
		const elapsedMs = Math.max(0, (this.running ? this.now : completedAt) - this.startedAt);
		const value = formatToolRuntime(elapsedMs);
		const label = this.running ? `Running for ${value}` : `Completed in ${value}`;
		return html`<span class="tool-runtime-value" aria-label=${label} title=${label}>
			<span class="tool-runtime-clock" aria-hidden="true"></span>${value}
		</span>`;
	}
}

@customElement("assistant-message")
export class AssistantMessage extends LitElement {
	@property({ type: Object }) message!: AssistantMessageType;
	@property({ type: Object }) pendingToolCalls?: ReadonlySet<string>;
	@property({ type: Object }) toolCallTimings: Readonly<ToolCallTimings> = {};
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessageType>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	@property({ type: Number }) hiddenThinkingParts = 0;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		// Render content in the order it appears
		const orderedParts: TemplateResult[] = [];
		let thinkingPartsSeen = 0;

		for (const chunk of this.message.content) {
			if (chunk.type === "text" && chunk.text.trim() !== "") {
				orderedParts.push(html`<markdown-block .content=${linkifyPreviewableInlineCode(escapeStrikethrough(chunk.text))}></markdown-block>`);
			} else if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
				if (thinkingPartsSeen >= this.hiddenThinkingParts) {
					orderedParts.push(
						html`<thinking-block .content=${chunk.thinking} .isStreaming=${this.isStreaming}></thinking-block>`,
					);
				}
				thinkingPartsSeen++;
			} else if (chunk.type === "toolCall") {
				const pending = this.pendingToolCalls?.has(chunk.id) ?? false;
				const result = this.toolResultsById?.get(chunk.id);
				const aborted = this.message.stopReason === "aborted" && !result;
				orderedParts.push(
					html`<tool-message
						data-tool-call-id=${chunk.id}
						.toolCall=${chunk}
						.result=${result}
						.timing=${this.toolCallTimings[chunk.id]}
						.messageTimestamp=${this.message.timestamp}
						.pending=${pending}
						.aborted=${aborted}
						.isStreaming=${this.isStreaming}
					></tool-message>`,
				);
			}
		}

		return html`
			<div>
				${orderedParts.length ? html` <div class="px-4 flex flex-col gap-3">${orderedParts}</div> ` : ""}
				${this.message.usage && !this.isStreaming
					? html` <div class="message-token-usage px-4 mt-2 text-xs text-muted-foreground">${formatUsage(this.message.usage)}</div> `
					: ""}
				${
					this.message.stopReason === "error" && this.message.errorMessage
						? html`
							<div class="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden">
								<strong>${i18n("Error:")}</strong> ${this.message.errorMessage}
							</div>
						`
						: ""
				}
				${
					this.message.stopReason === "aborted"
						? html`<span class="text-sm text-destructive italic">${i18n("Request aborted")}</span>`
						: ""
				}
			</div>
		`;
	}
}

@customElement("tool-message")
export class ToolMessage extends LitElement {
	@property({ type: Object }) toolCall!: ToolCall;
	@property({ type: Object }) result?: ToolResultMessageType;
	@property({ type: Object }) timing?: ToolCallTiming;
	@property({ type: Number }) messageTimestamp?: number;
	@property({ type: Boolean }) pending: boolean = false;
	@property({ type: Boolean }) aborted: boolean = false;
	@property({ type: Boolean }) isStreaming: boolean = false;
	private localStartedAt?: number;
	private localCompletedAt?: number;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		const toolName = this.toolCall.name;
		const serverStartedAt = this.timing?.startedAt;
		if (this.pending && this.localStartedAt === undefined) this.localStartedAt = Date.now();
		if (!this.pending && this.localStartedAt !== undefined && this.localCompletedAt === undefined) {
			this.localCompletedAt = Date.now();
		}

		const completedMessageAt = typeof this.result?.timestamp === "number"
			&& Number.isFinite(this.result.timestamp)
			? this.result.timestamp
			: undefined;
		const historicalStartedAt = typeof this.messageTimestamp === "number"
			&& Number.isFinite(this.messageTimestamp)
			? this.messageTimestamp
			: undefined;
		const startedAt = typeof serverStartedAt === "number" && Number.isFinite(serverStartedAt)
			? serverStartedAt
			: this.localStartedAt ?? historicalStartedAt ?? Date.now();
		const completedAt = typeof this.timing?.completedAt === "number" && Number.isFinite(this.timing.completedAt)
			? this.timing.completedAt
			: completedMessageAt ?? this.localCompletedAt;
		const runtime = html`<tool-runtime
			.startedAt=${startedAt}
			.completedAt=${completedAt}
			.running=${this.pending}
		></tool-runtime>`;

		// Render tool content (renderer handles errors and styling)
		const result: ToolResultMessageType<any> | undefined = this.aborted
			? {
					role: "toolResult",
					isError: true,
					content: [],
					toolCallId: this.toolCall.id,
					toolName: this.toolCall.name,
					timestamp: Date.now(),
				}
			: this.result;
		const renderResult = renderTool(
			toolName,
			this.toolCall.arguments,
			result,
			!this.aborted && (this.isStreaming || this.pending),
			runtime,
		);

		// Handle custom rendering (no card wrapper)
		if (renderResult.isCustom) {
			return renderResult.content;
		}

		// Default: wrap in card
		return html`
			<div class="tool-runtime-card p-2.5 pr-20 border border-border rounded-md bg-card text-card-foreground shadow-xs">
				${runtime}${renderResult.content}
			</div>
		`;
	}
}

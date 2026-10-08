import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import "./MarkdownBlock.js";
import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronRight } from "lucide";
import { linkifyPreviewableInlineCode } from "../../file-preview-panel.js";
import { escapeStrikethrough } from "../utils/markdown.js";

const THINKING_ELAPSED_TICK_MS = 1000;
/** Enough trailing text to fill the collapsed live preview without rendering the whole part. */
const THINKING_PREVIEW_CHARS = 600;

export function formatThinkingElapsed(milliseconds: number): string {
	const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * One thinking part. Only the part currently being produced is `isStreaming`;
 * while streaming it ticks an elapsed timer and, when collapsed, shows the tail
 * of the reasoning so progress stays visible even before any summary text arrives.
 */
@customElement("thinking-block")
export class ThinkingBlock extends LitElement {
	@property() content = "";
	@property({ type: Boolean }) isStreaming = false;
	@state() private isExpanded = false;
	@state() private now = Date.now();
	private startedAt?: number;
	private tickTimer?: number;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.syncTimer();
	}

	override disconnectedCallback(): void {
		this.clearTimer();
		super.disconnectedCallback();
	}

	protected override willUpdate(changedProperties: PropertyValues<this>): void {
		if (changedProperties.has("isStreaming") && this.isStreaming && this.startedAt === undefined) {
			this.startedAt = Date.now();
			this.now = this.startedAt;
		}
	}

	protected override updated(changedProperties: PropertyValues<this>): void {
		if (changedProperties.has("isStreaming")) this.syncTimer();
	}

	private syncTimer(): void {
		this.clearTimer();
		if (!this.isStreaming || !this.isConnected) return;
		this.tickTimer = window.setInterval(() => {
			this.now = Date.now();
		}, THINKING_ELAPSED_TICK_MS);
	}

	private clearTimer(): void {
		if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
		this.tickTimer = undefined;
	}

	override render() {
		const estimatedTokens = this.content ? Math.ceil(this.content.length / 4) : 0;
		const formattedTokens = estimatedTokens.toLocaleString();
		let label: string;
		if (this.isStreaming) {
			const details = [
				estimatedTokens > 0 ? `${formattedTokens} tokens` : "",
				formatThinkingElapsed(this.now - (this.startedAt ?? this.now)),
			].filter(Boolean).join(" · ");
			label = `Thinking… (${details})`;
		} else {
			label = estimatedTokens > 0 ? `Thinking (${formattedTokens} tokens)` : "Thinking";
		}
		const shimmerClasses = this.isStreaming
			? "animate-shimmer bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-transparent"
			: "";
		const preview = this.isStreaming && !this.isExpanded ? this.content.trimEnd().slice(-THINKING_PREVIEW_CHARS) : "";

		return html`
			<div class="thinking-block">
				<div
					class="thinking-header cursor-pointer select-none flex items-center gap-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
					@click=${() => { this.isExpanded = !this.isExpanded; }}
				>
					<span class="transition-transform inline-block ${this.isExpanded ? "rotate-90" : ""}">${icon(ChevronRight, "sm")}</span>
					<span class="${shimmerClasses}">${label}</span>
				</div>
				${preview
					? html`<div class="thinking-live-preview" aria-live="off"><div>${preview}</div></div>`
					: ""}
				${this.isExpanded
					? html`<markdown-block .content=${linkifyPreviewableInlineCode(escapeStrikethrough(this.content))} .isThinking=${true}></markdown-block>`
					: ""}
			</div>
		`;
	}
}

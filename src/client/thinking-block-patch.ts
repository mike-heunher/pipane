/**
 * Patch ThinkingBlock to show approximate thinking token count while streaming.
 *
 * We override the render() method on the custom element's prototype so that
 * "Thinking..." becomes "Thinking… (1,234 tokens)" based on the content length.
 * Rough heuristic: 1 token ≈ 4 characters.
 */
import { html } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { ChevronRight } from "lucide";

// The ThinkingBlock custom element is already registered by the time this runs.
// We grab its class from the custom element registry and patch the prototype.
const ThinkingBlockClass = customElements.get("thinking-block") as any;

if (ThinkingBlockClass) {
	ThinkingBlockClass.prototype.render = function (this: any) {
		const content = this.content as string;
		const isStreaming = this.isStreaming as boolean;
		const isExpanded = this.isExpanded as boolean;

		// Estimate tokens: ~4 chars per token
		const estimatedTokens = content ? Math.ceil(content.length / 4) : 0;
		const formattedTokens = estimatedTokens.toLocaleString();

		const shimmerClasses = isStreaming
			? "animate-shimmer bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-transparent"
			: "";

		const label = isStreaming
			? `Thinking… (${formattedTokens} tokens)`
			: estimatedTokens > 0
				? `Thinking (${formattedTokens} tokens)`
				: `Thinking`;

		return html`
			<div class="thinking-block">
				<div
					class="thinking-header cursor-pointer select-none flex items-center gap-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
					@click=${() => { this.isExpanded = !isExpanded; }}
				>
					<span class="transition-transform inline-block ${isExpanded ? "rotate-90" : ""}">${icon(ChevronRight, "sm")}</span>
					<span class="${shimmerClasses}">${label}</span>
				</div>
				${isExpanded ? html`<markdown-block .content=${content} .isThinking=${true}></markdown-block>` : ""}
			</div>
		`;
	};
}

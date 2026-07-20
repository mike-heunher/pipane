import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { html } from "lit";
import { Check, ChevronRight, Loader, Shrink } from "lucide";
import { registerMessageRenderer } from "./message-registry.js";

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

registerMessageRenderer("compactionSummary" as any, {
	render(message: any) {
		const summary = String(message.summary || "");
		const tokensBefore = Number(message.tokensBefore || 0);
		const isCompacting = Boolean(message._compacting);
		const tokenLabel = tokensBefore > 0
			? `${formatTokenCount(tokensBefore)} tokens summarized`
			: "Context summarized";
		const exactTokenLabel = tokensBefore > 0
			? `${tokensBefore.toLocaleString()} tokens summarized`
			: "Context summarized";

		if (isCompacting) {
			return html`
				<div class="compaction-event is-running" role="status" aria-live="polite">
					<div class="compaction-header">
						<span class="compaction-icon is-spinning">${icon(Loader, "sm")}</span>
						<span class="compaction-copy">
							<span class="compaction-title">Compacting conversation</span>
							<span class="compaction-meta">Summarizing context… This may take a few minutes.</span>
						</span>
					</div>
				</div>
			`;
		}

		if (!summary) {
			return html`
				<div class="compaction-event is-complete">
					<div class="compaction-header" title=${exactTokenLabel}>
						<span class="compaction-icon">${icon(Check, "sm")}</span>
						<span class="compaction-copy">
							<span class="compaction-title">Conversation compacted</span>
							<span class="compaction-meta">${tokenLabel}</span>
						</span>
					</div>
				</div>
			`;
		}

		return html`
			<div class="compaction-event is-complete">
				<details class="compaction-details">
					<summary
						class="compaction-header"
						title=${exactTokenLabel}
						aria-label=${`Conversation compacted. ${exactTokenLabel}. View compaction summary.`}
					>
						<span class="compaction-icon">${icon(Shrink, "sm")}</span>
						<span class="compaction-copy">
							<span class="compaction-title">Conversation compacted</span>
							<span class="compaction-meta">${tokenLabel}</span>
						</span>
						<span class="compaction-action">
							<span class="compaction-action-collapsed">View summary</span>
							<span class="compaction-action-expanded">Hide summary</span>
							<span class="compaction-chevron">${icon(ChevronRight, "xs")}</span>
						</span>
					</summary>
					<div class="compaction-summary-body">
						<div class="compaction-summary-label">Compaction summary</div>
						<markdown-block .content=${summary}></markdown-block>
					</div>
				</details>
			</div>
		`;
	},
});

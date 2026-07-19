import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { html } from "lit";
import { ChevronRight, Loader, Shrink } from "lucide";
import { registerMessageRenderer } from "./message-registry.js";

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

function handleCompactionToggle(event: Event): void {
	const header = event.currentTarget as HTMLElement;
	const wrapper = header.closest(".tool-gutter-wrap");
	if (!wrapper) return;
	const body = wrapper.querySelector(".tool-body-collapsible") as HTMLElement | null;
	const threadLine = wrapper.querySelector(".tool-thread-line") as HTMLElement | null;
	const chevron = header.querySelector(".tool-chevron") as HTMLElement | null;
	if (!body) return;

	const isHidden = body.style.display === "none";
	body.style.display = isHidden ? "" : "none";
	if (threadLine) threadLine.style.display = isHidden ? "" : "none";
	if (chevron) chevron.style.transform = isHidden ? "rotate(90deg)" : "";
}

registerMessageRenderer("compactionSummary" as any, {
	render(message: any) {
		const summary = String(message.summary || "");
		const tokensBefore = Number(message.tokensBefore || 0);
		const isCompacting = Boolean(message._compacting);
		const headerLabel = isCompacting
			? "compacting…"
			: tokensBefore > 0
				? `compacted — ${formatTokenCount(tokensBefore)} tokens summarized`
				: "compacted";
		const iconColor = isCompacting ? "text-foreground" : "text-green-600 dark:text-green-500";
		const threadColor = isCompacting ? "bg-border" : "bg-green-300 dark:bg-green-700";
		const spinner = isCompacting
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		return html`
			<div class="tool-gutter-wrap flex my-0 px-4">
				<div class="tool-gutter flex flex-col items-center w-5 shrink-0 pt-0.5">
					<span class="inline-block ${iconColor}">${icon(Shrink, "sm")}</span>
					${summary
						? html`<div class="tool-thread-line w-0.5 flex-1 mt-0.5 rounded-full ${threadColor}" style="display: none"></div>`
						: ""}
				</div>
				<div class="flex-1 min-w-0">
					<div class="tool-hdr flex items-center gap-1 cursor-pointer py-px hover:text-foreground" @click=${handleCompactionToggle}>
						<span class="tool-chevron inline-block transition-transform text-muted-foreground">${icon(ChevronRight, "xs")}</span>
						<span class="tool-header-label text-muted-foreground font-mono">${headerLabel}</span>
						${spinner}
					</div>
					${summary
						? html`<div class="tool-body-collapsible" style="display: none">
							<div class="overflow-auto tool-body-scroll bg-muted rounded-md mt-0.5 px-2 py-1.5" style="max-height: 400px">
								<markdown-block .content=${summary}></markdown-block>
							</div>
						</div>`
						: ""}
				</div>
			</div>
		`;
	},
});

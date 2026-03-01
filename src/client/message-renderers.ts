/**
 * Custom message renderers for pi-coding-agent message types.
 *
 * Registers renderers for:
 * - user: Inline images support
 * - compactionSummary: Conversation compaction visualization
 */

import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import type { UserMessage as UserMessageType, ImageContent } from "@mariozechner/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Shrink, ChevronRight, Loader } from "lucide";

function openImageFullscreen(img: HTMLImageElement) {
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out;";
	const fullImg = document.createElement("img");
	fullImg.src = img.src;
	fullImg.style.cssText = "max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px;";
	overlay.appendChild(fullImg);
	overlay.addEventListener("click", () => overlay.remove());
	document.addEventListener("keydown", function handler(e: KeyboardEvent) {
		if (e.key === "Escape") {
			overlay.remove();
			document.removeEventListener("keydown", handler);
		}
	});
	document.body.appendChild(overlay);
}

registerMessageRenderer("user", {
	render(message: UserMessageType) {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content.find((c) => c.type === "text")?.text || "";

		const inlineImages: ImageContent[] =
			typeof message.content === "string"
				? []
				: (message.content.filter((c) => c.type === "image") as ImageContent[]);

		return html`
			<div class="flex justify-start mx-4">
				<div class="user-message-container py-2 px-4 rounded-xl">
					<markdown-block .content=${content}></markdown-block>
					${inlineImages.length > 0
						? html`
							<div class="mt-3 flex flex-wrap gap-2">
								${inlineImages.map(
									(img) => html`<img
										src="data:${img.mimeType};base64,${img.data}"
										alt="Attached image"
										class="max-w-xs max-h-64 rounded-md border border-border object-contain cursor-pointer"
										@click=${(e: Event) => openImageFullscreen(e.target as HTMLImageElement)}
									/>`,
								)}
							</div>
						`
						: ""}
				</div>
			</div>
		`;
	},
});

// ── Compaction summary ─────────────────────────────────────────────────────

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

/** Reuses the same toggle logic as tool renderers (same CSS classes). */
function handleCompactionToggle(e: Event) {
	const hdr = e.currentTarget as HTMLElement;
	const wrapper = hdr.closest(".tool-gutter-wrap");
	if (!wrapper) return;
	const body = wrapper.querySelector(".tool-body-collapsible") as HTMLElement;
	const threadLine = wrapper.querySelector(".tool-thread-line") as HTMLElement;
	const chv = hdr.querySelector(".tool-chevron") as HTMLElement;
	if (!body) return;
	const isHidden = body.style.display === "none";
	body.style.display = isHidden ? "" : "none";
	if (threadLine) threadLine.style.display = isHidden ? "" : "none";
	if (chv) {
		chv.style.transform = isHidden ? "rotate(90deg)" : "";
	}
}

registerMessageRenderer("compactionSummary" as any, {
	render(message: any) {
		const summary: string = message.summary || "";
		const tokensBefore: number = message.tokensBefore || 0;
		const isCompacting: boolean = !!(message as any)._compacting;

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
		const hasBody = !!summary;

		return html`
			<div class="tool-gutter-wrap flex my-0 px-4">
				<div class="tool-gutter flex flex-col items-center w-5 shrink-0 pt-0.5">
					<span class="inline-block ${iconColor}">${icon(Shrink, "sm")}</span>
					${hasBody ? html`<div class="tool-thread-line w-0.5 flex-1 mt-0.5 rounded-full ${threadColor}" style="display: none"></div>` : ""}
				</div>
				<div class="flex-1 min-w-0">
					<div class="tool-hdr flex items-center gap-1 cursor-pointer py-px hover:text-foreground" @click=${handleCompactionToggle}>
						<span class="tool-chevron inline-block transition-transform text-muted-foreground">${icon(ChevronRight, "xs")}</span>
						<span class="tool-header-label text-muted-foreground font-mono">${headerLabel}</span>
						${spinner}
					</div>
					${hasBody ? html`<div class="tool-body-collapsible" style="display: none">
						<div class="overflow-auto tool-body-scroll bg-muted rounded-md mt-0.5 px-2 py-1.5" style="max-height: 400px">
							<markdown-block .content=${summary}></markdown-block>
						</div>
					</div>` : ""}
				</div>
			</div>
		`;
	},
});

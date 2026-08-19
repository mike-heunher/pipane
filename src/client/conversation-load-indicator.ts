import { html, nothing, type TemplateResult } from "lit";
import type { ConversationLoadProgress } from "./backend-client.js";

export function conversationLoadPercent(progress: ConversationLoadProgress): number | undefined {
	if (progress.phase !== "receiving" || !progress.totalChunks) return undefined;
	return Math.max(0, Math.min(100, Math.round(progress.receivedChunks / progress.totalChunks * 100)));
}

export function renderConversationLoadIndicator(
	progress: ConversationLoadProgress | undefined,
): TemplateResult | typeof nothing {
	if (!progress) return nothing;
	const percent = conversationLoadPercent(progress);
	const label = progress.phase === "receiving"
		? "Streaming conversation from backend"
		: progress.phase === "processing"
			? "Preparing streamed conversation"
			: "Waiting for conversation from backend";

	return html`
		<div class="conversation-load-indicator" role="status" aria-live="polite">
			<div class="conversation-load-copy">
				<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 3v12"></path>
					<path d="m7 10 5 5 5-5"></path>
					<path d="M5 21h14"></path>
				</svg>
				<span>${label}…</span>
				${percent === undefined ? nothing : html`<span class="conversation-load-percent">${percent}%</span>`}
			</div>
			<div
				class="conversation-load-track ${percent === undefined ? "is-indeterminate" : ""}"
				role="progressbar"
				aria-label=${label}
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow=${percent === undefined ? nothing : String(percent)}
			>
				<div class="conversation-load-bar" style=${percent === undefined ? "" : `width: ${percent}%`}></div>
			</div>
		</div>
	`;
}

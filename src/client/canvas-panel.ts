/**
 * Canvas side panel for displaying content from the `canvas` tool.
 *
 * The LLM calls the `canvas` tool with markdown content and a title.
 * The tool result is intercepted on the client and rendered in this side panel.
 * Only one canvas is active at a time (last call wins).
 * The user can close the panel with the ✕ button.
 */

import { html, render } from "lit";

let canvasTitle = "Canvas";
let canvasContent = "";
let visible = false;
let container: HTMLElement | null = null;
let onChangeCallback: (() => void) | null = null;

/**
 * Show markdown content in the canvas side panel.
 */
export function showCanvas(title: string, markdown: string) {
	canvasTitle = title || "Canvas";
	canvasContent = markdown;
	visible = true;
	renderPanel();
	onChangeCallback?.();
}

/**
 * Close the canvas panel.
 */
export function closeCanvas() {
	visible = false;
	renderPanel();
	onChangeCallback?.();
}

/**
 * Whether the canvas panel is currently visible.
 */
export function isCanvasVisible(): boolean {
	return visible;
}

/**
 * Bind the canvas panel to a DOM container and set the re-render callback.
 */
export function initCanvas(el: HTMLElement, onChange: () => void) {
	container = el;
	onChangeCallback = onChange;
	renderPanel();
}

/**
 * Extract canvas data from a tool result message (toolName === "canvas").
 * Returns { title, markdown } or null if not a canvas result.
 */
export function extractCanvasFromToolResult(msg: any): { title: string; markdown: string } | null {
	if (msg.role !== "toolResult" || msg.toolName !== "canvas") return null;
	const markdown = msg.details?.markdown;
	if (!markdown) return null;
	return { title: msg.details?.title || "Canvas", markdown };
}

/**
 * Scan messages for the last canvas tool result and show it.
 * Used on session load to restore canvas state.
 */
export function restoreCanvasFromMessages(messages: any[]) {
	let last: { title: string; markdown: string } | null = null;
	for (const msg of messages) {
		const data = extractCanvasFromToolResult(msg);
		if (data) last = data;
	}
	if (last) {
		showCanvas(last.title, last.markdown);
	} else {
		if (visible) closeCanvas();
	}
}

function renderPanel() {
	if (!container) return;

	if (!visible) {
		render(html``, container);
		return;
	}

	const tmpl = html`
		<div class="canvas-panel">
			<div class="canvas-header">
				<span class="canvas-title">${canvasTitle}</span>
				<button
					class="canvas-close"
					@click=${() => closeCanvas()}
					title="Close canvas"
				>✕</button>
			</div>
			<div class="canvas-body">
				<markdown-block .content=${canvasContent}></markdown-block>
			</div>
		</div>
	`;

	render(tmpl, container);
}

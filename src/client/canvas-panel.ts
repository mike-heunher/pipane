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
 * Tracks canvas tool calls that have already been auto-opened.
 * Keys are `${jsonlBasename}:${messageIndex}`.
 * Prevents re-opening the canvas panel on every re-render / content refresh.
 */
const openedCanvasKeys = new Set<string>();

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
function closeCanvas() {
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
function extractCanvasFromToolResult(msg: any): { title: string; markdown: string } | null {
	if (msg.role !== "toolResult" || msg.toolName !== "canvas") return null;
	const markdown = msg.details?.markdown;
	if (!markdown) return null;
	return { title: msg.details?.title || "Canvas", markdown };
}

/**
 * Build a canvas tracking key from a session file path and message index.
 */
export function canvasKey(sessionFile: string, messageIndex: number): string {
	const basename = sessionFile.split("/").pop() || sessionFile;
	return `${basename}:${messageIndex}`;
}

/**
 * Mark a canvas tool call as already auto-opened so it won't reopen on re-render.
 */
export function markCanvasOpened(key: string) {
	openedCanvasKeys.add(key);
}

/**
 * Check whether a canvas tool call has already been auto-opened.
 */
function hasCanvasBeenOpened(key: string): boolean {
	return openedCanvasKeys.has(key);
}

/**
 * Reset opened-canvas tracking (call on session switch).
 */
export function resetCanvasTracking() {
	openedCanvasKeys.clear();
}

/**
 * Scan messages for the last canvas tool result and show it — but only if it
 * hasn't been auto-opened before (keyed by JSONL filename + message index).
 * Used on session load to restore canvas state.
 */
export function restoreCanvasFromMessages(messages: any[], sessionFile?: string) {
	let lastIndex = -1;
	let last: { title: string; markdown: string } | null = null;
	for (let i = 0; i < messages.length; i++) {
		const data = extractCanvasFromToolResult(messages[i]);
		if (data) {
			last = data;
			lastIndex = i;
		}
	}
	if (last && lastIndex >= 0) {
		if (sessionFile) {
			const key = canvasKey(sessionFile, lastIndex);
			if (hasCanvasBeenOpened(key)) return; // already shown once, don't reopen
			markCanvasOpened(key);
		}
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

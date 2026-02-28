/**
 * JSONL raw viewer side panel.
 *
 * Shows the raw JSONL lines from the current session file, each line
 * pretty-printed with syntax highlighting and collapsible. Auto-scrolls
 * to the bottom unless the user has scrolled up.
 */

import { html, render } from "lit";

let visible = false;
let container: HTMLElement | null = null;
let onChangeCallback: (() => void) | null = null;
let currentSessionPath: string | undefined;
let jsonlLines: string[] = [];
let collapsedLines = new Set<number>();
let scrollContainer: HTMLElement | null = null;
let userScrolledUp = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function isJsonlPanelVisible(): boolean {
	return visible;
}

export function toggleJsonlPanel() {
	visible = !visible;
	if (visible) {
		fetchAndRender();
		startPolling();
	} else {
		stopPolling();
	}
	onChangeCallback?.();
}

export function closeJsonlPanel() {
	visible = false;
	stopPolling();
	renderPanel();
	onChangeCallback?.();
}

export function initJsonlPanel(el: HTMLElement, onChange: () => void) {
	container = el;
	onChangeCallback = onChange;
	renderPanel();
}

export function setJsonlSessionPath(sessionPath: string | undefined) {
	if (sessionPath === currentSessionPath) return;
	currentSessionPath = sessionPath;
	jsonlLines = [];
	collapsedLines.clear();
	userScrolledUp = false;
	if (visible) {
		fetchAndRender();
	}
}

/** Notify the panel that the session content may have changed */
export function refreshJsonlPanel() {
	if (visible && currentSessionPath) {
		fetchAndRender();
	}
}

function startPolling() {
	stopPolling();
	pollTimer = setInterval(() => {
		if (visible && currentSessionPath) {
			fetchAndRender();
		}
	}, 1500);
}

function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

async function fetchAndRender() {
	if (!currentSessionPath) {
		jsonlLines = [];
		renderPanel();
		return;
	}

	try {
		const res = await fetch(`/api/sessions/raw?path=${encodeURIComponent(currentSessionPath)}`);
		if (!res.ok) {
			jsonlLines = [];
			renderPanel();
			return;
		}
		const text = await res.text();
		const newLines = text.split("\n").filter((l) => l.trim());
		// Only re-render if content actually changed
		if (newLines.length !== jsonlLines.length || newLines.some((l, i) => l !== jsonlLines[i])) {
			jsonlLines = newLines;
			renderPanel();
		}
	} catch {
		// Silently ignore fetch errors
	}
}

function toggleLine(index: number) {
	if (collapsedLines.has(index)) {
		collapsedLines.delete(index);
	} else {
		collapsedLines.add(index);
	}
	renderPanel();
}

function handleScroll(e: Event) {
	const el = e.target as HTMLElement;
	if (!el) return;
	const threshold = 60;
	const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
	userScrolledUp = !atBottom;
}

function scrollToBottom() {
	if (scrollContainer && !userScrolledUp) {
		scrollContainer.scrollTop = scrollContainer.scrollHeight;
	}
}

/**
 * Syntax-highlight a JSON string as HTML. Returns HTML string.
 */
function highlightJson(jsonStr: string): string {
	try {
		const obj = JSON.parse(jsonStr);
		return highlightValue(obj, 0);
	} catch {
		return escapeHtml(jsonStr);
	}
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function highlightValue(value: any, depth: number): string {
	if (value === null) return '<span class="jsonl-null">null</span>';
	if (typeof value === "boolean") return `<span class="jsonl-bool">${value}</span>`;
	if (typeof value === "number") return `<span class="jsonl-num">${value}</span>`;
	if (typeof value === "string") {
		const escaped = escapeHtml(JSON.stringify(value));
		return `<span class="jsonl-str">${escaped}</span>`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return '<span class="jsonl-bracket">[]</span>';
		const indent = "  ".repeat(depth + 1);
		const closingIndent = "  ".repeat(depth);
		const items = value.map((v) => `${indent}${highlightValue(v, depth + 1)}`).join(",\n");
		return `<span class="jsonl-bracket">[</span>\n${items}\n${closingIndent}<span class="jsonl-bracket">]</span>`;
	}
	if (typeof value === "object") {
		const keys = Object.keys(value);
		if (keys.length === 0) return '<span class="jsonl-bracket">{}</span>';
		const indent = "  ".repeat(depth + 1);
		const closingIndent = "  ".repeat(depth);
		const entries = keys
			.map((k) => {
				const keyHtml = `<span class="jsonl-key">"${escapeHtml(k)}"</span>`;
				const valHtml = highlightValue(value[k], depth + 1);
				return `${indent}${keyHtml}<span class="jsonl-colon">: </span>${valHtml}`;
			})
			.join(",\n");
		return `<span class="jsonl-bracket">{</span>\n${entries}\n${closingIndent}<span class="jsonl-bracket">}</span>`;
	}
	return escapeHtml(String(value));
}

/**
 * Get a short label for a JSONL line (type + relevant info).
 */
function getLineLabel(jsonStr: string): string {
	try {
		const obj = JSON.parse(jsonStr);
		const type = obj.type || "unknown";
		if (type === "message" && obj.message?.role) {
			return `${type} (${obj.message.role})`;
		}
		if (type === "context") return "context";
		if (type === "config") return "config";
		return type;
	} catch {
		return "parse error";
	}
}

function renderPanel() {
	if (!container) return;

	if (!visible) {
		render(html``, container);
		return;
	}

	const tmpl = html`
		<div class="jsonl-panel">
			<div class="jsonl-header">
				<span class="jsonl-title">Raw JSONL</span>
				<div class="jsonl-header-actions">
					<button
						class="jsonl-action-btn"
						@click=${() => {
							collapsedLines.clear();
							for (let i = 0; i < jsonlLines.length; i++) collapsedLines.add(i);
							renderPanel();
						}}
						title="Collapse all"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="4 14 10 14 10 20"></polyline>
							<polyline points="20 10 14 10 14 4"></polyline>
							<line x1="14" y1="10" x2="21" y2="3"></line>
							<line x1="3" y1="21" x2="10" y2="14"></line>
						</svg>
					</button>
					<button
						class="jsonl-action-btn"
						@click=${() => {
							collapsedLines.clear();
							renderPanel();
						}}
						title="Expand all"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="15 3 21 3 21 9"></polyline>
							<polyline points="9 21 3 21 3 15"></polyline>
							<line x1="21" y1="3" x2="14" y2="10"></line>
							<line x1="3" y1="21" x2="10" y2="14"></line>
						</svg>
					</button>
					<button
						class="jsonl-close"
						@click=${() => closeJsonlPanel()}
						title="Close JSONL viewer"
					>✕</button>
				</div>
			</div>
			<div class="jsonl-body" @scroll=${handleScroll}>
				${jsonlLines.length === 0
					? html`<div class="jsonl-empty">No session data</div>`
					: jsonlLines.map(
							(line, i) => html`
								<div class="jsonl-entry ${collapsedLines.has(i) ? "collapsed" : ""}">
									<div class="jsonl-entry-header" @click=${() => toggleLine(i)}>
										<span class="jsonl-chevron">${collapsedLines.has(i) ? "▶" : "▼"}</span>
										<span class="jsonl-line-num">${i + 1}</span>
										<span class="jsonl-line-label">${getLineLabel(line)}</span>
									</div>
									${collapsedLines.has(i)
										? ""
										: html`<pre class="jsonl-content"><code .innerHTML=${highlightJson(line)}></code></pre>`}
								</div>
							`,
						)}
			</div>
		</div>
	`;

	render(tmpl, container);

	// Grab the scroll container and auto-scroll
	scrollContainer = container.querySelector(".jsonl-body");
	requestAnimationFrame(() => scrollToBottom());
}

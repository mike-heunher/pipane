/**
 * JSONL raw viewer side panel.
 *
 * Shows the raw JSONL lines from the current session file, each line
 * pretty-printed with syntax highlighting and collapsible. Auto-scrolls
 * to the bottom unless the user has scrolled up.
 *
 * Long strings are truncated with an expand/collapse toggle, and
 * embedded newlines are rendered as actual line breaks.
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
let focusedLineIndex: number | null = null;
let focusClearTimer: ReturnType<typeof setTimeout> | null = null;

/** Track which long strings are expanded (by unique id) */
let expandedStrings = new Set<string>();
/** Auto-incrementing counter for generating unique string IDs per render */
let stringIdCounter = 0;

/** Truncation threshold in characters for string values */
const STRING_TRUNCATE_THRESHOLD = 200;
/** How many lines to show when truncated (for multi-line strings) */
const STRING_TRUNCATE_LINES = 3;

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

function closeJsonlPanel() {
	visible = false;
	stopPolling();
	focusedLineIndex = null;
	if (focusClearTimer) {
		clearTimeout(focusClearTimer);
		focusClearTimer = null;
	}
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
	expandedStrings.clear();
	focusedLineIndex = null;
	if (focusClearTimer) {
		clearTimeout(focusClearTimer);
		focusClearTimer = null;
	}
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

/**
 * Jump to the JSONL entry associated with a clicked chat element.
 *
 * - If toolCallId is provided, prefers the matching toolResult entry.
 * - Otherwise jumps to the Nth displayable message entry (0-indexed),
 *   matching MessageList ordering (excluding toolResult/artifact).
 */
export function jumpToJsonlEntryForChat(displayedMessageOrdinal: number, toolCallId?: string): boolean {
	if (!visible || !container || jsonlLines.length === 0) return false;

	let targetLine =
		(toolCallId ? findToolResultLineByToolCallId(toolCallId) : null) ??
		findLineByDisplayedMessageOrdinal(displayedMessageOrdinal);
	if (targetLine == null) return false;

	focusedLineIndex = targetLine;
	collapsedLines.delete(targetLine);
	userScrolledUp = true; // preserve explicit jump position instead of auto-scrolling to bottom
	renderPanel();

	requestAnimationFrame(() => {
		const entryEl = container?.querySelector(`.jsonl-entry[data-line-index="${targetLine}"]`) as HTMLElement | null;
		if (!entryEl) return;
		entryEl.scrollIntoView({ block: "center", behavior: "smooth" });
		entryEl.classList.add("jsonl-jump-flash");
		if (focusClearTimer) clearTimeout(focusClearTimer);
		focusClearTimer = setTimeout(() => {
			entryEl.classList.remove("jsonl-jump-flash");
			focusedLineIndex = null;
			renderPanel();
		}, 1200);
	});

	return true;
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

function toggleStringExpand(id: string) {
	if (expandedStrings.has(id)) {
		expandedStrings.delete(id);
	} else {
		expandedStrings.add(id);
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
 * Resets the string ID counter so IDs are stable per render call.
 */
function highlightJson(jsonStr: string, lineIndex: number): string {
	try {
		const obj = JSON.parse(jsonStr);
		stringIdCounter = 0;
		return highlightValue(obj, 0, lineIndex);
	} catch {
		return escapeHtml(jsonStr);
	}
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render a string value with newline interpretation, text wrapping,
 * and truncation with expand/collapse for long strings.
 */
function renderStringValue(value: string, lineIndex: number): string {
	const id = `s-${lineIndex}-${stringIdCounter++}`;
	const isExpanded = expandedStrings.has(id);

	// Check if this string is "long" — either many chars or many lines
	const lines = value.split("\n");
	const isLong = value.length > STRING_TRUNCATE_THRESHOLD || lines.length > STRING_TRUNCATE_LINES;

	if (!isLong) {
		// Short string: render with newlines interpreted, fully visible
		return `<span class="jsonl-str">"${formatStringContent(value)}"</span>`;
	}

	// Long string: show truncated or expanded
	if (isExpanded) {
		const formatted = formatStringContent(value);
		const charCount = value.length;
		const lineCount = lines.length;
		const stats = lineCount > 1 ? `${charCount} chars, ${lineCount} lines` : `${charCount} chars`;
		return (
			`<span class="jsonl-str jsonl-str-long">"` +
			`<span class="jsonl-str-content">${formatted}</span>` +
			`"</span>` +
			`<button class="jsonl-str-toggle" data-str-id="${id}" onclick="this.dispatchEvent(new CustomEvent('toggle-string', {bubbles:true, detail:'${id}'}))"` +
			` title="Collapse string">▲ collapse (${stats})</button>`
		);
	}

	// Truncated view
	const truncated = truncateString(value, lines);
	const charCount = value.length;
	const lineCount = lines.length;
	const stats = lineCount > 1 ? `${charCount} chars, ${lineCount} lines` : `${charCount} chars`;
	return (
		`<span class="jsonl-str jsonl-str-long jsonl-str-truncated">"` +
		`<span class="jsonl-str-content">${formatStringContent(truncated)}</span>` +
		`…"</span>` +
		`<button class="jsonl-str-toggle" data-str-id="${id}" onclick="this.dispatchEvent(new CustomEvent('toggle-string', {bubbles:true, detail:'${id}'}))"` +
		` title="Expand full string">▼ expand (${stats})</button>`
	);
}

/**
 * Format string content: escape HTML and render \n as actual line breaks.
 * Preserves other escape sequences as-is.
 */
function formatStringContent(s: string): string {
	// Escape HTML entities first
	const escaped = escapeHtml(s);
	// Convert newlines to <br> + indentation marker for visual clarity
	return escaped.replace(/\n/g, '<span class="jsonl-str-newline">↵</span>\n');
}

/**
 * Truncate a string for the collapsed view.
 * Prefers truncating by lines if multi-line, otherwise by character count.
 */
function truncateString(value: string, lines: string[]): string {
	if (lines.length > STRING_TRUNCATE_LINES) {
		// Truncate by lines
		const truncatedByLines = lines.slice(0, STRING_TRUNCATE_LINES).join("\n");
		// Also cap by character count
		if (truncatedByLines.length > STRING_TRUNCATE_THRESHOLD) {
			return truncatedByLines.slice(0, STRING_TRUNCATE_THRESHOLD);
		}
		return truncatedByLines;
	}
	// Single long line — truncate by chars
	return value.slice(0, STRING_TRUNCATE_THRESHOLD);
}

function highlightValue(value: any, depth: number, lineIndex: number): string {
	if (value === null) return '<span class="jsonl-null">null</span>';
	if (typeof value === "boolean") return `<span class="jsonl-bool">${value}</span>`;
	if (typeof value === "number") return `<span class="jsonl-num">${value}</span>`;
	if (typeof value === "string") {
		return renderStringValue(value, lineIndex);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return '<span class="jsonl-bracket">[]</span>';
		const indent = "  ".repeat(depth + 1);
		const closingIndent = "  ".repeat(depth);
		const items = value.map((v) => `${indent}${highlightValue(v, depth + 1, lineIndex)}`).join(",\n");
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
				const valHtml = highlightValue(value[k], depth + 1, lineIndex);
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

function parseLineObject(line: string): any | null {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function findToolResultLineByToolCallId(toolCallId: string): number | null {
	if (!toolCallId) return null;
	for (let i = 0; i < jsonlLines.length; i++) {
		const obj = parseLineObject(jsonlLines[i]);
		if (!obj || obj.type !== "message") continue;
		const msg = obj.message;
		if (msg?.role === "toolResult" && msg.toolCallId === toolCallId) {
			return i;
		}
	}
	return null;
}

function findLineByDisplayedMessageOrdinal(displayedMessageOrdinal: number): number | null {
	if (displayedMessageOrdinal < 0) return null;
	let displayIdx = 0;
	for (let i = 0; i < jsonlLines.length; i++) {
		const obj = parseLineObject(jsonlLines[i]);
		if (!obj || obj.type !== "message") continue;
		const role = obj.message?.role;
		if (role === "toolResult" || role === "artifact") continue;
		if (displayIdx === displayedMessageOrdinal) return i;
		displayIdx++;
	}
	return null;
}

function renderPanel() {
	if (!container) return;

	if (!visible) {
		render(html``, container);
		return;
	}

	const tmpl = html`
		<div class="jsonl-panel" @toggle-string=${(e: CustomEvent) => toggleStringExpand(e.detail)}>
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
						class="jsonl-action-btn"
						@click=${() => {
							expandedStrings.clear();
							renderPanel();
						}}
						title="Collapse all strings"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
							<line x1="9" y1="10" x2="15" y2="10"></line>
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
								<div
									class="jsonl-entry ${collapsedLines.has(i) ? "collapsed" : ""} ${focusedLineIndex === i ? "jsonl-entry-focused" : ""}"
									data-line-index="${i}"
								>
									<div class="jsonl-entry-header" @click=${() => toggleLine(i)}>
										<span class="jsonl-chevron">${collapsedLines.has(i) ? "▶" : "▼"}</span>
										<span class="jsonl-line-num">${i + 1}</span>
										<span class="jsonl-line-label">${getLineLabel(line)}</span>
									</div>
									${collapsedLines.has(i)
										? ""
										: html`<pre class="jsonl-content"><code .innerHTML=${highlightJson(line, i)}></code></pre>`}
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

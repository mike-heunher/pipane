import katex from "katex";
import katexStyles from "katex/dist/katex.min.css?inline";
import { html, render } from "lit";
import { Marked, type MarkedExtension, type Tokens } from "marked";
import markedKatex from "marked-katex-extension";
import type { BackendApi } from "./backend-api.js";

interface FilePreviewState {
	readonly sessionPath: string;
	readonly api: Pick<BackendApi, "getFileContent">;
	loading: boolean;
	path: string;
	content: string;
	frameDocument: string;
	error: string;
	requestGeneration: number;
}

const previewStates = new Map<string, FilePreviewState>();
let activeSessionPath = "";
let container: HTMLElement | null = null;
let onChangeCallback: (() => void) | null = null;
let frameMessageListenerInstalled = false;
let themeObserverInstalled = false;
let previewWidth: number | null = null;
let activeResize: {
	pointerId: number;
	startX: number;
	startWidth: number;
	overlay: HTMLDivElement;
} | null = null;

const MARKDOWN_FILE_PATTERN = /(?:^|\/)(?:readme|changelog|agents?)$|\.(?:md|markdown|mdown|mkd|mdx)$/i;
const HTML_FILE_PATTERN = /\.html?$/i;
const PREVIEWABLE_FILE_PATTERN = /\.(?:md|markdown|mdown|mkd|mdx|txt|log|json|jsonl|ya?ml|toml|ini|conf|config|xml|html?|css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|py|rb|php|java|kt|kts|go|rs|swift|c|cc|cpp|cxx|h|hh|hpp|hxx|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|dockerfile)$/i;
const FRAME_LINK_MESSAGE = "pipane:file-preview-link";
// Scripts run, but omitting allow-same-origin keeps preview code out of the app DOM.
const FRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";
const PREVIEW_MIN_WIDTH = 320;
const PREVIEW_MAX_WIDTH = 760;
const MIN_CONVERSATION_WIDTH = 320;
const MOBILE_BREAKPOINT = 768;
const KEYBOARD_RESIZE_STEP = 16;

const FRAME_LINK_BRIDGE = String.raw`<script>(() => {
	const isLocalFile = (href) => {
		if (!href || href.startsWith("#") || /^(?:https?|mailto|tel|data|javascript|blob|vscode):/i.test(href)) return false;
		if (/^file:/i.test(href)) return true;
		const path = href.split(/[?#]/, 1)[0];
		return path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path.includes("/") || /\.(?:md|markdown|mdown|mkd|mdx|txt|log|json|jsonl|ya?ml|toml|ini|conf|config|xml|html?|css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|py|rb|php|java|kt|kts|go|rs|swift|c|cc|cpp|cxx|h|hh|hpp|hxx|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|dockerfile)$/i.test(path) || /^(?:readme|changelog|agents?)$/i.test(path);
	};
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const anchor = event.target instanceof Element ? event.target.closest("a") : null;
		const href = anchor?.getAttribute("href")?.trim() || "";
		if (!isLocalFile(href)) return;
		event.preventDefault();
		parent.postMessage({ type: "${FRAME_LINK_MESSAGE}", href }, "*");
	}, true);
})();</script>`;

const KATEX_OPTIONS = { throwOnError: false, strict: false } as const;
const latexDelimiterExtension: MarkedExtension = {
	extensions: [
		{
			name: "inlineLatex",
			level: "inline",
			start: (source) => source.indexOf("\\("),
			tokenizer(source) {
				const match = /^\\\(([^\n]+?)\\\)/.exec(source);
				return match ? { type: "inlineLatex", raw: match[0], text: match[1].trim() } : undefined;
			},
			renderer: (token: Tokens.Generic) => katex.renderToString(String(token.text), {
				...KATEX_OPTIONS,
				displayMode: false,
			}),
		},
		{
			name: "blockLatex",
			level: "block",
			start: (source) => source.indexOf("\\["),
			tokenizer(source) {
				const match = /^\\\[([\s\S]+?)\\\](?:\n|$)/.exec(source);
				return match ? { type: "blockLatex", raw: match[0], text: match[1].trim() } : undefined;
			},
			renderer: (token: Tokens.Generic) => `${katex.renderToString(String(token.text), {
				...KATEX_OPTIONS,
				displayMode: true,
			})}\n`,
		},
	],
};
const markdownParser = new Marked({ async: false, gfm: true });
markdownParser.use(markedKatex(KATEX_OPTIONS), latexDelimiterExtension);

const MARKDOWN_STYLES = `<style>
	* { box-sizing: border-box; }
	html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg); }
	body { padding: 1rem 1.1rem 2rem; font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
	.markdown-preview { max-width: 56rem; margin: 0 auto; }
	.markdown-preview > :first-child { margin-top: 0; }
	.markdown-preview > :last-child { margin-bottom: 0; }
	h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 0.55em; line-height: 1.25; }
	h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
	h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
	p, blockquote, ul, ol, dl, table, pre, details { margin: 0 0 1em; }
	a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
	blockquote { margin-left: 0; padding: 0 1em; border-left: 0.25em solid var(--border); color: var(--muted); }
	code, kbd, pre, samp { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
	code { padding: 0.15em 0.35em; border-radius: 0.3em; background: var(--soft); font-size: 0.88em; }
	pre { overflow: auto; padding: 1em; border: 1px solid var(--border); border-radius: 0.4em; background: var(--soft); line-height: 1.45; }
	pre code { padding: 0; background: transparent; font-size: 0.85em; }
	table { display: block; width: max-content; max-width: 100%; overflow: auto; border-collapse: collapse; }
	th, td { padding: 0.42em 0.8em; border: 1px solid var(--border); } th { background: var(--soft); font-weight: 600; }
	img, video { max-width: 100%; height: auto; } hr { height: 1px; margin: 1.5em 0; border: 0; background: var(--border); }
	li + li { margin-top: 0.25em; } input[type="checkbox"] { margin-right: 0.45em; }
	.katex-display { max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 0.2em 0; }
</style>`;

const THEME_FALLBACKS = {
	"--bg": "#fff",
	"--fg": "#24292f",
	"--muted": "#57606a",
	"--border": "#d0d7de",
	"--soft": "#f6f8fa",
	"--link": "#0969da",
} as const;

function renderPreviewThemeStyles(): string {
	const root = document.documentElement;
	const computed = getComputedStyle(root);
	const sourceVariables: Record<keyof typeof THEME_FALLBACKS, string> = {
		"--bg": "--background",
		"--fg": "--foreground",
		"--muted": "--muted-foreground",
		"--border": "--border",
		"--soft": "--muted",
		"--link": "--primary",
	};
	const variables = Object.entries(sourceVariables)
		.map(([target, source]) => `${target}: ${computed.getPropertyValue(source).trim() || THEME_FALLBACKS[target as keyof typeof THEME_FALLBACKS]};`)
		.join(" ");
	const colorScheme = root.classList.contains("dark") ? "dark" : "light";
	return `<style>:root { color-scheme: ${colorScheme}; ${variables} }</style>`;
}

function stripLinkSuffix(value: string): string {
	const suffixIndex = value.search(/[?#]/);
	return suffixIndex >= 0 ? value.slice(0, suffixIndex) : value;
}

function decodePath(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function normalizeAbsolutePath(value: string): string {
	const segments: string[] = [];
	for (const segment of value.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

function directoryName(value: string): string {
	const normalized = normalizeAbsolutePath(value);
	const slash = normalized.lastIndexOf("/");
	return slash <= 0 ? "/" : normalized.slice(0, slash);
}

function baseName(value: string): string {
	return value.split("/").filter(Boolean).pop() || value;
}

function getResizeBounds(): { min: number; max: number } {
	const parent = container?.parentElement;
	const parentWidth = parent?.getBoundingClientRect().width || window.innerWidth;
	let occupiedWidth = 0;
	if (parent) {
		for (const sibling of Array.from(parent.children)) {
			if (sibling === container || sibling === parent.firstElementChild) continue;
			occupiedWidth += sibling.getBoundingClientRect().width;
		}
	}
	const availableWidth = parentWidth - occupiedWidth - MIN_CONVERSATION_WIDTH;
	return {
		min: PREVIEW_MIN_WIDTH,
		max: Math.max(PREVIEW_MIN_WIDTH, Math.min(PREVIEW_MAX_WIDTH, availableWidth)),
	};
}

function clampPreviewWidth(width: number): number {
	const { min, max } = getResizeBounds();
	return Math.min(max, Math.max(min, width));
}

function getCurrentPreviewWidth(): number {
	if (previewWidth !== null) return clampPreviewWidth(previewWidth);
	const renderedWidth = container?.getBoundingClientRect().width ?? 0;
	if (renderedWidth > 0) return clampPreviewWidth(renderedWidth);
	return clampPreviewWidth(window.innerWidth * 0.45);
}

function updateResizeHandle(width: number): void {
	const handle = container?.querySelector<HTMLElement>(".file-preview-resize-handle");
	if (!handle) return;
	const { min, max } = getResizeBounds();
	handle.setAttribute("aria-valuemin", String(Math.round(min)));
	handle.setAttribute("aria-valuemax", String(Math.round(max)));
	handle.setAttribute("aria-valuenow", String(Math.round(width)));
	handle.setAttribute("aria-valuetext", `${Math.round(width)} pixels`);
}

function setPreviewWidth(width: number): void {
	const nextWidth = clampPreviewWidth(width);
	previewWidth = nextWidth;
	if (container) container.style.width = `${nextWidth}px`;
	updateResizeHandle(nextWidth);
}

function applyPreviewWidth(): void {
	if (!container || previewWidth === null) return;
	const width = clampPreviewWidth(previewWidth);
	container.style.width = `${width}px`;
	updateResizeHandle(width);
}

function handleResizePointerMove(event: PointerEvent): void {
	if (!activeResize || event.pointerId !== activeResize.pointerId) return;
	event.preventDefault();
	setPreviewWidth(activeResize.startWidth + activeResize.startX - event.clientX);
}

function finishFilePreviewResize(event?: PointerEvent): void {
	if (!activeResize || (event && event.pointerId !== activeResize.pointerId)) return;
	window.removeEventListener("pointermove", handleResizePointerMove, true);
	window.removeEventListener("pointerup", finishFilePreviewResize, true);
	window.removeEventListener("pointercancel", finishFilePreviewResize, true);
	window.removeEventListener("blur", handleResizeWindowBlur);
	activeResize.overlay.remove();
	activeResize = null;
	document.body.classList.remove("is-file-preview-resizing");
}

function handleResizeWindowBlur(): void {
	finishFilePreviewResize();
}

function startFilePreviewResize(event: PointerEvent): void {
	if (event.button !== 0 || !event.isPrimary || window.innerWidth <= MOBILE_BREAKPOINT || !container) return;
	event.preventDefault();
	finishFilePreviewResize();

	const overlay = document.createElement("div");
	overlay.className = "file-preview-resize-overlay";
	overlay.setAttribute("aria-hidden", "true");
	document.body.appendChild(overlay);
	document.body.classList.add("is-file-preview-resizing");
	activeResize = {
		pointerId: event.pointerId,
		startX: event.clientX,
		startWidth: getCurrentPreviewWidth(),
		overlay,
	};
	window.addEventListener("pointermove", handleResizePointerMove, true);
	window.addEventListener("pointerup", finishFilePreviewResize, true);
	window.addEventListener("pointercancel", finishFilePreviewResize, true);
	window.addEventListener("blur", handleResizeWindowBlur);
}

function handleFilePreviewResizeKeydown(event: KeyboardEvent): void {
	if (window.innerWidth <= MOBILE_BREAKPOINT) return;
	const { min, max } = getResizeBounds();
	const currentWidth = getCurrentPreviewWidth();
	let nextWidth: number;
	switch (event.key) {
		case "ArrowLeft":
			nextWidth = currentWidth + KEYBOARD_RESIZE_STEP;
			break;
		case "ArrowRight":
			nextWidth = currentWidth - KEYBOARD_RESIZE_STEP;
			break;
		case "Home":
			nextWidth = min;
			break;
		case "End":
			nextWidth = max;
			break;
		default:
			return;
	}
	event.preventDefault();
	setPreviewWidth(nextWidth);
}

export function isPreviewableFileHref(rawHref: string): boolean {
	const href = rawHref.trim();
	if (!href || href.startsWith("#")) return false;
	if (/^(?:https?|mailto|tel|data|javascript|blob|vscode):/i.test(href)) return false;
	if (/^file:/i.test(href)) return true;

	const pathValue = stripLinkSuffix(href);
	if (!pathValue) return false;
	if (pathValue.startsWith("/") || pathValue.startsWith("./") || pathValue.startsWith("../")) return true;
	if (pathValue.includes("/")) return true;
	return PREVIEWABLE_FILE_PATTERN.test(pathValue) || MARKDOWN_FILE_PATTERN.test(pathValue);
}

function isAutoLinkableFileHref(rawHref: string): boolean {
	if (!isPreviewableFileHref(rawHref)) return false;
	const pathValue = stripLinkSuffix(rawHref);
	return PREVIEWABLE_FILE_PATTERN.test(pathValue) || MARKDOWN_FILE_PATTERN.test(pathValue);
}

function encodeMarkdownHref(rawHref: string): string | null {
	try {
		return encodeURI(rawHref)
			.replaceAll("(", "%28")
			.replaceAll(")", "%29");
	} catch {
		return null;
	}
}

function isInsideMarkdownLinkLabel(markdown: string, start: number, end: number): boolean {
	const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
	const labelPrefix = markdown.slice(lineStart, start);
	const openingBracket = labelPrefix.lastIndexOf("[");
	if (openingBracket < 0 || labelPrefix.slice(openingBracket + 1).includes("]")) return false;

	const lineEndIndex = markdown.indexOf("\n", end);
	const lineEnd = lineEndIndex < 0 ? markdown.length : lineEndIndex;
	return /^[^\]]*\]\s*(?:\(|\[)/.test(markdown.slice(end, lineEnd));
}

function linkifyInlineCode(markdown: string): string {
	return markdown.replace(/(`+)([^`\n]+)\1/g, (match, _delimiter: string, value: string, offset: number) => {
		const rawHref = value.trim();
		if (rawHref !== value || !isAutoLinkableFileHref(rawHref)) return match;
		if (/[\t\r\n<>]/.test(rawHref) || /\s(?:&&|\|\||[<>]|--?\w)/.test(rawHref)) return match;

		// Do not rewrite code that is already part of an explicit Markdown link.
		if (isInsideMarkdownLinkLabel(markdown, offset, offset + match.length)) return match;

		const encodedHref = encodeMarkdownHref(rawHref);
		return encodedHref ? `[${match}](${encodedHref})` : match;
	});
}

/**
 * Turn previewable local paths written as inline code into Markdown links.
 * Fenced examples remain source code, while the generated anchors are handled
 * by the delegated preview listener in main.ts.
 */
export function linkifyPreviewableInlineCode(markdown: string): string {
	let result = "";
	let plainStart = 0;
	let lineStart = 0;

	while (lineStart < markdown.length) {
		const lineEndIndex = markdown.indexOf("\n", lineStart);
		const lineEnd = lineEndIndex < 0 ? markdown.length : lineEndIndex;
		const line = markdown.slice(lineStart, lineEnd);
		const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (!openingFence) {
			lineStart = lineEndIndex < 0 ? markdown.length : lineEnd + 1;
			continue;
		}

		result += linkifyInlineCode(markdown.slice(plainStart, lineStart));
		const marker = openingFence[1][0];
		const minimumLength = openingFence[1].length;
		let fenceEnd = markdown.length;
		let candidateStart = lineEndIndex < 0 ? markdown.length : lineEnd + 1;
		while (candidateStart < markdown.length) {
			const candidateEndIndex = markdown.indexOf("\n", candidateStart);
			const candidateEnd = candidateEndIndex < 0 ? markdown.length : candidateEndIndex;
			const candidate = markdown.slice(candidateStart, candidateEnd);
			const closingFence = /^ {0,3}(`+|~+)[ \t]*$/.exec(candidate);
			if (closingFence
				&& closingFence[1][0] === marker
				&& closingFence[1].length >= minimumLength) {
				fenceEnd = candidateEndIndex < 0 ? markdown.length : candidateEnd + 1;
				break;
			}
			candidateStart = candidateEndIndex < 0 ? markdown.length : candidateEnd + 1;
		}

		result += markdown.slice(lineStart, fenceEnd);
		plainStart = fenceEnd;
		lineStart = fenceEnd;
	}

	return result + linkifyInlineCode(markdown.slice(plainStart));
}

export function resolveFileHref(rawHref: string, baseDirectory: string): string | null {
	if (!isPreviewableFileHref(rawHref) || !baseDirectory.startsWith("/")) return null;
	let href = rawHref.trim();

	if (/^file:/i.test(href)) {
		try {
			const url = new URL(href);
			if (url.hostname && url.hostname !== "localhost") return null;
			href = url.pathname;
		} catch {
			return null;
		}
	} else {
		href = stripLinkSuffix(href);
	}

	const decoded = decodePath(href);
	if (!decoded || decoded.includes("\0")) return null;
	return normalizeAbsolutePath(decoded.startsWith("/") ? decoded : `${baseDirectory}/${decoded}`);
}

function isMarkdownFile(filePath: string): boolean {
	return MARKDOWN_FILE_PATTERN.test(filePath);
}

function isHtmlFile(filePath: string): boolean {
	return HTML_FILE_PATTERN.test(filePath);
}

function injectFrameBridge(content: string): string {
	// Keep an initial doctype first, then bootstrap before any source scripts.
	// Avoid searching for <head>: that text may itself occur inside a script.
	const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
	const insertionPoint = doctype?.[0].length ?? 0;
	return `${content.slice(0, insertionPoint)}${FRAME_LINK_BRIDGE}${content.slice(insertionPoint)}`;
}

function renderMarkdownDocument(markdown: string): string {
	const rendered = markdownParser.parse(linkifyPreviewableInlineCode(markdown));
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${renderPreviewThemeStyles()}<style>${katexStyles}</style>${MARKDOWN_STYLES}${FRAME_LINK_BRIDGE}</head><body><main class="markdown-preview">${rendered}</main></body></html>`;
}

function installThemeObserver(): void {
	if (themeObserverInstalled) return;
	themeObserverInstalled = true;
	new MutationObserver(() => {
		let changed = false;
		for (const state of previewStates.values()) {
			if (state.loading || state.error || !isMarkdownFile(state.path)) continue;
			state.frameDocument = renderMarkdownDocument(state.content);
			changed = true;
		}
		if (changed) renderPanel();
	}).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class", "data-color-theme"],
	});
}

function installFrameMessageListener(): void {
	if (frameMessageListenerInstalled) return;
	frameMessageListenerInstalled = true;
	window.addEventListener("message", (event) => {
		const frame = container?.querySelector<HTMLIFrameElement>(".file-preview-frame");
		if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
		const data = event.data as { type?: unknown; href?: unknown } | null;
		if (data?.type !== FRAME_LINK_MESSAGE || typeof data.href !== "string" || data.href.length > 4096) return;
		const state = previewStates.get(activeSessionPath);
		if (!state || !isPreviewableFileHref(data.href)) return;
		openFilePreviewLink(data.href, "/", state.sessionPath, state.path, state.api);
	});
}

function notifyChanged(): void {
	renderPanel();
	onChangeCallback?.();
}

async function loadFile(state: FilePreviewState, filePath: string): Promise<void> {
	const generation = state.requestGeneration;
	try {
		const payload = await state.api.getFileContent(state.sessionPath, filePath);
		if (previewStates.get(state.sessionPath) !== state || generation !== state.requestGeneration) return;
		state.path = typeof payload.path === "string" ? payload.path : filePath;
		state.content = payload.content;
		state.frameDocument = isMarkdownFile(state.path)
			? renderMarkdownDocument(state.content)
			: isHtmlFile(state.path)
				? injectFrameBridge(state.content)
				: "";
		state.error = "";
	} catch (error) {
		if (previewStates.get(state.sessionPath) !== state || generation !== state.requestGeneration) return;
		state.content = "";
		state.frameDocument = "";
		state.error = error instanceof Error ? error.message : String(error);
	} finally {
		if (previewStates.get(state.sessionPath) !== state || generation !== state.requestGeneration) return;
		state.loading = false;
		if (activeSessionPath === state.sessionPath) notifyChanged();
	}
}

/**
 * Open a local file link in the right-hand preview pane.
 *
 * Relative links in chat use the session CWD. Relative links inside an already
 * open Markdown or HTML file use that file's directory via baseFilePath.
 */
export function openFilePreviewLink(
	rawHref: string,
	cwd: string,
	sessionPath: string,
	baseFilePath: string | undefined,
	api: Pick<BackendApi, "getFileContent">,
): boolean {
	const baseDirectory = baseFilePath ? directoryName(baseFilePath) : cwd;
	const resolved = resolveFileHref(rawHref, baseDirectory);
	if (!resolved) return false;

	const previous = previewStates.get(sessionPath);
	const state: FilePreviewState = {
		sessionPath,
		api,
		loading: true,
		path: resolved,
		content: "",
		frameDocument: "",
		error: "",
		requestGeneration: (previous?.requestGeneration ?? 0) + 1,
	};
	previewStates.set(sessionPath, state);
	activeSessionPath = sessionPath;
	notifyChanged();
	void loadFile(state, resolved);
	return true;
}

export function setFilePreviewSession(sessionPath: string | undefined): void {
	const nextSessionPath = sessionPath ?? "";
	if (nextSessionPath === activeSessionPath) return;
	activeSessionPath = nextSessionPath;
	notifyChanged();
}

export function closeFilePreview(): void {
	finishFilePreviewResize();
	const state = previewStates.get(activeSessionPath);
	if (!state) return;
	state.requestGeneration++;
	previewStates.delete(activeSessionPath);
	notifyChanged();
}

export function isFilePreviewVisible(): boolean {
	return previewStates.has(activeSessionPath);
}

export function getFilePreviewPath(): string | undefined {
	return previewStates.get(activeSessionPath)?.path;
}

export function initFilePreview(el: HTMLElement, onChange: () => void): void {
	container = el;
	onChangeCallback = onChange;
	installFrameMessageListener();
	installThemeObserver();
	renderPanel();
	applyPreviewWidth();
}

function renderPanel(): void {
	if (!container) return;
	const state = previewStates.get(activeSessionPath);
	if (!state) {
		render(html``, container);
		return;
	}

	const title = baseName(state.path) || "File preview";
	const framed = !state.loading && !state.error && (isMarkdownFile(state.path) || isHtmlFile(state.path));
	const resizeBounds = getResizeBounds();
	const currentWidth = Math.round(getCurrentPreviewWidth());
	const body = state.loading
		? html`<div class="file-preview-state" role="status">Loading file…</div>`
		: state.error
			? html`<div class="file-preview-state is-error" role="alert">${state.error}</div>`
			: framed
				? html`<iframe
					class="file-preview-frame"
					title=${`${title} preview`}
					sandbox=${FRAME_SANDBOX}
					referrerpolicy="no-referrer"
					.srcdoc=${state.frameDocument}
				></iframe>`
				: html`<pre class="file-preview-source"><code>${state.content}</code></pre>`;

	render(html`
		<div
			class="file-preview-resize-handle"
			role="separator"
			aria-label="Resize file preview"
			aria-orientation="vertical"
			aria-valuemin=${Math.round(resizeBounds.min)}
			aria-valuemax=${Math.round(resizeBounds.max)}
			aria-valuenow=${currentWidth}
			aria-valuetext=${`${currentWidth} pixels`}
			tabindex="0"
			title="Drag to resize file preview"
			@pointerdown=${startFilePreviewResize}
			@keydown=${handleFilePreviewResizeKeydown}
		></div>
		<div class="file-preview-panel">
			<div class="file-preview-header">
				<div class="file-preview-heading">
					<span class="file-preview-title">${title}</span>
					<span class="file-preview-path" title=${state.path}>${state.path}</span>
				</div>
				<button
					type="button"
					class="file-preview-close"
					@click=${closeFilePreview}
					title="Close file preview"
					aria-label="Close file preview"
				>✕</button>
			</div>
			<div class=${framed ? "file-preview-body is-frame" : "file-preview-body"}>${body}</div>
		</div>
	`, container);
}

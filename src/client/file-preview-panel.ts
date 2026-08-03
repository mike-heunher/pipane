import { html, render } from "lit";
import type { BackendApi } from "./backend-api.js";

interface FilePreviewState {
	readonly key: string;
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
let activeSessionKey = "";
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
		if (/^(?:file|sandbox):/i.test(href)) return true;
		if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
		const path = href.split(/[?#]/, 1)[0];
		return path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path.includes("/") || /\.(?:md|markdown|mdown|mkd|mdx|txt|log|json|jsonl|ya?ml|toml|ini|conf|config|xml|html?|css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|py|rb|php|java|kt|kts|go|rs|swift|c|cc|cpp|cxx|h|hh|hpp|hxx|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|dockerfile)$/i.test(path) || /^(?:readme|changelog|agents?)$/i.test(path);
	};
	const forwardLink = (event, newWindow) => {
		if (event.defaultPrevented || event.altKey) return;
		const anchor = event.target instanceof Element ? event.target.closest("a") : null;
		const href = anchor?.getAttribute("href")?.trim() || "";
		if (!isLocalFile(href)) return;
		event.preventDefault();
		parent.postMessage({ type: "${FRAME_LINK_MESSAGE}", href, newWindow }, "*");
	};
	document.addEventListener("click", (event) => {
		if (event.button !== 0) return;
		forwardLink(event, event.metaKey || event.ctrlKey || event.shiftKey);
	}, true);
	document.addEventListener("auxclick", (event) => {
		if (event.button !== 1) return;
		forwardLink(event, true);
	}, true);
})();</script>`;

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

function decodeLocalFileUrl(value: string): string | null {
	try {
		const url = new URL(value);
		const protocol = url.protocol.toLowerCase();
		if (protocol !== "file:" && protocol !== "sandbox:") return null;
		if (url.hostname && !(protocol === "file:" && url.hostname === "localhost")) return null;
		if (!url.pathname.startsWith("/")) return null;
		return decodePath(url.pathname);
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
	if (/^(?:file|sandbox):/i.test(href)) return decodeLocalFileUrl(href) !== null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;

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

function decodeFileHref(rawHref: string): string | null {
	if (!isPreviewableFileHref(rawHref)) return null;
	const href = rawHref.trim();
	if (/^(?:file|sandbox):/i.test(href)) {
		const decoded = decodeLocalFileUrl(href);
		return decoded && !decoded.includes("\0") ? decoded : null;
	}
	const decoded = decodePath(stripLinkSuffix(href));
	return decoded && !decoded.includes("\0") ? decoded : null;
}

export function resolveFileHref(rawHref: string, baseDirectory: string): string | null {
	if (!baseDirectory.startsWith("/")) return null;
	const decoded = decodeFileHref(rawHref);
	if (!decoded) return null;
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

function escapeHtml(value: string): string {
	return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ?? character);
}

function renderSourceDocument(content: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark}body{margin:0;padding:1rem;background:Canvas;color:CanvasText}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}</style></head><body><pre>${escapeHtml(content)}</pre></body></html>`;
}

let markdownRendererPromise: Promise<typeof import("./file-preview-markdown.js")> | undefined;

async function renderMarkdownDocument(markdown: string): Promise<string> {
	markdownRendererPromise ??= import("./file-preview-markdown.js");
	const { renderMarkdownPreviewDocument } = await markdownRendererPromise;
	return renderMarkdownPreviewDocument(
		linkifyPreviewableInlineCode(markdown),
		renderPreviewThemeStyles(),
		FRAME_LINK_BRIDGE,
	);
}

function installThemeObserver(): void {
	if (themeObserverInstalled) return;
	themeObserverInstalled = true;
	new MutationObserver(() => {
		const updates = [...previewStates.values()].map(async (state) => {
			if (state.loading || state.error || !isMarkdownFile(state.path)) return false;
			const generation = state.requestGeneration;
			const frameDocument = await renderMarkdownDocument(state.content);
			if (previewStates.get(state.key) !== state || generation !== state.requestGeneration) return false;
			state.frameDocument = frameDocument;
			return true;
		});
		void Promise.all(updates).then((changed) => {
			if (changed.some(Boolean)) renderPanel();
		});
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
		const data = event.data as { type?: unknown; href?: unknown; newWindow?: unknown } | null;
		if (data?.type !== FRAME_LINK_MESSAGE || typeof data.href !== "string" || data.href.length > 4096) return;
		const state = previewStates.get(activeSessionKey);
		if (!state || !isPreviewableFileHref(data.href)) return;
		if (data.newWindow === true) {
			openFilePreviewLinkInNewWindow(data.href, "/", state.sessionPath, state.path, state.api);
			return;
		}
		openFilePreviewLink(data.href, "/", state.sessionPath, state.path, state.api, state.key);
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
		if (previewStates.get(state.key) !== state || generation !== state.requestGeneration) return;
		state.path = typeof payload.path === "string" ? payload.path : filePath;
		state.content = payload.content;
		state.frameDocument = isMarkdownFile(state.path)
			? await renderMarkdownDocument(state.content)
			: isHtmlFile(state.path)
				? injectFrameBridge(state.content)
				: "";
		state.error = "";
	} catch (error) {
		if (previewStates.get(state.key) !== state || generation !== state.requestGeneration) return;
		state.content = "";
		state.frameDocument = "";
		state.error = error instanceof Error ? error.message : String(error);
	} finally {
		if (previewStates.get(state.key) !== state || generation !== state.requestGeneration) return;
		state.loading = false;
		if (activeSessionKey === state.key) notifyChanged();
	}
}

/**
 * Open a local file link in the right-hand preview pane.
 *
 * Relative links in chat remain relative so the backend can use conversation
 * worktree evidence before its CWD fallback. Links inside an already open
 * Markdown or HTML file use that file's canonical directory via baseFilePath.
 */
export function openFilePreviewLink(
	rawHref: string,
	cwd: string,
	sessionPath: string,
	baseFilePath: string | undefined,
	api: Pick<BackendApi, "getFileContent">,
	stateKey = sessionPath,
): boolean {
	const request = resolveFilePreviewRequest(rawHref, cwd, baseFilePath);
	if (!request) return false;
	const { resolved, requestPath } = request;

	const previous = previewStates.get(stateKey);
	const state: FilePreviewState = {
		key: stateKey,
		sessionPath,
		api,
		loading: true,
		path: resolved,
		content: "",
		frameDocument: "",
		error: "",
		requestGeneration: (previous?.requestGeneration ?? 0) + 1,
	};
	previewStates.set(stateKey, state);
	activeSessionKey = stateKey;
	notifyChanged();
	void loadFile(state, requestPath);
	return true;
}

function resolveFilePreviewRequest(rawHref: string, cwd: string, baseFilePath: string | undefined): { resolved: string; requestPath: string } | null {
	const baseDirectory = baseFilePath ? directoryName(baseFilePath) : cwd;
	const decodedHref = decodeFileHref(rawHref);
	const resolved = resolveFileHref(rawHref, baseDirectory);
	if (!decodedHref || !resolved) return null;
	// Preserve relative intent for initial conversation links so the backend can
	// choose the session's evidenced worktree before falling back to its CWD.
	return {
		resolved,
		requestPath: !baseFilePath && !decodedHref.startsWith("/") ? decodedHref : resolved,
	};
}

function renderPreviewWindow(popup: Window, title: string, frameDocument?: string, status = ""): void {
	const document = popup.document;
	const root = document.documentElement || document.appendChild(document.createElement("html"));
	root.replaceChildren();
	const head = document.createElement("head");
	const titleElement = document.createElement("title");
	titleElement.textContent = title;
	head.appendChild(titleElement);
	const style = document.createElement("style");
	style.textContent = "html,body{width:100%;height:100%;margin:0;overflow:hidden;background:Canvas;color:CanvasText}.file-preview-window-frame{display:block;width:100%;height:100%;border:0}.file-preview-window-status{display:grid;height:100%;place-items:center;font:14px system-ui,sans-serif}";
	head.appendChild(style);
	const body = document.createElement("body");
	if (frameDocument) {
		const frame = document.createElement("iframe");
		frame.className = "file-preview-window-frame";
		frame.title = `${title} preview`;
		frame.setAttribute("sandbox", FRAME_SANDBOX);
		frame.referrerPolicy = "no-referrer";
		frame.srcdoc = frameDocument;
		body.appendChild(frame);
	} else {
		const message = document.createElement("div");
		message.className = "file-preview-window-status";
		message.textContent = status;
		body.appendChild(message);
	}
	root.append(head, body);
}

async function documentForFile(filePath: string, content: string): Promise<string> {
	return isMarkdownFile(filePath)
		? renderMarkdownDocument(content)
		: isHtmlFile(filePath)
			? injectFrameBridge(content)
			: renderSourceDocument(content);
}

/** Open a local file in a separate sandboxed browser window without changing pane state. */
export function openFilePreviewLinkInNewWindow(
	rawHref: string,
	cwd: string,
	sessionPath: string,
	baseFilePath: string | undefined,
	api: Pick<BackendApi, "getFileContent">,
): boolean {
	const request = resolveFilePreviewRequest(rawHref, cwd, baseFilePath);
	if (!request) return false;
	const popup = window.open("about:blank", "_blank");
	if (!popup) return false;
	popup.opener = null;
	const initialTitle = baseName(request.resolved) || "File preview";
	renderPreviewWindow(popup, initialTitle, undefined, "Loading file…");
	void api.getFileContent(sessionPath, request.requestPath).then(async (payload) => {
		if (popup.closed) return;
		const path = typeof payload.path === "string" ? payload.path : request.resolved;
		const frameDocument = await documentForFile(path, payload.content);
		if (!popup.closed) renderPreviewWindow(popup, baseName(path) || "File preview", frameDocument);
	}).catch((error: unknown) => {
		if (popup.closed) return;
		renderPreviewWindow(popup, initialTitle, undefined, error instanceof Error ? error.message : String(error));
	});
	return true;
}

async function openCurrentFilePreviewInNewWindow(): Promise<void> {
	const state = previewStates.get(activeSessionKey);
	if (!state || state.loading || state.error) return;
	const popup = window.open("about:blank", "_blank");
	if (!popup) return;
	popup.opener = null;
	const path = state.path;
	const content = state.content;
	renderPreviewWindow(popup, baseName(path) || "File preview", undefined, "Loading file…");
	closeFilePreview();
	const frameDocument = await documentForFile(path, content);
	if (!popup.closed) renderPreviewWindow(popup, baseName(path) || "File preview", frameDocument);
}

function downloadCurrentFilePreview(): void {
	const state = previewStates.get(activeSessionKey);
	if (!state || state.loading || state.error) return;
	const url = URL.createObjectURL(new Blob([state.content], { type: "application/octet-stream" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = baseName(state.path) || "download";
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export function setFilePreviewSession(sessionPath: string | undefined, stateKey = sessionPath): void {
	const nextSessionKey = stateKey ?? "";
	if (nextSessionKey === activeSessionKey) return;
	activeSessionKey = nextSessionKey;
	notifyChanged();
}

export function closeFilePreview(): void {
	finishFilePreviewResize();
	const state = previewStates.get(activeSessionKey);
	if (!state) return;
	state.requestGeneration++;
	previewStates.delete(activeSessionKey);
	notifyChanged();
}

export function isFilePreviewVisible(): boolean {
	return previewStates.has(activeSessionKey);
}

export function getFilePreviewPath(): string | undefined {
	return previewStates.get(activeSessionKey)?.path;
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
	const state = previewStates.get(activeSessionKey);
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
					class="file-preview-header-action file-preview-download"
					@click=${downloadCurrentFilePreview}
					?disabled=${state.loading || Boolean(state.error)}
					title=${`Download ${title}`}
					aria-label=${`Download ${title}`}
				>↓</button>
				<button
					type="button"
					class="file-preview-header-action file-preview-open-window"
					@click=${openCurrentFilePreviewInNewWindow}
					?disabled=${state.loading || Boolean(state.error)}
					title="Open in new window"
					aria-label="Open file preview in new window"
				>↗</button>
				<button
					type="button"
					class="file-preview-header-action file-preview-close"
					@click=${closeFilePreview}
					title="Close file preview"
					aria-label="Close file preview"
				>✕</button>
			</div>
			<div class=${framed ? "file-preview-body is-frame" : "file-preview-body"}>${body}</div>
		</div>
	`, container);
}

import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { html, render } from "lit";

interface FilePreviewPayload {
	path: string;
	content: string;
}

let visible = false;
let loading = false;
let previewPath = "";
let previewContent = "";
let previewError = "";
let container: HTMLElement | null = null;
let onChangeCallback: (() => void) | null = null;
let requestGeneration = 0;

const MARKDOWN_FILE_PATTERN = /(?:^|\/)(?:readme|changelog|agents?)$|\.(?:md|markdown|mdown|mkd|mdx)$/i;
const PREVIEWABLE_FILE_PATTERN = /\.(?:md|markdown|mdown|mkd|mdx|txt|log|json|jsonl|ya?ml|toml|ini|conf|config|xml|html?|css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|py|rb|php|java|kt|kts|go|rs|swift|c|cc|cpp|cxx|h|hh|hpp|hxx|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|dockerfile)$/i;

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

function notifyChanged(): void {
	renderPanel();
	onChangeCallback?.();
}

async function loadFile(
	sessionPath: string,
	filePath: string,
	generation: number,
	fetchImpl: typeof fetch,
): Promise<void> {
	try {
		const query = new URLSearchParams({ sessionPath, path: filePath });
		const response = await fetchImpl(`/api/files/content?${query}`, { cache: "no-store" });
		const payload = await response.json().catch(() => ({})) as Partial<FilePreviewPayload> & { error?: string };
		if (!response.ok || typeof payload.content !== "string") {
			throw new Error(payload.error || `Failed to load file (${response.status})`);
		}
		if (generation !== requestGeneration) return;
		previewPath = typeof payload.path === "string" ? payload.path : filePath;
		previewContent = payload.content;
		previewError = "";
	} catch (error) {
		if (generation !== requestGeneration) return;
		previewContent = "";
		previewError = error instanceof Error ? error.message : String(error);
	} finally {
		if (generation !== requestGeneration) return;
		loading = false;
		notifyChanged();
	}
}

/**
 * Open a local file link in the right-hand preview pane.
 *
 * Relative links in chat use the session CWD. Relative links inside an already
 * open markdown file use that file's directory via baseFilePath.
 */
export function openFilePreviewLink(
	rawHref: string,
	cwd: string,
	sessionPath: string,
	baseFilePath?: string,
	fetchImpl: typeof fetch = fetch,
): boolean {
	const baseDirectory = baseFilePath ? directoryName(baseFilePath) : cwd;
	const resolved = resolveFileHref(rawHref, baseDirectory);
	if (!resolved) return false;

	visible = true;
	loading = true;
	previewPath = resolved;
	previewContent = "";
	previewError = "";
	const generation = ++requestGeneration;
	notifyChanged();
	void loadFile(sessionPath, resolved, generation, fetchImpl);
	return true;
}

export function closeFilePreview(): void {
	if (!visible) return;
	visible = false;
	requestGeneration++;
	notifyChanged();
}

export function isFilePreviewVisible(): boolean {
	return visible;
}

export function getFilePreviewPath(): string | undefined {
	return visible && previewPath ? previewPath : undefined;
}

export function initFilePreview(el: HTMLElement, onChange: () => void): void {
	container = el;
	onChangeCallback = onChange;
	renderPanel();
}

function renderPanel(): void {
	if (!container) return;
	if (!visible) {
		render(html``, container);
		return;
	}

	const title = baseName(previewPath) || "File preview";
	const body = loading
		? html`<div class="file-preview-state" role="status">Loading file…</div>`
		: previewError
			? html`<div class="file-preview-state is-error" role="alert">${previewError}</div>`
			: isMarkdownFile(previewPath)
				? html`<markdown-block .content=${previewContent}></markdown-block>`
				: html`<pre class="file-preview-source"><code>${previewContent}</code></pre>`;

	render(html`
		<div class="file-preview-panel">
			<div class="file-preview-header">
				<div class="file-preview-heading">
					<span class="file-preview-title">${title}</span>
					<span class="file-preview-path" title=${previewPath}>${previewPath}</span>
				</div>
				<button
					type="button"
					class="file-preview-close"
					@click=${closeFilePreview}
					title="Close file preview"
					aria-label="Close file preview"
				>✕</button>
			</div>
			<div class="file-preview-body">${body}</div>
		</div>
	`, container);
}

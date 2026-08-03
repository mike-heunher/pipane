/**
 * Tool renderers for pi coding agent tools.
 *
 * Registers renderers for Read, Edit, Write, Bash, Canvas that show
 * tool name and relevant parameters with a gutter-thread collapsible layout.
 */

import { registerToolRenderer, setFallbackToolRenderer } from "./tool-registry.js";
import type { ToolRenderer, ToolRenderResult, FallbackToolRenderer } from "./tool-registry.js";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { html, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ref } from "lit/directives/ref.js";
import { FileText, FilePen, FilePlus, SquareTerminal, Loader, PanelRight, ChevronRight, Puzzle } from "lucide";
import { showCanvas } from "../canvas-panel.js";
import { notifyToolToggled } from "../auto-collapse.js";
import { streamingScrollPin } from "./streaming-scroll-pin.js";

/** Strip `cd /some/path && ` prefix that pi injects for cwd. */
export function stripCdPrefix(command: string): string {
	if (!command) return command;
	const m = command.match(/^cd\s+\S+\s+&&\s+(.*)$/s);
	return m ? m[1] : command;
}

export function formatBashMainText(command: string): string {
	if (!command?.trim()) return "";
	return command.includes("\n") ? command : "";
}

const extToLanguage: Record<string, string> = {
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	html: "html", htm: "html", svg: "xml", xml: "xml",
	css: "css", scss: "scss",
	json: "json", jsonl: "json",
	py: "python", pyw: "python",
	md: "markdown", mdx: "markdown",
	yaml: "yaml", yml: "yaml",
	sh: "bash", bash: "bash", zsh: "bash",
	sql: "sql",
	java: "java",
	c: "c", h: "c",
	cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
	go: "go",
	rs: "rust",
	php: "php",
	rb: "ruby",
	swift: "swift",
	kt: "kotlin", kts: "kotlin",
};

function getLanguageFromPath(path: string): string {
	if (!path) return "";
	const ext = path.split(".").pop()?.toLowerCase() || "";
	return extToLanguage[ext] || "";
}

const MAX_HIGHLIGHT_INPUT_CHARS = 100_000;
export const SYNTAX_HIGHLIGHTER_READY_EVENT = "pipane:syntax-highlighter-ready";
let syntaxHighlighter: typeof import("./syntax-highlighter.js") | undefined;
let syntaxHighlighterPromise: Promise<typeof import("./syntax-highlighter.js")> | undefined;
let syntaxHighlighterScheduled = false;

export function loadSyntaxHighlighter(): Promise<typeof import("./syntax-highlighter.js")> {
	syntaxHighlighterPromise ??= import("./syntax-highlighter.js").then((module) => {
		syntaxHighlighter = module;
		window.dispatchEvent(new Event(SYNTAX_HIGHLIGHTER_READY_EVENT));
		return module;
	});
	return syntaxHighlighterPromise;
}

function scheduleSyntaxHighlighter(): void {
	if (syntaxHighlighter || syntaxHighlighterScheduled) return;
	syntaxHighlighterScheduled = true;
	const load = () => { void loadSyntaxHighlighter(); };
	if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(load, { timeout: 1_000 });
	else window.setTimeout(load, 0);
}

function highlightCode(code: string, language: string): string {
	if (!language || code.length > MAX_HIGHLIGHT_INPUT_CHARS) return "";
	if (!syntaxHighlighter) {
		scheduleSyntaxHighlighter();
		return "";
	}
	return syntaxHighlighter.highlightCode(code, language);
}

function resultText(result: ToolResultMessage | undefined): string {
	if (!result) return "";
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

// ── Shared helpers ──────────────────────────────────────────────

type ToolState = "complete" | "error" | "inprogress";

/** Icon color class based on tool state. */
function iconColorClass(state: ToolState): string {
	return state === "complete"
		? "text-green-600 dark:text-green-500"
		: state === "error"
			? "text-destructive"
			: "text-foreground";
}

/** Gutter thread line color based on tool state. */
function threadColorClass(state: ToolState): string {
	return state === "complete"
		? "bg-green-300 dark:bg-green-700"
		: state === "error"
			? "bg-destructive/40"
			: "bg-border";
}

/** Toggle click handler: toggles the body and rotates the chevron. */
function handleToggle(e: Event) {
	const hdr = (e.currentTarget as HTMLElement);
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
	// Notify auto-collapse so user-opened tools aren't re-collapsed
	if (isHidden) {
		notifyToolToggled(wrapper);
	}
}

/**
 * Ref callback that prevents an element from shrinking during re-renders.
 */
function antiFlickerRef(el: Element | undefined) {
	if (!el || !(el instanceof HTMLElement)) return;
	const h = el.offsetHeight;
	if (h > 0) {
		el.style.minHeight = `${h}px`;
		requestAnimationFrame(() => {
			el.style.minHeight = "";
		});
	}
}

// ── Renderers ───────────────────────────────────────────────────

class ReadRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, runtime?: TemplateResult): ToolRenderResult {
		const state: ToolState = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const filename = path ? path.split("/").pop() : "";
		const extras: string[] = [];
		if (parsed.offset != null) extras.push(`offset:${parsed.offset}`);
		if (parsed.limit != null) extras.push(`limit:${parsed.limit}`);
		const paramStr = [filename, ...extras].filter(Boolean).join(", ");
		const headerLabel = paramStr ? `read(${paramStr})` : "read";
		const output = resultText(result);
		const isError = result?.isError ?? false;

		const statusIcon = html`<span class="inline-block ${iconColorClass(state)}">${icon(FileText, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		const content = output;
		const language = getLanguageFromPath(path);
		const highlighted = content && !isError && !isStreaming ? highlightCode(content, language) : "";
		const hasBody = !!content;

		return {
			content: html`
				<div class="tool-gutter-wrap flex my-0">
					<div class="tool-gutter flex flex-col items-center w-5 shrink-0 pt-0.5">
						${statusIcon}
						${hasBody ? html`<div class="tool-thread-line w-0.5 flex-1 mt-0.5 rounded-full ${threadColorClass(state)}"></div>` : ""}
					</div>
					<div class="flex-1 min-w-0">
						<div class="tool-hdr flex items-center gap-1 cursor-pointer py-px hover:text-foreground" @click=${handleToggle}>
							<span class="tool-chevron inline-block transition-transform text-muted-foreground" style="transform: rotate(90deg)">${icon(ChevronRight, "xs")}</span>
							<span class="tool-header-label text-muted-foreground font-mono">${headerLabel}</span>
							${spinner}
							${!hasBody ? runtime : ""}
						</div>
						${hasBody ? html`<div class="tool-body-collapsible">
							<div class="tool-runtime-card bg-muted rounded-md mt-0.5">
								${runtime}<div ${streamingScrollPin(state === "inprogress")} class="overflow-auto tool-body-scroll px-2 py-1.5">
									<pre class="m-0 tool-body-code ${isError ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${highlighted ? html`<code class="hljs">${unsafeHTML(highlighted)}</code>` : content}</pre>
								</div>
							</div>
						</div>` : ""}
					</div>
				</div>
			`,
			isCustom: true,
		};
	}
}

class WriteRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, runtime?: TemplateResult): ToolRenderResult {
		const state: ToolState = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const filename = path ? path.split("/").pop() : "";
		const fileContent = parsed.content || "";
		const contentBytes = fileContent ? new TextEncoder().encode(fileContent).length : 0;
		const output = resultText(result);
		const isError = result?.isError ?? false;

		let headerLabel = filename ? `write(${filename})` : "write";
		if (state === "error" && output) {
			headerLabel += ` — ${output}`;
		} else if (state === "complete" && contentBytes > 0) {
			headerLabel += ` — ${contentBytes.toLocaleString()} bytes`;
		}

		const statusIcon = html`<span class="inline-block ${iconColorClass(state)}">${icon(FilePlus, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		const language = getLanguageFromPath(path);
		const displayContent = fileContent;
		const highlighted = displayContent && !isError && !isStreaming ? highlightCode(displayContent, language) : "";
		const hasBody = !!displayContent;

		return {
			content: html`
				<div class="tool-gutter-wrap flex my-0">
					<div class="tool-gutter flex flex-col items-center w-5 shrink-0 pt-0.5">
						${statusIcon}
						${hasBody ? html`<div class="tool-thread-line w-0.5 flex-1 mt-0.5 rounded-full ${threadColorClass(state)}"></div>` : ""}
					</div>
					<div class="flex-1 min-w-0">
						<div class="tool-hdr flex items-center gap-1 cursor-pointer py-px hover:text-foreground" @click=${handleToggle}>
							<span class="tool-chevron inline-block transition-transform text-muted-foreground" style="transform: rotate(90deg)">${icon(ChevronRight, "xs")}</span>
							<span class="tool-header-label ${isError ? "text-destructive" : "text-muted-foreground"} font-mono truncate">${headerLabel}</span>
							${spinner}
							${!hasBody ? runtime : ""}
						</div>
						${hasBody ? html`<div class="tool-body-collapsible">
							<div class="tool-runtime-card bg-muted rounded-md mt-0.5">
								${runtime}<div ${streamingScrollPin(state === "inprogress")} class="overflow-auto tool-body-scroll px-2 py-1.5">
									<pre class="m-0 tool-body-code text-foreground font-mono whitespace-pre-wrap">${highlighted ? html`<code class="hljs">${unsafeHTML(highlighted)}</code>` : displayContent}</pre>
								</div>
							</div>
						</div>` : ""}
					</div>
				</div>
			`,
			isCustom: true,
		};
	}
}

function simpleDiff(oldText: string, newText: string): { lines: { type: "ctx" | "del" | "add"; text: string }[] } {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const result: { type: "ctx" | "del" | "add"; text: string }[] = [];

	const m = oldLines.length, n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++)
		for (let j = 1; j <= n; j++)
			dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

	let i = m, j = n;
	const ops: ("ctx" | "del" | "add")[] = [];
	const texts: string[] = [];
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			ops.push("ctx"); texts.push(oldLines[i - 1]); i--; j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.push("add"); texts.push(newLines[j - 1]); j--;
		} else {
			ops.push("del"); texts.push(oldLines[i - 1]); i--;
		}
	}
	ops.reverse(); texts.reverse();
	for (let k = 0; k < ops.length; k++) result.push({ type: ops[k], text: texts[k] });
	return { lines: result };
}

class EditRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, runtime?: TemplateResult): ToolRenderResult {
		const state: ToolState = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const filename = path ? path.split("/").pop() : "";
		const headerLabel = filename ? `edit(${filename})` : "edit";
		const output = resultText(result);
		const isError = result?.isError ?? false;

		const statusIcon = html`<span class="inline-block ${iconColorClass(state)}">${icon(FilePen, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		const oldText = parsed.oldText || "";
		const newText = parsed.newText || "";
		const hasDiff = oldText || newText;

		let diffBody: ReturnType<typeof html> | string = "";
		if (hasDiff) {
			const diff = simpleDiff(oldText, newText);
			diffBody = html`<div class="tool-runtime-card bg-muted rounded-md mt-0.5">
				${runtime}<div ${streamingScrollPin(state === "inprogress")} class="overflow-auto tool-body-scroll px-2 py-1.5">
					<pre class="m-0 tool-body-code font-mono whitespace-pre-wrap">${diff.lines.map(l =>
						l.type === "del" ? html`<span class="text-red-500 dark:text-red-400">- ${l.text}\n</span>`
						: l.type === "add" ? html`<span class="text-green-500 dark:text-green-400">+ ${l.text}\n</span>`
						: html`<span class="text-muted-foreground">  ${l.text}\n</span>`
					)}</pre>
				</div>
			</div>`;
		} else if (output && isError) {
			diffBody = html`<div class="tool-runtime-card bg-muted rounded-md mt-0.5">
				${runtime}<div class="overflow-auto tool-body-scroll px-2 py-1.5">
					<pre class="m-0 tool-body-code text-destructive font-mono whitespace-pre-wrap">${output}</pre>
				</div>
			</div>`;
		}

		const hasBody = !!(hasDiff || (output && isError));

		return {
			content: html`
				<div ${ref(antiFlickerRef)} class="tool-gutter-wrap flex my-0">
					<div class="tool-gutter flex flex-col items-center w-5 shrink-0 pt-0.5">
						${statusIcon}
						${hasBody ? html`<div class="tool-thread-line w-0.5 flex-1 mt-0.5 rounded-full ${threadColorClass(state)}"></div>` : ""}
					</div>
					<div class="flex-1 min-w-0">
						<div class="tool-hdr flex items-center gap-1 cursor-pointer py-px hover:text-foreground" @click=${handleToggle}>
							<span class="tool-chevron inline-block transition-transform text-muted-foreground" style="transform: rotate(90deg)">${icon(ChevronRight, "xs")}</span>
							<span class="tool-header-label text-muted-foreground font-mono">${headerLabel}</span>
							${spinner}
							${!hasBody ? runtime : ""}
						</div>
						${hasBody ? html`<div class="tool-body-collapsible">${diffBody}</div>` : ""}
					</div>
				</div>
			`,
			isCustom: true,
		};
	}
}

class BashRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, runtime?: TemplateResult): ToolRenderResult {
		const state: ToolState = result
			? result.isError ? "error" : (isStreaming ? "inprogress" : "complete")
			: "inprogress";

		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const command = stripCdPrefix(parsed.command || "");
		const output = resultText(result);
		const mainTextCommand = formatBashMainText(command);
		const combined = output
			? mainTextCommand
				? `> ${mainTextCommand}\n\n${output}`
				: output
			: mainTextCommand
				? `> ${mainTextCommand}`
				: "";
		const isError = result?.isError ?? false;

		const statusIcon = html`<span class="inline-block ${iconColorClass(state)}">${icon(SquareTerminal, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		// Bash always has a body (even if empty during streaming)
		const hasBody = true;

		return {
			content: html`
				<div class="tool-gutter-wrap flex my-0">
					<div class="tool-gutter flex flex-col items-center w-5 shrink-0 pt-0.5">
						${statusIcon}
						${hasBody ? html`<div class="tool-thread-line w-0.5 flex-1 mt-0.5 rounded-full ${threadColorClass(state)}"></div>` : ""}
					</div>
					<div class="flex-1 min-w-0">
						<div class="tool-hdr flex items-center gap-1 cursor-pointer py-px hover:text-foreground" @click=${handleToggle}>
							<span class="tool-chevron inline-block transition-transform text-muted-foreground" style="transform: rotate(90deg)">${icon(ChevronRight, "xs")}</span>
							<span class="tool-header-label text-muted-foreground font-mono truncate" title="${command}">${command || "console"}</span>
							${spinner}
						</div>
						<div class="tool-body-collapsible">
							<div class="tool-runtime-card bg-muted rounded-md mt-0.5">
								${runtime}<div ${streamingScrollPin(state === "inprogress")} class="overflow-auto tool-body-scroll px-2 py-1.5">
									<pre class="m-0 tool-body-code ${isError ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${combined || ""}</pre>
								</div>
							</div>
						</div>
					</div>
				</div>
			`,
			isCustom: true,
		};
	}
}

class CanvasRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, runtime?: TemplateResult): ToolRenderResult {
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const title = parsed.title || "Canvas";
		const isError = result?.isError ?? false;
		const pending = !result && isStreaming;

		if (pending) {
			return {
				content: html`
					<div class="tool-runtime-card flex items-center gap-2 px-3 pr-20 py-1.5 rounded-md bg-muted text-xs text-muted-foreground">
						${runtime}<span class="inline-block animate-spin">${icon(Loader, "sm")}</span>
						<span>Preparing canvas…</span>
					</div>
				`,
				isCustom: true,
			};
		}

		if (isError) {
			const output = resultText(result);
			return {
				content: html`
					<div class="tool-runtime-card px-3 pr-20 py-1.5 rounded-md bg-muted text-xs text-destructive">${runtime}${output || "Canvas error"}</div>
				`,
				isCustom: true,
			};
		}

		const markdown = result?.details?.markdown || "";

		return {
			content: html`
				<div class="tool-runtime-card inline-flex">
					${runtime}<button
						@click=${() => { if (markdown) showCanvas(title, markdown); }}
						class="inline-flex items-center gap-1.5 px-2.5 pr-20 py-1 text-xs rounded-md border border-border bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
						title="Show in canvas"
					>
						<span class="inline-flex text-muted-foreground">${icon(PanelRight, "sm")}</span>
						<span>${title}</span>
					</button>
				</div>
			`,
			isCustom: true,
		};
	}
}

const MAX_INLINE_GENERIC_CALL_CHARS = 240;

function formatInlineGenericCall(toolName: string, parsed: any): string | undefined {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

	const entries = Object.entries(parsed);
	if (entries.length === 0) return toolName;

	const formatted: string[] = [];
	for (const [key, value] of entries) {
		if (typeof value === "object" && value !== null) return undefined;
		let display: string | undefined;
		try {
			display = JSON.stringify(value);
		} catch {
			return undefined;
		}
		if (display === undefined || display.includes("\\n")) return undefined;
		formatted.push(`${key}: ${display}`);
	}

	const label = `${toolName}(${formatted.join(", ")})`;
	return label.length <= MAX_INLINE_GENERIC_CALL_CHARS ? label : undefined;
}

class GenericFallbackRenderer implements FallbackToolRenderer {
	render(toolName: string, params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, runtime?: TemplateResult): ToolRenderResult {
		const state: ToolState = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const inlineHeaderLabel = formatInlineGenericCall(toolName, parsed);
		const paramKeys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
		const headerLabel = inlineHeaderLabel
			?? (paramKeys.length ? `${toolName}(${paramKeys.join(", ")})` : toolName);

		const output = resultText(result);
		const isError = result?.isError ?? false;

		// Keep complex or unusually long parameters available in the body. Compact
		// primitive arguments are already shown in full as part of the call above.
		let paramsJson = "";
		if (!inlineHeaderLabel && params) {
			try {
				paramsJson = JSON.stringify(parsed, null, 2);
			} catch {
				paramsJson = String(params);
			}
		}

		let bodyContent = "";
		if (paramsJson && paramsJson !== "{}" && output) {
			bodyContent = `> ${paramsJson}\n\n${output}`;
		} else if (output) {
			bodyContent = output;
		} else if (paramsJson && paramsJson !== "{}") {
			bodyContent = paramsJson;
		}

		const statusIcon = html`<span class="inline-block ${iconColorClass(state)}">${icon(Puzzle, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		const hasBody = !!bodyContent || state === "inprogress";
		const highlighted = bodyContent && !isError && !isStreaming ? highlightCode(bodyContent, "json") : "";

		return {
			content: html`
				<div class="tool-gutter-wrap flex my-0">
					<div class="tool-gutter flex flex-col items-center w-5 shrink-0 pt-0.5">
						${statusIcon}
						${hasBody ? html`<div class="tool-thread-line w-0.5 flex-1 mt-0.5 rounded-full ${threadColorClass(state)}"></div>` : ""}
					</div>
					<div class="flex-1 min-w-0">
						<div class="tool-hdr flex items-start gap-1 cursor-pointer py-px hover:text-foreground" @click=${handleToggle}>
							<span class="tool-chevron inline-block transition-transform text-muted-foreground" style="transform: rotate(90deg)">${icon(ChevronRight, "xs")}</span>
							<span class="tool-header-label generic-tool-header-label min-w-0 text-muted-foreground font-mono" title=${headerLabel}>${headerLabel}</span>
							${spinner}
							${!hasBody ? runtime : ""}
						</div>
						${hasBody ? html`<div class="tool-body-collapsible">
							<div class="tool-runtime-card bg-muted rounded-md mt-0.5">
								${runtime}<div ${streamingScrollPin(state === "inprogress")} class="overflow-auto tool-body-scroll px-2 py-1.5">
									<pre class="m-0 tool-body-code ${isError ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${highlighted ? html`<code class="hljs">${unsafeHTML(highlighted)}</code>` : bodyContent}</pre>
								</div>
							</div>
						</div>` : ""}
					</div>
				</div>
			`,
			isCustom: true,
		};
	}
}

export function registerCodingAgentRenderers() {
	registerToolRenderer("read", new ReadRenderer());
	registerToolRenderer("write", new WriteRenderer());
	registerToolRenderer("edit", new EditRenderer());
	registerToolRenderer("bash", new BashRenderer());
	registerToolRenderer("canvas", new CanvasRenderer());
	setFallbackToolRenderer(new GenericFallbackRenderer());
}

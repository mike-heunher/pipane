/**
 * Tool renderers for pi coding agent tools.
 *
 * Registers renderers for Read, Edit, Write, Bash, Canvas that show
 * tool name and relevant parameters with a gutter-thread collapsible layout.
 */

import { registerToolRenderer } from "@mariozechner/pi-web-ui";
import type { ToolRenderer, ToolRenderResult } from "@mariozechner/pi-web-ui";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ref } from "lit/directives/ref.js";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xmlLang from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import scss from "highlight.js/lib/languages/scss";
import { FileText, FilePen, FilePlus, SquareTerminal, Loader, PanelRight, ChevronRight } from "lucide";
import { showCanvas } from "./canvas-panel.js";
import { notifyToolToggled } from "./auto-collapse.js";

// Register highlight.js languages
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("html", xmlLang);
hljs.registerLanguage("xml", xmlLang);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", c);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("scss", scss);

// Intentionally a no-op: we currently want full, untruncated tool content in the UI.
// Keep `_max` in the signature so call sites remain stable if we re-enable truncation later.
function truncate(s: string, _max: number): string {
	return s;
}

/**
 * Auto-scroll pinning for streaming tool output containers.
 */
function createScrollPin() {
	let userScrolledUp = false;
	let isStreaming = false;
	let el: HTMLElement | null = null;
	let observer: MutationObserver | null = null;
	let scrollListenerInstalled = false;
	let didCompleteScroll = false;

	function isAtBottom(): boolean {
		if (!el) return true;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
	}

	function scrollToEnd() {
		if (el) el.scrollTop = el.scrollHeight;
	}

	function onUserScroll() {
		if (!el || !isStreaming) return;
		userScrolledUp = !isAtBottom();
	}

	function onMutation() {
		if (!el) return;
		if (isStreaming && !userScrolledUp) {
			scrollToEnd();
		}
	}

	function refCb(element: Element | undefined) {
		if (!element || !(element instanceof HTMLElement)) return;

		if (element !== el) {
			el = element;
			scrollListenerInstalled = false;
			observer?.disconnect();
			observer = null;
			didCompleteScroll = false;
			userScrolledUp = false;
		}

		if (!scrollListenerInstalled) {
			el.addEventListener("scroll", onUserScroll, { passive: true });
			scrollListenerInstalled = true;
		}

		if (!observer) {
			observer = new MutationObserver(onMutation);
			observer.observe(el, { childList: true, subtree: true, characterData: true });
		}

		if (!isStreaming && !didCompleteScroll) {
			didCompleteScroll = true;
			requestAnimationFrame(() => scrollToEnd());
		}
	}

	return {
		ref: refCb,
		set streaming(v: boolean) {
			if (isStreaming && !v) {
				didCompleteScroll = false;
			}
			if (!isStreaming && v) {
				userScrolledUp = false;
				didCompleteScroll = false;
			}
			isStreaming = v;
		},
	};
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

function highlightCode(code: string, language: string): string {
	if (language && hljs.getLanguage(language)) {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	}
	return "";
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
	private scrollPin = createScrollPin();

	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state: ToolState = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		this.scrollPin.streaming = state === "inprogress";

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

		const content = output ? truncate(output, 4000) : "";
		const language = getLanguageFromPath(path);
		const highlighted = content && !isError ? highlightCode(content, language) : "";
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
						</div>
						${hasBody ? html`<div class="tool-body-collapsible">
							<div ${ref(this.scrollPin.ref)} class="overflow-auto tool-body-scroll bg-muted rounded-md mt-0.5 px-2 py-1.5">
								<pre class="m-0 tool-body-code ${isError ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${highlighted ? html`<code class="hljs">${unsafeHTML(highlighted)}</code>` : content}</pre>
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
	private scrollPin = createScrollPin();

	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state: ToolState = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		this.scrollPin.streaming = state === "inprogress";

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
			headerLabel += ` — ${truncate(output, 80)}`;
		} else if (state === "complete" && contentBytes > 0) {
			headerLabel += ` — ${contentBytes.toLocaleString()} bytes`;
		}

		const statusIcon = html`<span class="inline-block ${iconColorClass(state)}">${icon(FilePlus, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		const language = getLanguageFromPath(path);
		const displayContent = fileContent ? truncate(fileContent, 4000) : "";
		const highlighted = displayContent && !isError ? highlightCode(displayContent, language) : "";
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
						</div>
						${hasBody ? html`<div class="tool-body-collapsible">
							<div ${ref(this.scrollPin.ref)} class="overflow-auto tool-body-scroll bg-muted rounded-md mt-0.5 px-2 py-1.5">
								<pre class="m-0 tool-body-code text-foreground font-mono whitespace-pre-wrap">${highlighted ? html`<code class="hljs">${unsafeHTML(highlighted)}</code>` : displayContent}</pre>
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
	private scrollPin = createScrollPin();

	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state: ToolState = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		this.scrollPin.streaming = state === "inprogress";

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
			diffBody = html`<div ${ref(this.scrollPin.ref)} class="overflow-auto tool-body-scroll bg-muted rounded-md mt-0.5 px-2 py-1.5">
				<pre class="m-0 tool-body-code font-mono whitespace-pre-wrap">${diff.lines.map(l =>
					l.type === "del" ? html`<span class="text-red-500 dark:text-red-400">- ${l.text}\n</span>`
					: l.type === "add" ? html`<span class="text-green-500 dark:text-green-400">+ ${l.text}\n</span>`
					: html`<span class="text-muted-foreground">  ${l.text}\n</span>`
				)}</pre>
			</div>`;
		} else if (output && isError) {
			diffBody = html`<div class="overflow-auto tool-body-scroll bg-muted rounded-md mt-0.5 px-2 py-1.5">
				<pre class="m-0 tool-body-code text-destructive font-mono whitespace-pre-wrap">${truncate(output, 4000)}</pre>
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
	private scrollPin = createScrollPin();

	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state: ToolState = result
			? result.isError ? "error" : (isStreaming ? "inprogress" : "complete")
			: "inprogress";
		this.scrollPin.streaming = state === "inprogress";

		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const command = parsed.command || "";
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
							<div ${ref(this.scrollPin.ref)} class="overflow-auto tool-body-scroll bg-muted rounded-md mt-0.5 px-2 py-1.5">
								<pre class="m-0 tool-body-code ${isError ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${combined || ""}</pre>
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
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const title = parsed.title || "Canvas";
		const isError = result?.isError ?? false;
		const pending = !result && isStreaming;

		if (pending) {
			return {
				content: html`
					<div class="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
						<span class="inline-block animate-spin">${icon(Loader, "sm")}</span>
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
					<div class="px-3 py-1.5 text-xs text-destructive">${output || "Canvas error"}</div>
				`,
				isCustom: true,
			};
		}

		const markdown = result?.details?.markdown || "";

		return {
			content: html`
				<button
					@click=${() => { if (markdown) showCanvas(title, markdown); }}
					class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
					title="Show in canvas"
				>
					<span class="inline-flex text-muted-foreground">${icon(PanelRight, "sm")}</span>
					<span>${title}</span>
				</button>
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
}

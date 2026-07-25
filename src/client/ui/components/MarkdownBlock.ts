import katex from "katex";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Marked, type Tokens } from "marked";

const KATEX_OPTIONS = {
	throwOnError: false,
	strict: false,
	output: "html" as const,
};

function renderMath(text: string, displayMode: boolean): string {
	try {
		return katex.renderToString(text, { ...KATEX_OPTIONS, displayMode });
	} catch (error) {
		console.error("KaTeX error:", error);
		const delimiter = displayMode ? "$$" : "$";
		return `<span class="text-red-500 font-mono">${delimiter}${text}${delimiter}</span>`;
	}
}

const markdown = new Marked({ async: false });
markdown.use({
	extensions: [
		{
			name: "inlineMathDollar",
			level: "inline",
			start: (source) => source.indexOf("$"),
			tokenizer(source) {
				const match = /^\$([^$\n]+?)\$/s.exec(source);
				return match ? { type: "inlineMathDollar", raw: match[0], text: match[1].trim() } : undefined;
			},
			renderer: (token: Tokens.Generic) => renderMath(String(token.text), false),
		},
		{
			name: "blockMathDollar",
			level: "block",
			start: (source) => source.indexOf("$$"),
			tokenizer(source) {
				const match = /^\$\$([^$]+?)\$\$/s.exec(source);
				return match ? { type: "blockMathDollar", raw: match[0], text: match[1].trim() } : undefined;
			},
			renderer: (token: Tokens.Generic) => `<div class="my-4">${renderMath(String(token.text), true)}</div>`,
		},
		{
			name: "inlineMathLatex",
			level: "inline",
			start: (source) => source.indexOf("\\("),
			tokenizer(source) {
				const match = /^\\\((.+?)\\\)/s.exec(source);
				return match ? { type: "inlineMathLatex", raw: match[0], text: match[1].trim() } : undefined;
			},
			renderer: (token: Tokens.Generic) => renderMath(String(token.text), false),
		},
		{
			name: "blockMathLatex",
			level: "block",
			start: (source) => source.indexOf("\\["),
			tokenizer(source) {
				const match = /^\\\[(.+?)\\\]/s.exec(source);
				return match ? { type: "blockMathLatex", raw: match[0], text: match[1].trim() } : undefined;
			},
			renderer: (token: Tokens.Generic) => `<div class="my-4">${renderMath(String(token.text), true)}</div>`,
		},
	],
});

function escapeEmbeddedHtml(content: string): string {
	const codeBlocks: string[] = [];
	let escaped = content.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
		const index = codeBlocks.length;
		codeBlocks.push(match);
		return `__CODE_BLOCK_${index}__`;
	});
	escaped = escaped
		.replace(/<(\w+)([^>]*)>/g, "&lt;$1$2&gt;")
		.replace(/<\/(\w+)>/g, "&lt;/$1&gt;")
		.replace(/<(\w+)([^>]*)\s*\/>/g, "&lt;$1$2/&gt;")
		.replace(/<(?![^\s])/g, "&lt;");
	for (const [index, block] of codeBlocks.entries()) {
		escaped = escaped.replace(`__CODE_BLOCK_${index}__`, block);
	}
	return escaped;
}

function decodeHtmlEntities(code: string): string {
	return code
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;|&#x27;/g, "'")
		.replace(/&amp;/g, "&");
}

function encodeCode(code: string): string {
	const bytes = new TextEncoder().encode(decodeHtmlEntities(code));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function replaceCodeBlocks(content: string): string {
	let result = content.replace(
		/<pre><code class="language-(\w+)">([\s\S]+?)<\/code><\/pre>/g,
		(_match, language: string, code: string) => `<div class="mt-2"><code-block language="${language}" code="${encodeCode(code)}"></code-block></div>`,
	);
	result = result.replace(
		/<pre><code>([\s\S]+?)<\/code><\/pre>/g,
		(_match, code: string) => `<div class="mt-2"><code-block language="text" code="${encodeCode(code)}"></code-block></div>`,
	);
	return result;
}

@customElement("markdown-block")
export class MarkdownBlock extends LitElement {
	@property() content = "";
	@property({ type: Boolean }) isThinking = false;
	@property({ type: Boolean }) escapeHtml = true;

	createRenderRoot() {
		return this;
	}

	connectedCallback() {
		super.connectedCallback();
		this.classList.add("markdown-content");
		this.style.display = "block";
	}

	render() {
		if (!this.content) return html``;
		const renderer = new markdown.Renderer();
		const originalLink = renderer.link;
		renderer.link = function (token) {
			return originalLink.call(this, token)
				.replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
		};
		const originalTable = renderer.table;
		renderer.table = function (token) {
			return `<div class="overflow-x-auto my-2 border border-border rounded">${originalTable.call(this, token)}</div>`;
		};

		const source = this.escapeHtml ? escapeEmbeddedHtml(this.content) : this.content;
		const parsed = markdown.parse(source, { async: false, renderer });
		const rendered = replaceCodeBlocks(String(parsed));
		const classes = this.isThinking
			? "text-muted-foreground italic max-w-none break-words overflow-wrap-anywhere text-sm [&>*:last-child]:!mb-0"
			: "text-foreground max-w-none break-words overflow-wrap-anywhere [&>*:last-child]:!mb-0";
		return html`<div class=${classes}>${unsafeHTML(rendered)}</div>`;
	}
}

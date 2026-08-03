import katex from "katex";
import katexStyles from "katex/dist/katex.min.css?inline";
import { Marked, type MarkedExtension, type Tokens } from "marked";
import markedKatex from "marked-katex-extension";

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

export function renderMarkdownPreviewDocument(
	markdown: string,
	themeStyles: string,
	frameLinkBridge: string,
): string {
	const rendered = markdownParser.parse(markdown);
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${themeStyles}<style>${katexStyles}</style>${MARKDOWN_STYLES}${frameLinkBridge}</head><body><main class="markdown-preview">${rendered}</main></body></html>`;
}

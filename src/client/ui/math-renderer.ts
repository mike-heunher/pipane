import katex from "katex";

const KATEX_OPTIONS = {
	throwOnError: false,
	strict: false,
	output: "html" as const,
};

export function renderMath(text: string, displayMode: boolean): string {
	return katex.renderToString(text, { ...KATEX_OPTIONS, displayMode });
}

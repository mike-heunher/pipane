/**
 * Tool renderers for pi coding agent tools.
 *
 * Registers renderers for Read, Edit, Write that show the tool name
 * and relevant parameters in the header.
 */

import { registerToolRenderer, renderCollapsibleHeader } from "@mariozechner/pi-web-ui";
import type { ToolRenderer, ToolRenderResult } from "@mariozechner/pi-web-ui";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { FileText, FilePen, FilePlus, Pencil, SquareTerminal, Loader, Check, Copy } from "lucide";
import { createRef } from "lit/directives/ref.js";

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
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

class ReadRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const label = path ? `Read: ${truncate(path, 60)}` : "Read";

		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		const output = resultText(result);

		if (result && output) {
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, FileText, label, contentRef, chevronRef)}
						<div class="max-h-0 overflow-hidden transition-all duration-200" ${/* ref */""}>
							<div ${/* contentRef */ ""}>
								<code-block .code=${truncate(output, 4000)} language="text"></code-block>
							</div>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderCollapsibleHeader(state, FileText, label, contentRef, chevronRef)}</div>`,
			isCustom: false,
		};
	}
}

class WriteRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const label = path ? `Write: ${truncate(path, 60)}` : "Write";

		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		return {
			content: html`<div>${renderCollapsibleHeader(state, FilePlus, label, contentRef, chevronRef)}</div>`,
			isCustom: false,
		};
	}
}

class EditRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const label = path ? `Edit: ${truncate(path, 60)}` : "Edit";

		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		return {
			content: html`<div>${renderCollapsibleHeader(state, FilePen, label, contentRef, chevronRef)}</div>`,
			isCustom: false,
		};
	}
}

class BashRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const command = parsed.command || "";
		const output = resultText(result);
		const combined = output ? `> ${command}\n\n${output}` : command ? `> ${command}` : "";
		const isError = result?.isError ?? false;

		const iconColor = state === "complete"
			? "text-green-600 dark:text-green-500"
			: state === "error"
				? "text-destructive"
				: "text-foreground";

		const statusIcon = html`<span class="inline-block ${iconColor}">${icon(SquareTerminal, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		return {
			content: html`
				<div class="border border-border rounded-lg overflow-hidden">
					<div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
						<div class="flex items-center gap-2">
							${statusIcon}
							<span class="text-xs text-muted-foreground font-mono">console</span>
							${spinner}
						</div>
						<button
							@click=${async (e: Event) => {
								const btn = (e.currentTarget as HTMLElement);
								try {
									await navigator.clipboard.writeText(combined);
									btn.setAttribute("data-copied", "true");
									btn.requestUpdate?.();
									setTimeout(() => btn.removeAttribute("data-copied"), 1500);
								} catch {}
							}}
							class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
							title="Copy output"
						>
							${icon(Copy, "sm")}
						</button>
					</div>
					<div class="overflow-auto max-h-64">
						<pre class="!bg-background !border-0 !rounded-none m-0 p-3 text-xs ${isError ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${combined || ""}</pre>
					</div>
				</div>
			`,
			isCustom: true,
		};
	}
}

export function registerCodingAgentRenderers() {
	registerToolRenderer("Read", new ReadRenderer());
	registerToolRenderer("Write", new WriteRenderer());
	registerToolRenderer("Edit", new EditRenderer());
	registerToolRenderer("bash", new BashRenderer());
}

/**
 * Tool renderers for pi coding agent tools.
 *
 * Registers renderers for Read, Edit, Write that show the tool name
 * and relevant parameters in the header.
 */

import { registerToolRenderer } from "@mariozechner/pi-web-ui";
import type { ToolRenderer, ToolRenderResult } from "@mariozechner/pi-web-ui";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { FileText, FilePen, FilePlus, SquareTerminal, Loader, Copy, PanelRight } from "lucide";
import { showCanvas } from "./canvas-panel.js";

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}

export function formatBashMainText(command: string): string {
	if (!command?.trim()) return "";
	return command.includes("\n") ? command : "";
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
		const filename = path ? path.split("/").pop() : "";
		const extras: string[] = [];
		if (parsed.offset != null) extras.push(`offset:${parsed.offset}`);
		if (parsed.limit != null) extras.push(`limit:${parsed.limit}`);
		const paramStr = [filename, ...extras].filter(Boolean).join(", ");
		const headerLabel = paramStr ? `read(${paramStr})` : "read";
		const output = resultText(result);
		const isError = result?.isError ?? false;

		const iconColor = state === "complete"
			? "text-green-600 dark:text-green-500"
			: state === "error"
				? "text-destructive"
				: "text-foreground";

		const statusIcon = html`<span class="inline-block ${iconColor}">${icon(FileText, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		const content = output ? truncate(output, 4000) : "";

		return {
			content: html`
				<div class="border border-border rounded-lg overflow-hidden">
					<div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
						<div class="flex items-center gap-2">
							${statusIcon}
							<span class="text-xs text-muted-foreground font-mono">${headerLabel}</span>
							${spinner}
						</div>
						${content ? html`<button
							@click=${async (e: Event) => {
								try { await navigator.clipboard.writeText(output); } catch {}
							}}
							class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
							title="Copy output"
						>${icon(Copy, "sm")}</button>` : ""}
					</div>
					${content ? html`<div class="overflow-auto max-h-64">
						<pre class="!bg-background !border-0 !rounded-none m-0 p-3 text-xs ${isError ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${content}</pre>
					</div>` : ""}
				</div>
			`,
			isCustom: true,
		};
	}
}

class WriteRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const filename = path ? path.split("/").pop() : "";
		const contentBytes = parsed.content ? new TextEncoder().encode(parsed.content).length : 0;
		const output = resultText(result);
		const isError = result?.isError ?? false;

		// Build header: write(filename) — N bytes | error message
		let headerLabel = filename ? `write(${filename})` : "write";
		if (state === "error" && output) {
			headerLabel += ` — ${truncate(output, 80)}`;
		} else if (state === "complete" && contentBytes > 0) {
			headerLabel += ` — ${contentBytes.toLocaleString()} bytes`;
		}

		const iconColor = state === "complete"
			? "text-green-600 dark:text-green-500"
			: state === "error"
				? "text-destructive"
				: "text-foreground";

		const statusIcon = html`<span class="inline-block ${iconColor}">${icon(FilePlus, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		return {
			content: html`
				<div class="border border-border rounded-lg overflow-hidden">
					<div class="flex items-center px-3 py-1.5 bg-muted">
						<div class="flex items-center gap-2 min-w-0">
							${statusIcon}
							<span class="text-xs ${isError ? "text-destructive" : "text-muted-foreground"} font-mono truncate">${headerLabel}</span>
							${spinner}
						</div>
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

	// Simple LCS-based diff
	const m = oldLines.length, n = newLines.length;
	// Build LCS table
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++)
		for (let j = 1; j <= n; j++)
			dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

	// Backtrack
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
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		let parsed: any = {};
		try { parsed = typeof params === "string" ? JSON.parse(params) : params || {}; } catch { /* */ }

		const path = parsed.path || "";
		const filename = path ? path.split("/").pop() : "";
		const headerLabel = filename ? `edit(${filename})` : "edit";
		const output = resultText(result);
		const isError = result?.isError ?? false;

		const iconColor = state === "complete"
			? "text-green-600 dark:text-green-500"
			: state === "error"
				? "text-destructive"
				: "text-foreground";

		const statusIcon = html`<span class="inline-block ${iconColor}">${icon(FilePen, "sm")}</span>`;
		const spinner = state === "inprogress"
			? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>`
			: "";

		const oldText = parsed.oldText || "";
		const newText = parsed.newText || "";
		const hasDiff = oldText || newText;

		let diffContent: ReturnType<typeof html> | string = "";
		if (hasDiff) {
			const diff = simpleDiff(oldText, newText);
			diffContent = html`<div class="overflow-auto max-h-64">
				<pre class="!bg-background !border-0 !rounded-none m-0 p-3 text-xs font-mono whitespace-pre-wrap">${diff.lines.map(l =>
					l.type === "del" ? html`<span class="text-red-500 dark:text-red-400">- ${l.text}\n</span>`
					: l.type === "add" ? html`<span class="text-green-500 dark:text-green-400">+ ${l.text}\n</span>`
					: html`<span class="text-muted-foreground">  ${l.text}\n</span>`
				)}</pre>
			</div>`;
		} else if (output && isError) {
			diffContent = html`<div class="overflow-auto max-h-64">
				<pre class="!bg-background !border-0 !rounded-none m-0 p-3 text-xs text-destructive font-mono whitespace-pre-wrap">${truncate(output, 4000)}</pre>
			</div>`;
		}

		return {
			content: html`
				<div class="border border-border rounded-lg overflow-hidden">
					<div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
						<div class="flex items-center gap-2">
							${statusIcon}
							<span class="text-xs text-muted-foreground font-mono">${headerLabel}</span>
							${spinner}
						</div>
						${hasDiff ? html`<button
							@click=${async (e: Event) => {
								try { await navigator.clipboard.writeText(newText); } catch {}
							}}
							class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
							title="Copy new text"
						>${icon(Copy, "sm")}</button>` : ""}
					</div>
					${diffContent}
				</div>
			`,
			isCustom: true,
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
		const mainTextCommand = formatBashMainText(command);
		const combined = output
			? mainTextCommand
				? `> ${mainTextCommand}\n\n${output}`
				: output
			: mainTextCommand
				? `> ${mainTextCommand}`
				: "";
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
						<div class="flex items-center gap-2 min-w-0">
							${statusIcon}
							<span class="text-xs text-muted-foreground font-mono truncate" title="${command}">${command || "console"}</span>
							${spinner}
						</div>
						<button
							@click=${async (e: Event) => {
								const btn = (e.currentTarget as HTMLElement);
								const copyText = output ? (command ? `> ${command}\n\n${output}` : output) : command;
								try {
									await navigator.clipboard.writeText(copyText);
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

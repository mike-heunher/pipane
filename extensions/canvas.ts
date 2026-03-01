/**
 * Canvas tool extension for pipane.
 *
 * Registers a `canvas` tool that the LLM can call to display markdown
 * content in a side panel. Accepts either inline content or a file path.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "canvas",
		label: "Canvas",
		description:
			"Display markdown content in a side panel for the user. Use for long-form artifacts like documents, guides, code, HTML previews, essays, reports, etc. Only one canvas is visible at a time; calling this replaces the previous. Accepts either inline markdown via `content` or a `filePath` to read from disk.",
		parameters: Type.Object({
			title: Type.String({ description: "Short title for the canvas panel header" }),
			content: Type.Optional(
				Type.String({ description: "Markdown content to display in the canvas panel" }),
			),
			filePath: Type.Optional(
				Type.String({ description: "Path to a markdown file to display in the canvas panel" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let markdown = params.content ?? "";

			if (params.filePath) {
				try {
					const resolved = resolve(ctx.cwd, params.filePath);
					markdown = await readFile(resolved, "utf-8");
				} catch (err: any) {
					return {
						content: [{ type: "text" as const, text: `Error reading file: ${err.message}` }],
						isError: true,
					};
				}
			}

			if (!markdown) {
				return {
					content: [{ type: "text" as const, text: "Error: provide either `content` or `filePath`." }],
					isError: true,
				};
			}

			return {
				content: [{ type: "text" as const, text: "Canvas displayed to user." }],
				details: { title: params.title, markdown },
			};
		},
	});
}

/**
 * Tests for custom tool renderers.
 *
 * Verifies that registerCodingAgentRenderers() overrides the built-in
 * bash renderer from the UI library with our custom one (no outer card frame,
 * icon/spinner in console header, isCustom: true).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, render as renderTemplate } from "lit";
import hljs from "highlight.js/lib/core";
import { getToolRenderer, renderTool } from "./ui/tool-registry.js";
import { formatBashMainText, stripCdPrefix, registerCodingAgentRenderers } from "./ui/tool-renderers.js";

// Ensure custom renderers are registered (overriding built-ins)
registerCodingAgentRenderers();

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("stripCdPrefix", () => {
	it("strips cd /path && prefix from command", () => {
		expect(stripCdPrefix("cd /Users/dev/project && npm test")).toBe("npm test");
		expect(stripCdPrefix("cd /foo/bar && ls -la")).toBe("ls -la");
	});

	it("leaves commands without cd prefix unchanged", () => {
		expect(stripCdPrefix("npm test")).toBe("npm test");
		expect(stripCdPrefix("echo hello")).toBe("echo hello");
	});

	it("handles empty/falsy input", () => {
		expect(stripCdPrefix("")).toBe("");
	});

	it("strips cd prefix from multiline commands", () => {
		expect(stripCdPrefix("cd /foo && echo a\necho b")).toBe("echo a\necho b");
	});
});

describe("syntax highlighting", () => {
	it("reuses highlighted output across unchanged historical tool renders", () => {
		const highlight = vi.spyOn(hljs, "highlight");
		const renderer = getToolRenderer("read")!;
		const toolResult = {
			role: "toolResult" as const,
			isError: false,
			content: [{ type: "text" as const, text: "const profileCacheSentinel = 8760520;" }],
			toolCallId: "cache-test",
			toolName: "read",
			timestamp: Date.now(),
		};

		renderer.render({ path: "/tmp/profile-cache-test.ts" }, toolResult, false);
		renderer.render({ path: "/tmp/profile-cache-test.ts" }, toolResult, false);

		expect(highlight).toHaveBeenCalledTimes(1);
	});

	it("does not repeatedly highlight tool output while it is streaming", () => {
		const highlight = vi.spyOn(hljs, "highlight");
		const renderer = getToolRenderer("read")!;
		const toolResult = {
			role: "toolResult" as const,
			isError: false,
			content: [{ type: "text" as const, text: "const streamingProfileSentinel = 1;" }],
			toolCallId: "streaming-highlight-test",
			toolName: "read",
			timestamp: Date.now(),
		};

		renderer.render({ path: "/tmp/streaming-profile-test.ts" }, toolResult, true);

		expect(highlight).not.toHaveBeenCalled();
	});

	it("leaves very large outputs as plain text", () => {
		const highlight = vi.spyOn(hljs, "highlight");
		const renderer = getToolRenderer("read")!;
		const toolResult = {
			role: "toolResult" as const,
			isError: false,
			content: [{ type: "text" as const, text: "x".repeat(100_001) }],
			toolCallId: "large-highlight-test",
			toolName: "read",
			timestamp: Date.now(),
		};

		renderer.render({ path: "/tmp/large-profile-test.ts" }, toolResult, false);

		expect(highlight).not.toHaveBeenCalled();
	});
});

describe("streaming tool output scroll pin", () => {
	it("keeps a streaming Bash output detached when older Bash calls rerender", async () => {
		const renderer = getToolRenderer("bash")!;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const result = (id: string, text: string) => ({
			role: "toolResult" as const,
			isError: false,
			content: [{ type: "text" as const, text }],
			toolCallId: id,
			toolName: "bash",
			timestamp: Date.now(),
		});
		const renderCalls = (streamedText: string) => {
			const completed = renderer.render(
				{ command: "printf old" },
				result("completed-bash", "old output"),
				false,
			).content;
			const streaming = renderer.render(
				{ command: "stream output" },
				result("streaming-bash", streamedText),
				true,
			).content;
			renderTemplate(html`${completed}${streaming}`, container);
		};

		renderCalls("line 1");
		const outputs = container.querySelectorAll<HTMLElement>(".tool-body-scroll");
		expect(outputs).toHaveLength(2);
		const streamingOutput = outputs[1];
		Object.defineProperties(streamingOutput, {
			scrollHeight: { configurable: true, get: () => 500 },
			clientHeight: { configurable: true, get: () => 100 },
		});
		streamingOutput.scrollTop = 400;
		streamingOutput.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
		// Model the wheel's default movement before the browser emits `scroll`;
		// a streamed mutation can arrive in this exact interval.
		streamingOutput.scrollTop = 40;

		renderCalls("line 1\nline 2");
		await Promise.resolve();
		await Promise.resolve();

		expect(streamingOutput.textContent).toContain("line 2");
		expect(streamingOutput.scrollTop).toBe(40);
		renderTemplate(null, container);
	});
});

describe("generic fallback renderer", () => {
	it("inlines complete primitive parameters with readable spacing", () => {
		const container = document.createElement("div");
		const toolResult = {
			role: "toolResult" as const,
			isError: false,
			content: [{ type: "text" as const, text: "file contents" }],
			toolCallId: "generic-inline",
			toolName: "hypa_read",
			timestamp: Date.now(),
		};
		const rendered = renderTool("hypa_read", {
			path: "tests/test_tool_ingestion.py",
			offset: 1,
			limit: 180,
			maxTokens: 10_000,
		}, toolResult, false);

		renderTemplate(rendered.content, container);

		expect(container.querySelector(".tool-header-label")?.textContent).toBe(
			'hypa_read(path: "tests/test_tool_ingestion.py", offset: 1, limit: 180, maxTokens: 10000)',
		);
		expect(container.querySelector(".tool-body-code")?.textContent).toBe("file contents");
		expect(container.querySelector(".tool-body-code")?.textContent).not.toContain('"path"');
	});

	it("keeps structured parameters in the formatted body", () => {
		const container = document.createElement("div");
		const rendered = renderTool("batch_tool", { edits: [{ path: "a.ts", value: 1 }] }, undefined, false);

		renderTemplate(rendered.content, container);

		expect(container.querySelector(".tool-header-label")?.textContent).toBe("batch_tool(edits)");
		expect(container.querySelector(".tool-body-code")?.textContent).toContain('\n  "edits": [\n');
		expect(container.querySelector(".tool-body-code")?.textContent).toContain('    "path": "a.ts"');
	});
});

describe("BashRenderer override", () => {
	it("strips single-line bash command from main text", () => {
		expect(formatBashMainText("echo hello")).toBe("");
		expect(formatBashMainText("  ls -la  ")).toBe("");
	});

	it("keeps multiline bash command in main text for tool visualization", () => {
		const multi = "npm run build\nnpm run test";
		expect(formatBashMainText(multi)).toBe(multi);
	});

	it("keeps explicit visualization marker text", () => {
		const cmd = "# tool visualization\necho hello";
		expect(formatBashMainText(cmd)).toBe(cmd);
	});

	it("registers a custom bash renderer that overrides the built-in", () => {
		const renderer = getToolRenderer("bash");
		expect(renderer).toBeDefined();
		// The built-in BashRenderer uses isCustom: false; ours uses true
		const result = renderer!.render({ command: "echo hello" }, undefined, false);
		expect(result.isCustom).toBe(true);
	});

	it("renders with isCustom: true when in-progress (no outer card wrapper)", () => {
		const renderer = getToolRenderer("bash")!;
		const result = renderer.render({ command: "ls -la" }, undefined, true);
		expect(result.isCustom).toBe(true);
		expect(result.content).toBeDefined();
	});

	it("renders with isCustom: true when complete with result", () => {
		const renderer = getToolRenderer("bash")!;
		const toolResult = {
			role: "toolResult" as const,
			isError: false,
			content: [{ type: "text" as const, text: "file1.txt\nfile2.txt" }],
			toolCallId: "test-id",
			toolName: "bash",
			timestamp: Date.now(),
		};
		const result = renderer.render({ command: "ls" }, toolResult, false);
		expect(result.isCustom).toBe(true);
	});

	it("renders with isCustom: true on error result", () => {
		const renderer = getToolRenderer("bash")!;
		const toolResult = {
			role: "toolResult" as const,
			isError: true,
			content: [{ type: "text" as const, text: "command not found" }],
			toolCallId: "test-id",
			toolName: "bash",
			timestamp: Date.now(),
		};
		const result = renderer.render({ command: "badcmd" }, toolResult, false);
		expect(result.isCustom).toBe(true);
	});

	it("handles string params (JSON-encoded)", () => {
		const renderer = getToolRenderer("bash")!;
		const result = renderer.render(JSON.stringify({ command: "pwd" }), undefined, false);
		expect(result.isCustom).toBe(true);
	});

	it("handles missing/empty params gracefully", () => {
		const renderer = getToolRenderer("bash")!;
		const result = renderer.render(undefined, undefined, false);
		expect(result.isCustom).toBe(true);
	});
});

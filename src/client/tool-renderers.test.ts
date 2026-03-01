/**
 * Tests for custom tool renderers.
 *
 * Verifies that registerCodingAgentRenderers() overrides the built-in
 * bash renderer from the UI library with our custom one (no outer card frame,
 * icon/spinner in console header, isCustom: true).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getToolRenderer } from "@mariozechner/pi-web-ui";
import { formatBashMainText, stripCdPrefix, registerCodingAgentRenderers } from "./tool-renderers.js";

// Ensure custom renderers are registered (overriding built-ins)
registerCodingAgentRenderers();

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

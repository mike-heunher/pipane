/**
 * Tests for custom tool renderers.
 *
 * Verifies that registerCodingAgentRenderers() overrides the built-in
 * bash renderer from pi-web-ui with our custom one (no outer card frame,
 * icon/spinner in console header, isCustom: true).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getToolRenderer } from "@mariozechner/pi-web-ui";
import { registerCodingAgentRenderers } from "./tool-renderers.js";

// Ensure custom renderers are registered (overriding built-ins)
registerCodingAgentRenderers();

describe("BashRenderer override", () => {
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

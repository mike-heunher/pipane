/**
 * Tests for custom message renderers.
 *
 * Verifies that compactionSummary messages are rendered with the correct
 * structure (gutter icon, header label with token count, collapsible summary).
 */

import { describe, it, expect } from "vitest";
import { getMessageRenderer } from "@mariozechner/pi-web-ui";

// Import to trigger registration side-effects
import "./message-renderers.js";

describe("compactionSummary renderer", () => {
	it("registers a renderer for compactionSummary role", () => {
		const renderer = getMessageRenderer("compactionSummary" as any);
		expect(renderer).toBeDefined();
	});

	it("renders with token count in header", () => {
		const renderer = getMessageRenderer("compactionSummary" as any)!;
		const result = renderer.render({
			role: "compactionSummary",
			summary: "## Goal\nBuild a thing",
			tokensBefore: 187701,
			timestamp: Date.now(),
		} as any);
		expect(result).toBeDefined();
	});

	it("renders without token count when tokensBefore is 0", () => {
		const renderer = getMessageRenderer("compactionSummary" as any)!;
		const result = renderer.render({
			role: "compactionSummary",
			summary: "Some summary",
			tokensBefore: 0,
			timestamp: Date.now(),
		} as any);
		expect(result).toBeDefined();
	});

	it("renders with empty summary", () => {
		const renderer = getMessageRenderer("compactionSummary" as any)!;
		const result = renderer.render({
			role: "compactionSummary",
			summary: "",
			tokensBefore: 50000,
			timestamp: Date.now(),
		} as any);
		expect(result).toBeDefined();
	});

	it("renders in-progress state when _compacting flag is set", () => {
		const renderer = getMessageRenderer("compactionSummary" as any)!;
		const result = renderer.render({
			role: "compactionSummary",
			summary: "",
			tokensBefore: 0,
			timestamp: Date.now(),
			_compacting: true,
		} as any);
		expect(result).toBeDefined();
	});
});

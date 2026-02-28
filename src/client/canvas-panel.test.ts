/**
 * Tests for the canvas side panel.
 *
 * Verifies that the canvas auto-opens only once per canvas tool call,
 * and does not reopen on subsequent re-renders or session switches
 * after the user has already seen it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	showCanvas,
	isCanvasVisible,
	restoreCanvasFromMessages,
	canvasKey,
	markCanvasOpened,
	resetCanvasTracking,
	initCanvas,
} from "./canvas-panel.js";

/** Build a minimal canvas toolResult message. */
function canvasToolResult(title: string, markdown: string) {
	return {
		role: "toolResult",
		toolName: "canvas",
		details: { title, markdown },
	};
}

describe("canvas-panel", () => {
	beforeEach(() => {
		// Reset module state between tests
		resetCanvasTracking();
		// Init with a dummy container so renderPanel doesn't blow up
		const el = document.createElement("div");
		initCanvas(el, () => {});
		// Ensure canvas starts closed
		if (isCanvasVisible()) {
			// close by showing then we need to manage state — just ensure fresh
		}
	});

	it("showCanvas makes the panel visible", () => {
		showCanvas("Test", "# Hello");
		expect(isCanvasVisible()).toBe(true);
	});

	it("restoreCanvasFromMessages opens canvas for the last canvas tool result", () => {
		const messages = [
			{ role: "user", content: "hi" },
			canvasToolResult("My Doc", "# Content"),
		];
		restoreCanvasFromMessages(messages, "/sessions/test.jsonl");
		expect(isCanvasVisible()).toBe(true);
	});

	it("restoreCanvasFromMessages does NOT reopen canvas on subsequent calls (same session)", () => {
		const messages = [
			{ role: "user", content: "hi" },
			canvasToolResult("My Doc", "# Content"),
		];

		// First call: opens canvas
		restoreCanvasFromMessages(messages, "/sessions/test.jsonl");
		expect(isCanvasVisible()).toBe(true);

		// User closes canvas (simulate by calling showCanvas then checking)
		// We need a close mechanism — showCanvas sets visible=true,
		// but closeCanvas is private. Let's just check the dedup: call restore
		// again and verify it doesn't call showCanvas a second time.
		// Actually, the real test: the key is now tracked, so a second call is a no-op.
		// Let's verify by closing the canvas first.

		// Hack: restore with no canvas messages to close
		restoreCanvasFromMessages([], "/sessions/test.jsonl");
		expect(isCanvasVisible()).toBe(false);

		// Now call restore again with the same messages — should NOT reopen
		restoreCanvasFromMessages(messages, "/sessions/test.jsonl");
		expect(isCanvasVisible()).toBe(false);
	});

	it("canvas does NOT reopen after session switch (tracking persists)", () => {
		const sessionFile = "/sessions/session-with-canvas.jsonl";
		const messages = [
			{ role: "user", content: "show me a doc" },
			canvasToolResult("My Doc", "# Important content"),
		];

		// 1. First load: canvas auto-opens (correct)
		restoreCanvasFromMessages(messages, sessionFile);
		expect(isCanvasVisible()).toBe(true);

		// 2. User closes the canvas
		restoreCanvasFromMessages([], sessionFile);
		expect(isCanvasVisible()).toBe(false);

		// 3. Simulate session switch — tracking is NOT reset (fix: main.ts
		//    no longer calls resetCanvasTracking on session change)

		// 4. User switches back — server pushes session_messages, triggering
		//    restoreCanvasFromMessages via onContentChange
		restoreCanvasFromMessages(messages, sessionFile);

		// Canvas stays closed because tracking persists across session switches
		expect(isCanvasVisible()).toBe(false);
	});
});

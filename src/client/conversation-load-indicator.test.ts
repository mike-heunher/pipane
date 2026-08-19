import { render } from "lit";
import { describe, expect, it } from "vitest";
import { conversationLoadPercent, renderConversationLoadIndicator } from "./conversation-load-indicator.js";

const progress = {
	sessionPath: "/sessions/slow.jsonl",
	phase: "receiving" as const,
	receivedChunks: 3,
	totalChunks: 8,
};

describe("conversation load indicator", () => {
	it("renders determinate backend streaming progress", () => {
		const container = document.createElement("div");
		render(renderConversationLoadIndicator(progress), container);

		expect(container.textContent).toContain("Streaming conversation from backend");
		expect(container.textContent).toContain("38%");
		expect(container.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("38");
		expect(container.querySelector<HTMLElement>(".conversation-load-bar")?.style.width).toBe("38%");
	});

	it("uses an indeterminate bar while waiting or processing", () => {
		const container = document.createElement("div");
		render(renderConversationLoadIndicator({ ...progress, phase: "waiting", totalChunks: undefined }), container);
		expect(container.textContent).toContain("Waiting for conversation from backend");
		expect(container.querySelector("[role=progressbar]")?.hasAttribute("aria-valuenow")).toBe(false);
		expect(container.querySelector(".conversation-load-track")?.classList.contains("is-indeterminate")).toBe(true);

		render(renderConversationLoadIndicator({ ...progress, phase: "processing" }), container);
		expect(container.textContent).toContain("Preparing streamed conversation");
	});

	it("clamps malformed progress and renders nothing without an active transfer", () => {
		expect(conversationLoadPercent({ ...progress, receivedChunks: 20 })).toBe(100);
		expect(conversationLoadPercent({ ...progress, receivedChunks: -1 })).toBe(0);
		expect(conversationLoadPercent({ ...progress, totalChunks: 0 })).toBeUndefined();

		const container = document.createElement("div");
		render(renderConversationLoadIndicator(undefined), container);
		expect(container.childElementCount).toBe(0);
	});
});

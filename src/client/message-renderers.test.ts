import { afterEach, describe, expect, it } from "vitest";
import { render as renderTemplate } from "lit";
import { getMessageRenderer } from "./ui/message-registry.js";

// Import the one local message renderer registration path.
import "./ui/message-renderers.js";

function renderCompaction(message: Record<string, unknown>): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const renderer = getMessageRenderer("compactionSummary" as any)!;
	renderTemplate(renderer.render({ role: "compactionSummary", ...message } as any), container);
	return container;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("compactionSummary renderer", () => {
	it("registers a renderer for compactionSummary role", () => {
		expect(getMessageRenderer("compactionSummary" as any)).toBeDefined();
	});

	it("renders a completed compaction as an expandable timeline event", () => {
		const container = renderCompaction({
			summary: "## Goal\nBuild a thing",
			tokensBefore: 187701,
			timestamp: Date.now(),
		});

		const details = container.querySelector<HTMLDetailsElement>(".compaction-details")!;
		const header = details.querySelector<HTMLElement>("summary")!;
		expect(details.open).toBe(false);
		expect(container.querySelector(".compaction-title")?.textContent).toBe("Conversation compacted");
		expect(container.querySelector(".compaction-meta")?.textContent).toBe("188k tokens summarized");
		expect(header.title).toBe("187,701 tokens summarized");
		expect(header.getAttribute("aria-label")).toContain("View compaction summary");
		expect((container.querySelector("markdown-block") as any).content).toBe("## Goal\nBuild a thing");

		header.click();
		expect(details.open).toBe(true);
	});

	it("renders completed state without a disclosure when no summary is available", () => {
		const container = renderCompaction({
			summary: "",
			tokensBefore: 0,
			timestamp: Date.now(),
		});

		expect(container.querySelector(".compaction-event.is-complete")).not.toBeNull();
		expect(container.querySelector(".compaction-meta")?.textContent).toBe("Context summarized");
		expect(container.querySelector("details")).toBeNull();
	});

	it("renders a clear in-progress state", () => {
		const container = renderCompaction({
			summary: "",
			tokensBefore: 0,
			timestamp: Date.now(),
			_compacting: true,
		});

		const event = container.querySelector(".compaction-event.is-running")!;
		expect(event.getAttribute("role")).toBe("status");
		expect(event.textContent).toContain("Compacting conversation");
		expect(event.textContent).toContain("This may take a few minutes");
		expect(container.querySelector("details")).toBeNull();
	});
});

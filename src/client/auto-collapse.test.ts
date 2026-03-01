/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAutoCollapseKeepOpen, resetAutoCollapse, runAutoCollapse, notifyToolToggled } from "./auto-collapse.js";

function createToolMessage(id: string, completed: boolean): HTMLElement {
	const tm = document.createElement("tool-message");
	tm.setAttribute("data-tool-call-id", id);

	const wrap = document.createElement("div");
	wrap.className = "tool-gutter-wrap";

	const chevron = document.createElement("span");
	chevron.className = "tool-chevron";
	chevron.style.transform = "rotate(90deg)";
	wrap.appendChild(chevron);

	const threadLine = document.createElement("div");
	threadLine.className = "tool-thread-line";
	wrap.appendChild(threadLine);

	if (!completed) {
		const spinner = document.createElement("span");
		spinner.className = "animate-spin";
		wrap.appendChild(spinner);
	}

	const body = document.createElement("div");
	body.className = "tool-body-collapsible";
	body.textContent = "tool output";
	wrap.appendChild(body);

	tm.appendChild(wrap);
	return tm;
}

describe("auto-collapse", () => {
	let container: HTMLElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		resetAutoCollapse();
	});

	afterEach(() => {
		container.remove();
		setAutoCollapseKeepOpen(999999);
	});

	it("does nothing when keepOpen is 999999 (disabled)", () => {
		setAutoCollapseKeepOpen(999999);
		for (let i = 0; i < 10; i++) {
			container.appendChild(createToolMessage(`t${i}`, true));
		}
		runAutoCollapse();

		const bodies = container.querySelectorAll(".tool-body-collapsible");
		for (const body of bodies) {
			expect((body as HTMLElement).style.display).not.toBe("none");
		}
	});

	it("collapses all completed tools when keepOpen is 0", () => {
		setAutoCollapseKeepOpen(0);
		for (let i = 0; i < 3; i++) {
			container.appendChild(createToolMessage(`t${i}`, true));
		}
		runAutoCollapse();

		const bodies = container.querySelectorAll(".tool-body-collapsible");
		for (const body of bodies) {
			expect((body as HTMLElement).style.display).toBe("none");
		}
	});

	it("keeps the last N completed tools open", () => {
		setAutoCollapseKeepOpen(2);
		for (let i = 0; i < 5; i++) {
			container.appendChild(createToolMessage(`t${i}`, true));
		}
		runAutoCollapse();

		const messages = container.querySelectorAll("tool-message");
		// First 3 should be collapsed
		for (let i = 0; i < 3; i++) {
			const body = messages[i].querySelector(".tool-body-collapsible") as HTMLElement;
			expect(body.style.display).toBe("none");
		}
		// Last 2 should be open
		for (let i = 3; i < 5; i++) {
			const body = messages[i].querySelector(".tool-body-collapsible") as HTMLElement;
			expect(body.style.display).not.toBe("none");
		}
	});

	it("does not collapse in-progress tools", () => {
		setAutoCollapseKeepOpen(1);
		container.appendChild(createToolMessage("t0", true));
		container.appendChild(createToolMessage("t1", false)); // in progress
		container.appendChild(createToolMessage("t2", true));
		runAutoCollapse();

		const messages = container.querySelectorAll("tool-message");
		// t0 should be collapsed (oldest completed, only 1 kept open)
		expect((messages[0].querySelector(".tool-body-collapsible") as HTMLElement).style.display).toBe("none");
		// t1 is in-progress, should not be collapsed
		expect((messages[1].querySelector(".tool-body-collapsible") as HTMLElement).style.display).not.toBe("none");
		// t2 is the most recent completed, should stay open
		expect((messages[2].querySelector(".tool-body-collapsible") as HTMLElement).style.display).not.toBe("none");
	});

	it("does not re-collapse a tool the user manually opened", () => {
		setAutoCollapseKeepOpen(1);
		container.appendChild(createToolMessage("t0", true));
		container.appendChild(createToolMessage("t1", true));
		container.appendChild(createToolMessage("t2", true));
		runAutoCollapse();

		// t0 and t1 should be collapsed
		const messages = container.querySelectorAll("tool-message");
		expect((messages[0].querySelector(".tool-body-collapsible") as HTMLElement).style.display).toBe("none");
		expect((messages[1].querySelector(".tool-body-collapsible") as HTMLElement).style.display).toBe("none");

		// Simulate user opening t0
		const body0 = messages[0].querySelector(".tool-body-collapsible") as HTMLElement;
		body0.style.display = ""; // user opens it
		const wrap0 = messages[0].querySelector(".tool-gutter-wrap")!;
		notifyToolToggled(wrap0);

		// Add another completed tool — this triggers re-evaluation
		container.appendChild(createToolMessage("t3", true));
		runAutoCollapse();

		// t0 should stay open (user opened it)
		expect(body0.style.display).not.toBe("none");
		// t1 and t2 should be collapsed (only t3 stays open as most recent)
		expect((messages[1].querySelector(".tool-body-collapsible") as HTMLElement).style.display).toBe("none");
		expect((messages[2].querySelector(".tool-body-collapsible") as HTMLElement).style.display).toBe("none");
	});

	it("collapses thread line and resets chevron", () => {
		setAutoCollapseKeepOpen(0);
		container.appendChild(createToolMessage("t0", true));
		runAutoCollapse();

		const wrap = container.querySelector(".tool-gutter-wrap")!;
		const threadLine = wrap.querySelector(".tool-thread-line") as HTMLElement;
		const chevron = wrap.querySelector(".tool-chevron") as HTMLElement;

		expect(threadLine.style.display).toBe("none");
		expect(chevron.style.transform).toBe("");
	});

	it("only runs when new tools complete (not on every render)", () => {
		setAutoCollapseKeepOpen(1);
		container.appendChild(createToolMessage("t0", true));
		container.appendChild(createToolMessage("t1", true));
		runAutoCollapse();

		// t0 collapsed
		const body0 = container.querySelector("tool-message:first-child .tool-body-collapsible") as HTMLElement;
		expect(body0.style.display).toBe("none");

		// Simulate user opening t0
		body0.style.display = "";
		notifyToolToggled(container.querySelector("tool-message:first-child .tool-gutter-wrap")!);

		// Re-run without new completions — should not re-collapse t0
		runAutoCollapse();
		expect(body0.style.display).not.toBe("none");
	});

	it("resets state on resetAutoCollapse", () => {
		setAutoCollapseKeepOpen(0);
		container.appendChild(createToolMessage("t0", true));
		runAutoCollapse();

		const body0 = container.querySelector(".tool-body-collapsible") as HTMLElement;
		expect(body0.style.display).toBe("none");

		// Reset and manually reopen
		body0.style.display = "";
		resetAutoCollapse();

		// After reset, running again should re-collapse (fresh state)
		runAutoCollapse();
		expect(body0.style.display).toBe("none");
	});
});

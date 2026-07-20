import { beforeEach, describe, expect, it } from "vitest";
import { contextUsageTone, dismissStatusDetailsOnOutsideClick } from "./status-usage.js";

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("context usage tone", () => {
	it("turns orange at 75% and red at 90%", () => {
		expect(contextUsageTone(0)).toBe("normal");
		expect(contextUsageTone(74)).toBe("normal");
		expect(contextUsageTone(75)).toBe("warning");
		expect(contextUsageTone(89)).toBe("warning");
		expect(contextUsageTone(90)).toBe("critical");
		expect(contextUsageTone(120)).toBe("critical");
	});
});

describe("status details dismissal", () => {
	function dispatchClick(target: Element): void {
		target.addEventListener("click", dismissStatusDetailsOnOutsideClick, { once: true });
		target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	}

	it("closes an open popover when clicking outside its metric", () => {
		document.body.innerHTML = `
			<details class="status-metric-details" open><summary>Context</summary><div>Details</div></details>
			<button>Outside</button>
		`;
		const details = document.querySelector("details") as HTMLDetailsElement;
		const outside = document.querySelector("button")!;

		dispatchClick(outside);

		expect(details.open).toBe(false);
	});

	it("keeps the popover open when clicking inside its metric", () => {
		document.body.innerHTML = `
			<details class="status-metric-details" open><summary>Context</summary><div>Details</div></details>
		`;
		const details = document.querySelector("details") as HTMLDetailsElement;
		const popover = document.querySelector("details > div")!;

		dispatchClick(popover);

		expect(details.open).toBe(true);
	});
});

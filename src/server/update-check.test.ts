import { describe, it, expect } from "vitest";
import { compareSemver } from "./update-check.js";

describe("compareSemver", () => {
	it("returns 0 for equal versions", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	it("returns -1 when a < b (patch)", () => {
		expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
	});

	it("returns 1 when a > b (patch)", () => {
		expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
	});

	it("returns -1 when a < b (minor)", () => {
		expect(compareSemver("1.2.3", "1.3.0")).toBe(-1);
	});

	it("returns 1 when a > b (minor)", () => {
		expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
	});

	it("returns -1 when a < b (major)", () => {
		expect(compareSemver("1.9.9", "2.0.0")).toBe(-1);
	});

	it("returns 1 when a > b (major)", () => {
		expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
	});

	it("handles 0.x versions", () => {
		expect(compareSemver("0.1.0", "0.1.1")).toBe(-1);
		expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
	});
});

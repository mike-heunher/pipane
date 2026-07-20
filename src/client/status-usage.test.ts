import { describe, expect, it } from "vitest";
import { contextUsageTone } from "./status-usage.js";

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

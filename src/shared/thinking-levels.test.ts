import { describe, expect, it } from "vitest";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	modelsMatch,
	toCompactModelRef,
} from "./thinking-levels.js";

describe("thinking level capabilities", () => {
	it("supports only off for non-reasoning models", () => {
		expect(getSupportedThinkingLevels({
			reasoning: false,
			thinkingLevelMap: { high: "high", max: "max" },
		})).toEqual(["off"]);
	});

	it("supports standard levels for reasoning models without a map", () => {
		expect(getSupportedThinkingLevels({ reasoning: true })).toEqual([
			"off", "minimal", "low", "medium", "high",
		]);
	});

	it("honors standard-level holes and opt-in extended levels", () => {
		expect(getSupportedThinkingLevels({
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				low: null,
				xhigh: "xhigh",
				max: null,
			},
		})).toEqual(["minimal", "medium", "high", "xhigh"]);
	});

	it("treats a thinking map as reasoning capability for older metadata", () => {
		expect(getSupportedThinkingLevels({
			thinkingLevelMap: { off: null, high: "high" },
		})).toEqual(["minimal", "low", "medium", "high"]);
	});

	it("clamps upward before downward like pi", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				xhigh: null,
				max: "max",
			},
		};
		expect(clampThinkingLevel(model, "minimal")).toBe("high");
		expect(clampThinkingLevel(model, "xhigh")).toBe("max");
	});

	it("clamps down when no higher level is supported", () => {
		expect(clampThinkingLevel({ reasoning: true }, "max")).toBe("high");
	});

	it("normalizes and compares full and compact model refs", () => {
		const full = { provider: "openai", id: "gpt-5" };
		const compact = { provider: "openai", modelId: "gpt-5" };
		expect(modelsMatch(full, compact)).toBe(true);
		expect(toCompactModelRef(full)).toEqual(compact);
	});
});

import { describe, it, expect } from "vitest";
import { computeTokenUsageParts, Message } from "./token-usage.js";

describe("computeTokenUsageParts", () => {
	it("returns null parts for empty messages (cache signal)", () => {
		expect(computeTokenUsageParts([], 200000)).toEqual({ parts: null });
	});

	it("returns empty parts when messages exist but have no usage", () => {
		const msgs: Message[] = [{ role: "user" }, { role: "assistant" }];
		expect(computeTokenUsageParts(msgs, 200000)).toEqual({ parts: [] });
	});

	it("shows percentage when totalTokens is present", () => {
		const msgs: Message[] = [
			{ role: "user" },
			{ role: "assistant", usage: { input: 5000, output: 1000, totalTokens: 6000 } },
		];
		const result = computeTokenUsageParts(msgs, 200000);
		expect(result.parts).toContain("↑3%/200k");
		expect(result.parts).toContain("↓1.0k");
	});

	it("shows percentage when totalTokens is absent (falls back to input+output)", () => {
		const msgs: Message[] = [
			{ role: "user" },
			{ role: "assistant", usage: { input: 50000, output: 10000 } },
		];
		const result = computeTokenUsageParts(msgs, 200000);
		// (50000+10000)/200000 = 30%
		expect(result.parts).toContain("↑30%/200k");
	});

	it("shows percentage even after user/tool messages follow the last assistant", () => {
		const msgs: Message[] = [
			{ role: "user" },
			{ role: "assistant", usage: { input: 10000, output: 2000, totalTokens: 12000 } },
			{ role: "user" },
			{ role: "tool", usage: undefined },
		];
		const result = computeTokenUsageParts(msgs, 200000);
		expect(result.parts![0]).toBe("↑6%/200k");
	});

	it("shows percentage with multiple assistant turns (uses last)", () => {
		const msgs: Message[] = [
			{ role: "assistant", usage: { input: 5000, output: 1000, totalTokens: 6000 } },
			{ role: "user" },
			{ role: "assistant", usage: { input: 20000, output: 3000 } }, // no totalTokens
			{ role: "user" },
		];
		const result = computeTokenUsageParts(msgs, 200000);
		// last assistant: (20000+3000)/200000 = 12%
		expect(result.parts![0]).toBe("↑12%/200k");
		// output is cumulative: 1000+3000 = 4000
		expect(result.parts).toContain("↓4.0k");
	});

	it("falls back to cumulative input when no contextWindow", () => {
		const msgs: Message[] = [
			{ role: "assistant", usage: { input: 5000, output: 1000 } },
		];
		const result = computeTokenUsageParts(msgs, undefined);
		expect(result.parts![0]).toBe("↑5.0k");
	});

	it("shows cost", () => {
		const msgs: Message[] = [
			{ role: "assistant", usage: { input: 1000, output: 500, cost: { total: 0.0523 } } },
		];
		const result = computeTokenUsageParts(msgs, undefined);
		expect(result.parts).toContain("$0.052");
	});

	it("handles inputTokens/outputTokens field names", () => {
		const msgs: Message[] = [
			{ role: "assistant", usage: { inputTokens: 40000, outputTokens: 10000 } },
		];
		const result = computeTokenUsageParts(msgs, 200000);
		// (40000+10000)/200000 = 25%
		expect(result.parts![0]).toBe("↑25%/200k");
	});
});

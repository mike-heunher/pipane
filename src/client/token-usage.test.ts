import { describe, expect, it } from "vitest";
import { computeTokenUsageSummary, type TokenUsageMessage } from "./token-usage.js";

describe("computeTokenUsageSummary", () => {
	it("signals callers to retain the cache while messages are empty", () => {
		expect(computeTokenUsageSummary([], 200_000)).toBeNull();
	});

	it("clears the summary when a non-empty conversation has no usage", () => {
		const messages: TokenUsageMessage[] = [{ role: "user" }, { role: "assistant" }];
		expect(computeTokenUsageSummary(messages, 200_000)).toBeUndefined();
	});

	it("aggregates token fields and formats session cost", () => {
		const messages: TokenUsageMessage[] = [
			{ role: "assistant", usage: { input: 5_000, output: 1_000, cost: { total: 0.002 } } },
			{ role: "assistant", usage: { inputTokens: 20_000, outputTokens: 3_000, totalCost: 0.05 } },
		];

		const summary = computeTokenUsageSummary(messages);
		expect(summary).toMatchObject({
			input: 25_000,
			output: 4_000,
			costLabel: "$0.052",
		});
		expect(summary?.cost).toBeCloseTo(0.052);
	});

	it("uses the last assistant turn for context usage", () => {
		const messages: TokenUsageMessage[] = [
			{ role: "assistant", usage: { input: 5_000, output: 1_000, totalTokens: 6_000 } },
			{ role: "user" },
			{ role: "assistant", usage: { input: 20_000, output: 3_000, totalTokens: 24_000 } },
			{ role: "toolResult" },
		];

		expect(computeTokenUsageSummary(messages, 200_000)).toMatchObject({
			contextPercent: 12,
			contextWindowLabel: "200k",
		});
	});

	it("falls back to input plus output when totalTokens is absent", () => {
		const messages: TokenUsageMessage[] = [
			{ role: "assistant", usage: { inputTokens: 40_000, outputTokens: 10_000 } },
		];

		expect(computeTokenUsageSummary(messages, 200_000)?.contextPercent).toBe(25);
	});

	it("keeps compact formatting for smaller context windows and tiny costs", () => {
		const messages: TokenUsageMessage[] = [
			{ role: "assistant", usage: { input: 1_000, output: 500, cost: { total: 0.0004 } } },
		];

		expect(computeTokenUsageSummary(messages, 8_000)).toMatchObject({
			costLabel: "$0.0004",
			contextWindowLabel: "8.0k",
		});
	});
});

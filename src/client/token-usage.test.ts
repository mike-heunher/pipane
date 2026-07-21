import { describe, expect, it } from "vitest";
import { computeTokenUsageSummary, type TokenUsageMessage } from "./token-usage.js";

describe("computeTokenUsageSummary", () => {
	it("keeps context usage visible at zero before the first response", () => {
		expect(computeTokenUsageSummary([], 200_000)).toMatchObject({
			input: 0,
			output: 0,
			cost: 0,
			contextPercent: 0,
			contextWindowLabel: "200k",
		});

		const messages: TokenUsageMessage[] = [{ role: "user" }, { role: "assistant" }];
		expect(computeTokenUsageSummary(messages, 200_000)?.contextPercent).toBe(0);
	});

	it("has no displayable summary without usage or a context window", () => {
		expect(computeTokenUsageSummary([])).toBeUndefined();
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

	it("uses the last valid assistant turn for context usage", () => {
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

	it("keeps the last valid context value while an all-zero response is in flight", () => {
		const messages: TokenUsageMessage[] = [
			{ role: "assistant", usage: { input: 140_000, output: 12_000, totalTokens: 152_000 } },
			{ role: "toolResult" },
			{
				role: "assistant",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			},
		];

		expect(computeTokenUsageSummary(messages, 200_000)?.contextPercent).toBe(76);
	});

	it("ignores persisted aborted and failed usage placeholders", () => {
		const messages: TokenUsageMessage[] = [
			{ role: "assistant", usage: { input: 40_000, output: 10_000, totalTokens: 50_000 } },
			{ role: "assistant", stopReason: "aborted", usage: { input: 60_000, output: 5_000, totalTokens: 65_000 } },
			{ role: "assistant", stopReason: "error", usage: { input: 80_000, output: 5_000, totalTokens: 85_000 } },
		];

		expect(computeTokenUsageSummary(messages, 200_000)?.contextPercent).toBe(25);
	});

	it("keeps context visible but unknown after compaction until the next valid response", () => {
		const compacted: TokenUsageMessage[] = [
			{ role: "assistant", usage: { input: 140_000, output: 10_000, totalTokens: 150_000 } },
			{ role: "compactionSummary" },
			{ role: "user" },
			{ role: "assistant", usage: { input: 0, output: 0, totalTokens: 0 } },
		];
		expect(computeTokenUsageSummary(compacted, 200_000)?.contextPercent).toBeNull();

		compacted.push({
			role: "assistant",
			usage: { input: 20_000, output: 2_000, totalTokens: 22_000 },
		});
		expect(computeTokenUsageSummary(compacted, 200_000)?.contextPercent).toBe(11);
	});

	it("falls back to all token components when totalTokens is absent or zero", () => {
		const messages: TokenUsageMessage[] = [
			{
				role: "assistant",
				usage: {
					inputTokens: 10_000,
					outputTokens: 10_000,
					cacheRead: 20_000,
					cacheWrite: 10_000,
					totalTokens: 0,
				},
			},
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

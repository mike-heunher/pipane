/** Pure token-usage aggregation for the conversation status bar. */

export interface UsageInfo {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
	totalCost?: number;
}

export interface TokenUsageMessage {
	role: string;
	usage?: UsageInfo;
}

export interface TokenUsageSummary {
	input: number;
	output: number;
	cost: number;
	costLabel: string;
	contextPercent?: number;
	contextWindowLabel?: string;
}

function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.round(count / 1_000)}k`;
}

function formatCost(cost: number): string {
	return `$${cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

/**
 * Compute the status-bar summary.
 *
 * `null` means the message list is temporarily empty and the caller should keep
 * its cached value. `undefined` means a non-empty conversation has no usage.
 */
export function computeTokenUsageSummary(
	messages: readonly TokenUsageMessage[],
	contextWindow?: number,
): TokenUsageSummary | null | undefined {
	if (messages.length === 0) return null;

	const totals = messages
		.filter((message) => message.role === "assistant")
		.reduce((result, message) => {
			const usage = message.usage;
			if (usage) {
				result.input += usage.input ?? usage.inputTokens ?? 0;
				result.output += usage.output ?? usage.outputTokens ?? 0;
				result.cacheRead += usage.cacheRead ?? 0;
				result.cacheWrite += usage.cacheWrite ?? 0;
				result.cost += usage.cost?.total ?? usage.totalCost ?? 0;
			}
			return result;
		}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

	if (!(totals.input || totals.output || totals.cacheRead || totals.cacheWrite || totals.cost)) {
		return undefined;
	}

	let lastUsage: UsageInfo | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant" && message.usage) {
			lastUsage = message.usage;
			break;
		}
	}
	const lastTotal = lastUsage
		? lastUsage.totalTokens
			?? (lastUsage.input ?? lastUsage.inputTokens ?? 0)
				+ (lastUsage.output ?? lastUsage.outputTokens ?? 0)
		: 0;

	return {
		input: totals.input,
		output: totals.output,
		cost: totals.cost,
		costLabel: formatCost(totals.cost),
		contextPercent: lastTotal && contextWindow
			? Math.round((lastTotal / contextWindow) * 100)
			: undefined,
		contextWindowLabel: contextWindow ? formatTokenCount(contextWindow) : undefined,
	};
}

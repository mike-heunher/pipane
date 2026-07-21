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
	stopReason?: string;
}

export interface TokenUsageSummary {
	input: number;
	output: number;
	cost: number;
	costLabel: string;
	/** `null` means compaction made the current size unknown until the next response. */
	contextPercent?: number | null;
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

function contextTokens(usage: UsageInfo): number {
	if (usage.totalTokens && usage.totalTokens > 0) return usage.totalTokens;
	return (usage.input ?? usage.inputTokens ?? 0)
		+ (usage.output ?? usage.outputTokens ?? 0)
		+ (usage.cacheRead ?? 0)
		+ (usage.cacheWrite ?? 0);
}

function isValidContextUsage(message: TokenUsageMessage): message is TokenUsageMessage & { usage: UsageInfo } {
	return message.role === "assistant"
		&& message.stopReason !== "aborted"
		&& message.stopReason !== "error"
		&& message.usage !== undefined
		&& contextTokens(message.usage) > 0;
}

/**
 * Compute the status-bar summary.
 *
 * In-flight, aborted, and failed assistant messages carry an all-zero usage
 * object. Ignore those placeholders for context accounting so the last valid
 * value remains visible throughout a turn. When the model has a context window,
 * return a zero summary before its first response so the metric is always shown.
 */
export function computeTokenUsageSummary(
	messages: readonly TokenUsageMessage[],
	contextWindow?: number,
): TokenUsageSummary | undefined {
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

	const hasTotals = Boolean(totals.input || totals.output || totals.cacheRead || totals.cacheWrite || totals.cost);
	if (!hasTotals && !(contextWindow && contextWindow > 0)) return undefined;

	let lastContextTokens = 0;
	let latestCompactionIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "compactionSummary") {
			latestCompactionIndex = index;
			break;
		}
	}
	for (let index = messages.length - 1; index > latestCompactionIndex; index--) {
		const message = messages[index];
		if (isValidContextUsage(message)) {
			lastContextTokens = contextTokens(message.usage);
			break;
		}
	}
	const contextIsUnknown = latestCompactionIndex >= 0 && lastContextTokens === 0;

	return {
		input: totals.input,
		output: totals.output,
		cost: totals.cost,
		costLabel: formatCost(totals.cost),
		contextPercent: contextWindow && contextWindow > 0
			? contextIsUnknown
				? null
				: Math.round((lastContextTokens / contextWindow) * 100)
			: undefined,
		contextWindowLabel: contextWindow && contextWindow > 0 ? formatTokenCount(contextWindow) : undefined,
	};
}

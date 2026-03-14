/**
 * Pure logic for computing token usage display parts.
 * Extracted from main.ts to enable unit testing.
 */

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

export interface Message {
	role: string;
	usage?: UsageInfo;
}

export interface TokenUsageResult {
	/** null means "no data, keep showing cached value" */
	parts: string[] | null;
}

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

/**
 * Compute the display parts for token usage.
 * Returns { parts: null } when messages are empty (caller should use cached value).
 * Returns { parts: [] } when there's no usage data.
 * Returns { parts: [...] } with formatted strings otherwise.
 */
export function computeTokenUsageParts(messages: Message[], contextWindow?: number): TokenUsageResult {
	const totals = messages
		.filter((m) => m.role === "assistant")
		.reduce((acc, msg) => {
			const usage = msg.usage;
			if (usage) {
				acc.input += usage.input ?? usage.inputTokens ?? 0;
				acc.output += usage.output ?? usage.outputTokens ?? 0;
				acc.cacheRead += usage.cacheRead ?? 0;
				acc.cacheWrite += usage.cacheWrite ?? 0;
				acc.costTotal += usage.cost?.total ?? usage.totalCost ?? 0;
			}
			return acc;
		}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 });

	const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
	if (!hasTotals) {
		if (messages.length === 0) return { parts: null };
		return { parts: [] };
	}

	// Find the last assistant message with usage to get context size
	const assistantMsgs = messages.filter((m) => m.role === "assistant" && m.usage);
	const lastUsage = assistantMsgs.length ? assistantMsgs[assistantMsgs.length - 1].usage! : null;

	// totalTokens is the context window consumption for the last turn.
	// Fall back to input tokens (which represents the prompt/context sent) when totalTokens is absent.
	const lastTotal = lastUsage
		? (lastUsage.totalTokens ?? ((lastUsage.input ?? lastUsage.inputTokens ?? 0) + (lastUsage.output ?? lastUsage.outputTokens ?? 0)))
		: 0;

	const parts: string[] = [];
	if (lastTotal && contextWindow) {
		const pct = Math.round((lastTotal / contextWindow) * 100);
		parts.push(`↑${pct}%/${fmtTok(contextWindow)}`);
	} else if (totals.input) {
		parts.push(`↑${fmtTok(totals.input)}`);
	}
	if (totals.output) parts.push(`↓${fmtTok(totals.output)}`);
	if (totals.costTotal) parts.push(`$${totals.costTotal < 0.01 ? totals.costTotal.toFixed(4) : totals.costTotal < 1 ? totals.costTotal.toFixed(3) : totals.costTotal.toFixed(2)}`);

	return { parts };
}

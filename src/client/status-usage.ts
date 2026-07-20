export type ContextUsageTone = "normal" | "warning" | "critical";

/** Semantic context-window color threshold used by the conversation status bar. */
export function contextUsageTone(percent: number): ContextUsageTone {
	if (percent >= 90) return "critical";
	if (percent >= 75) return "warning";
	return "normal";
}

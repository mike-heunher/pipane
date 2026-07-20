export type ContextUsageTone = "normal" | "warning" | "critical";

/** Semantic context-window color threshold used by the conversation status bar. */
export function contextUsageTone(percent: number): ContextUsageTone {
	if (percent >= 90) return "critical";
	if (percent >= 75) return "warning";
	return "normal";
}

/** Close status detail popovers unless the click happened within that metric. */
export function dismissStatusDetailsOnOutsideClick(event: Event): void {
	const target = event.target;
	if (!(target instanceof Node)) return;

	for (const details of document.querySelectorAll<HTMLDetailsElement>(".status-metric-details[open]")) {
		if (!details.contains(target)) details.open = false;
	}
}

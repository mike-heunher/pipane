/**
 * Auto-collapse finished tool calls, keeping only the N most recent expanded.
 *
 * Behaviour:
 *  - `keepOpen` controls how many completed tool calls stay expanded.
 *  - Once a tool finishes, if there are more than `keepOpen` completed tools,
 *    the oldest ones are collapsed.
 *  - Auto-collapse happens once per tool: if the user manually re-opens a
 *    collapsed tool, it is never auto-collapsed again.
 *  - 999999 effectively disables auto-collapse.
 */

let keepOpen = 999999; // disabled by default until settings load
const userOpened = new Set<string>(); // tool call IDs opened by user after auto-collapse
const autoCollapsed = new Set<string>(); // tool call IDs that were auto-collapsed
let lastCompletedCount = 0;

export function setAutoCollapseKeepOpen(n: number) {
	keepOpen = n;
}

/**
 * Reset tracking state. Call on session switch.
 */
export function resetAutoCollapse() {
	userOpened.clear();
	autoCollapsed.clear();
	lastCompletedCount = 0;
}

/**
 * Mark a tool as user-opened when the user toggles open a previously
 * auto-collapsed tool. Called from handleToggle in tool-renderers.
 */
export function notifyToolToggled(wrapElement: Element) {
	const toolMsg = wrapElement.closest("tool-message");
	const id = toolMsg?.getAttribute("data-tool-call-id");
	if (!id) return;

	const body = wrapElement.querySelector(".tool-body-collapsible") as HTMLElement | null;
	// If the body is now visible (user just opened it) and it was auto-collapsed
	if (body && body.style.display !== "none" && autoCollapsed.has(id)) {
		userOpened.add(id);
	}
}

/**
 * Scan the DOM for completed tool calls and auto-collapse older ones.
 * Should be called after each render/content change.
 */
export function runAutoCollapse() {
	if (keepOpen >= 999999) return; // disabled

	// Find all tool-message elements with tool-gutter-wrap inside
	const toolMessages = document.querySelectorAll("tool-message[data-tool-call-id]");
	if (!toolMessages.length) return;

	// Collect completed tools (no spinner = finished)
	const completed: Array<{ id: string; wrap: Element }> = [];
	for (const tm of toolMessages) {
		const id = tm.getAttribute("data-tool-call-id")!;
		const wrap = tm.querySelector(".tool-gutter-wrap");
		if (!wrap) continue;
		const hasSpinner = wrap.querySelector(".animate-spin");
		if (!hasSpinner) {
			completed.push({ id, wrap });
		}
	}

	// Only act when new tools have completed
	if (completed.length <= lastCompletedCount) return;
	lastCompletedCount = completed.length;

	// Filter out user-opened tools from collapse candidates
	const candidates = completed.filter((t) => !userOpened.has(t.id));

	// Keep the last `keepOpen` candidates expanded, collapse the rest
	const toCollapse = candidates.slice(0, Math.max(0, candidates.length - keepOpen));

	for (const { id, wrap } of toCollapse) {
		if (autoCollapsed.has(id)) continue; // already collapsed

		const body = wrap.querySelector(".tool-body-collapsible") as HTMLElement | null;
		if (!body || body.style.display === "none") {
			// Already collapsed (e.g. no body), just track it
			autoCollapsed.add(id);
			continue;
		}

		body.style.display = "none";
		const threadLine = wrap.querySelector(".tool-thread-line") as HTMLElement | null;
		const chevron = wrap.querySelector(".tool-chevron") as HTMLElement | null;
		if (threadLine) threadLine.style.display = "none";
		if (chevron) chevron.style.transform = "";
		autoCollapsed.add(id);
	}
}

/**
 * Fetch the toolCollapse.keepOpen setting from the server and apply it.
 */
export async function loadAutoCollapseSettings(): Promise<void> {
	try {
		const res = await fetch("/api/settings/local");
		if (!res.ok) return;
		const data = await res.json();
		const ko = data?.settings?.toolCollapse?.keepOpen;
		if (typeof ko === "number" && Number.isFinite(ko) && ko >= 0) {
			keepOpen = ko;
		}
	} catch {
		// Ignore — keep default (disabled)
	}
}

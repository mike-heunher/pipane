export const STARTUP_MARK = {
	bootstrapStarted: "pipane:bootstrap-started",
	mainImportStarted: "pipane:main-import-started",
	runtimeConfigured: "pipane:runtime-configured",
	transportStarted: "pipane:transport-started",
	cachedSessionPainted: "pipane:cached-session-painted",
	mainInitialized: "pipane:main-initialized",
	shellPainted: "pipane:shell-painted",
	transportConnected: "pipane:transport-connected",
	sessionSelected: "pipane:session-selected",
	sessionSynchronized: "pipane:session-synchronized",
} as const;

export function markStartup(name: typeof STARTUP_MARK[keyof typeof STARTUP_MARK]): void {
	if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
	if (performance.getEntriesByName(name, "mark").length === 0) performance.mark(name);
}

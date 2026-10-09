import path from "node:path";

/** Custom Pi session entry written by `extensions/session-lineage.ts`. */
export const SESSION_LINEAGE_ENTRY_TYPE = "pipane-lineage";

/** Environment variable a launcher sets to the session file that delegated the work. */
export const PARENT_SESSION_ENV = "PIPANE_PARENT_SESSION";

export interface SessionLineage {
	/** Absolute session file of the conversation that launched this one. */
	parentSession?: string;
	/** Main-checkout project CWD recorded for a session started in a linked worktree. */
	projectCwd?: string;
	/** Linked worktree label recorded alongside `projectCwd`. */
	worktreeName?: string;
}

function absolutePath(value: unknown): string | undefined {
	return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : undefined;
}

/**
 * Read the first lineage marker in a session. Lineage describes how the
 * session started, so later markers (for example after a resume) never
 * replace it.
 */
export function readSessionLineage(entries: readonly any[]): SessionLineage | undefined {
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== SESSION_LINEAGE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") return undefined;
		const lineage: SessionLineage = {};
		const parentSession = absolutePath(data.parentSession);
		if (parentSession) lineage.parentSession = parentSession;
		const projectCwd = absolutePath(data.projectCwd);
		if (projectCwd) {
			lineage.projectCwd = projectCwd;
			const worktreeName = typeof data.worktreeName === "string" ? data.worktreeName.trim() : "";
			if (worktreeName && !/[\\/]/.test(worktreeName)) lineage.worktreeName = worktreeName;
		}
		return Object.keys(lineage).length > 0 ? lineage : undefined;
	}
	return undefined;
}

/**
 * Session lineage extension for pipane.
 *
 * Records once, when a session starts, which project and parent conversation
 * it belongs to. Pipane uses it to list sessions launched in linked Git
 * worktrees under their repository, and to nest delegated subagent sessions
 * below the conversation that launched them.
 *
 * Launchers opt into nesting by naming the parent session file. Pi's bash tool
 * exports PI_SESSION_FILE to every command, so a delegating agent can run:
 *
 *   PIPANE_PARENT_SESSION="$PI_SESSION_FILE" pi -p ...
 *
 * Install globally so every Pi process loads it:
 *
 *   cp extensions/session-lineage.ts ~/.pi/agent/extensions/pipane-session-lineage.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const SESSION_LINEAGE_ENTRY_TYPE = "pipane-lineage";
export const PARENT_SESSION_ENV = "PIPANE_PARENT_SESSION";

export interface SessionLineageData {
	version: 1;
	parentSession?: string;
	projectCwd?: string;
	worktreeName?: string;
}

function canonicalPath(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

/** Resolve a CWD inside a linked Git worktree to the same location in its main checkout. */
export function linkedWorktreeProject(cwd: string): { projectCwd: string; worktreeName: string } | undefined {
	let dir = canonicalPath(cwd);
	while (true) {
		const gitPath = path.join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				if (!statSync(gitPath).isFile()) return undefined;
				const marker = readFileSync(gitPath, "utf8").trim();
				if (!marker.startsWith("gitdir: ")) return undefined;
				const gitDir = path.resolve(dir, marker.slice("gitdir: ".length).trim());
				const commonDirMarker = path.join(gitDir, "commondir");
				if (!existsSync(commonDirMarker)) return undefined;
				const commonDir = canonicalPath(path.resolve(gitDir, readFileSync(commonDirMarker, "utf8").trim()));
				if (path.basename(commonDir) !== ".git") return undefined;
				const relative = path.relative(dir, canonicalPath(cwd));
				const mainRoot = path.dirname(commonDir);
				return {
					projectCwd: relative ? path.join(mainRoot, relative) : mainRoot,
					worktreeName: path.basename(dir),
				};
			} catch {
				return undefined;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function buildSessionLineage(options: {
	reason: string;
	cwd: string;
	sessionFile: string | undefined;
	env: Record<string, string | undefined>;
	entries: readonly any[];
}): SessionLineageData | undefined {
	const { entries, sessionFile } = options;
	if (!sessionFile) return undefined;
	if (entries.some((entry) => entry?.type === "custom" && entry.customType === SESSION_LINEAGE_ENTRY_TYPE)) return undefined;

	// The launcher's parent applies to the session the process starts with,
	// not to sessions later created or forked inside it.
	const requestedParent = options.reason === "startup" ? options.env[PARENT_SESSION_ENV]?.trim() : undefined;
	const parentSession = requestedParent && path.isAbsolute(requestedParent) && path.resolve(requestedParent) !== path.resolve(sessionFile)
		? path.resolve(requestedParent)
		: undefined;

	// Existing conversations are only annotated when explicitly resumed as delegated work.
	const hasConversation = entries.some((entry) => entry?.type === "message"
		&& (entry.message?.role === "user" || entry.message?.role === "assistant"));
	if (hasConversation && !parentSession) return undefined;

	const project = linkedWorktreeProject(options.cwd);
	if (!parentSession && !project) return undefined;
	return { version: 1, ...(parentSession ? { parentSession } : {}), ...(project ?? {}) };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		const lineage = buildSessionLineage({
			reason: event.reason,
			cwd: ctx.sessionManager.getCwd(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			env: process.env,
			entries: ctx.sessionManager.getEntries(),
		});
		if (lineage) pi.appendEntry(SESSION_LINEAGE_ENTRY_TYPE, lineage);
	});
}

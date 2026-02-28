/**
 * Resolve the cwd for a session by reading the JSONL header.
 * Caches results since a session's cwd never changes.
 */

import { existsSync, readFileSync } from "node:fs";

const cwdCache = new Map<string, string>();

/**
 * Read the cwd from a session JSONL file's header.
 * Returns the cwd or undefined if the file doesn't exist or has no valid header.
 */
export function getSessionCwd(sessionPath: string): string | undefined {
	const cached = cwdCache.get(sessionPath);
	if (cached !== undefined) return cached;

	try {
		if (!existsSync(sessionPath)) return undefined;
		const content = readFileSync(sessionPath, "utf8");
		const firstNewline = content.indexOf("\n");
		const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
		if (!firstLine.trim()) return undefined;

		const header = JSON.parse(firstLine);
		if (header.type === "session" && typeof header.cwd === "string") {
			cwdCache.set(sessionPath, header.cwd);
			return header.cwd;
		}
	} catch {
		// Ignore parse errors
	}
	return undefined;
}

/**
 * Clear the cache (for testing).
 */
export function clearSessionCwdCache(): void {
	cwdCache.clear();
}

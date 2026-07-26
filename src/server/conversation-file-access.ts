import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { buildSessionDisplayMessages } from "./session-jsonl.js";
import { extractSuccessfulToolPaths } from "./session-tool-paths.js";
import { createSessionCheckoutResolver } from "./worktree-name.js";

const PATH_CONTINUATION = /[\p{L}\p{N}_~.%/\\:+-]/u;

function expandHome(value: string): string {
	return value.replace(/^~/, process.env.HOME || "/");
}

function addCandidate(candidates: Set<string>, value: string): void {
	if (!value || value === ".") return;
	candidates.add(value);
	try {
		candidates.add(encodeURI(value)
			.replaceAll("(", "%28")
			.replaceAll(")", "%29"));
	} catch {
		// Invalid surrogate pairs cannot be represented in a URL, but the raw
		// spelling can still be checked without weakening the exact match.
	}
}

function buildMentionCandidates(
	rawRequestPath: string,
	requestedPath: string,
	resolvedPath: string,
	sessionCwd: string,
): Set<string> {
	const candidates = new Set<string>();
	addCandidate(candidates, rawRequestPath);

	const cwd = path.resolve(expandHome(sessionCwd));
	for (const candidatePath of new Set([path.resolve(requestedPath), path.resolve(resolvedPath)])) {
		addCandidate(candidates, candidatePath);
		addCandidate(candidates, pathToFileURL(candidatePath).href);

		const relative = path.relative(cwd, candidatePath);
		if (relative && !path.isAbsolute(relative)) {
			addCandidate(candidates, relative);
			if (!relative.startsWith(`..${path.sep}`) && relative !== "..") {
				addCandidate(candidates, `.${path.sep}${relative}`);
			}
		}
	}
	return candidates;
}

function containsExactPathMention(text: string, candidate: string): boolean {
	let index = text.indexOf(candidate);
	while (index >= 0) {
		const before = index > 0 ? text[index - 1] : "";
		const end = index + candidate.length;
		const after = end < text.length ? text[end] : "";
		if ((!before || !PATH_CONTINUATION.test(before))
			&& (!after || !PATH_CONTINUATION.test(after))) {
			return true;
		}
		index = text.indexOf(candidate, index + 1);
	}
	return false;
}

function conversationText(message: any): string[] {
	if (message?.role === "compactionSummary" && typeof message.summary === "string") {
		return [message.summary];
	}
	if (message?.role !== "user" && message?.role !== "assistant") return [];
	if (typeof message.content === "string") return [message.content];
	if (!Array.isArray(message.content)) return [];

	const text: string[] = [];
	for (const chunk of message.content) {
		if (chunk?.type === "text" && typeof chunk.text === "string") text.push(chunk.text);
		if (chunk?.type === "thinking" && typeof chunk.thinking === "string") text.push(chunk.thinking);
	}
	return text;
}

/**
 * Allow an exact path outside the session CWD only when its spelling (absolute,
 * file URL, or CWD-relative) appears in the currently displayed conversation.
 */
export function conversationMentionsFile(options: {
	sessionPath: string;
	sessionCwd: string;
	rawRequestPath: string;
	requestedPath: string;
	resolvedPath: string;
	entries?: ReturnType<typeof parseSessionEntries>;
}): boolean {
	try {
		const entries = options.entries ?? parseSessionEntries(readFileSync(options.sessionPath, "utf8"));
		const messages = buildSessionDisplayMessages(entries);
		const candidates = buildMentionCandidates(
			options.rawRequestPath,
			options.requestedPath,
			options.resolvedPath,
			options.sessionCwd,
		);
		for (const message of messages) {
			for (const text of conversationText(message)) {
				for (const candidate of candidates) {
					if (containsExactPathMention(text, candidate)) return true;
				}
			}
		}
	} catch {
		// Authorization failures are deny-by-default. The endpoint reports the
		// same 403 as an ordinary unmentioned CWD escape.
	}
	return false;
}

export type ConversationFileResolution =
	| { ok: true; path: string }
	| { ok: false; reason: "not_found" | "forbidden" };

function addUniquePath(paths: string[], candidate: string): void {
	const normalized = path.resolve(candidate);
	if (!paths.includes(normalized)) paths.push(normalized);
}

function relativePathMatches(base: string, candidate: string, requestedPath: string): boolean {
	const relative = path.relative(base, candidate);
	return !path.isAbsolute(relative) && path.normalize(relative) === path.normalize(requestedPath);
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve one preview request from server-owned session and Git evidence.
 * Relative paths prefer an exact successful write/edit, then the active linked
 * checkout, then the immutable session CWD. Absolute paths remain exact.
 */
export function resolveConversationFilePath(options: {
	sessionPath: string;
	sessionCwd: string;
	cwdRoot: string;
	requestedPath: string;
}): ConversationFileResolution {
	let entries: ReturnType<typeof parseSessionEntries> = [];
	try {
		entries = parseSessionEntries(readFileSync(options.sessionPath, "utf8"));
	} catch {
		// CWD-confined reads remain available for partially written or damaged
		// sessions. Tool evidence and outside-CWD mentions deny by default.
	}
	const toolActivity = extractSuccessfulToolPaths(entries, options.sessionCwd);
	const checkout = createSessionCheckoutResolver()(
		options.cwdRoot,
		toolActivity.map((activity) => activity.path),
	);
	const knownWorktreeRoots = checkout.cwdRoot ? checkout.knownWorktreeRoots : [];
	const mutationPaths = toolActivity
		.filter((activity) => activity.mutatesFile)
		.map((activity) => activity.path);

	const candidates: string[] = [];
	if (path.isAbsolute(options.requestedPath)) {
		addUniquePath(candidates, options.requestedPath);
	} else {
		// Exact mutation evidence remains authoritative even if newer root-checkout
		// activity reset the active worktree label.
		const matchBases = [options.cwdRoot, ...knownWorktreeRoots];
		for (let i = mutationPaths.length - 1; i >= 0; i--) {
			if (matchBases.some((base) => relativePathMatches(base, mutationPaths[i], options.requestedPath))) {
				addUniquePath(candidates, mutationPaths[i]);
			}
		}
		if (checkout.activeWorktreeRoot) {
			addUniquePath(candidates, path.resolve(checkout.activeWorktreeRoot, options.requestedPath));
		}
		addUniquePath(candidates, path.resolve(options.cwdRoot, options.requestedPath));
	}

	const authorizedRoots = [options.cwdRoot, ...knownWorktreeRoots];
	const canonicalMutationPaths = new Set<string>();
	for (const mutationPath of mutationPaths) {
		try {
			canonicalMutationPaths.add(realpathSync(mutationPath));
		} catch {
			// Removed or renamed mutation targets no longer provide access.
		}
	}

	let foundForbiddenCandidate = false;
	for (const requested of candidates) {
		let resolved: string;
		try {
			resolved = realpathSync(requested);
		} catch (error: any) {
			if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
			throw error;
		}
		const authorized = authorizedRoots.some((authorizedRoot) => isPathInside(authorizedRoot, resolved))
			|| canonicalMutationPaths.has(resolved)
			|| conversationMentionsFile({
				sessionPath: options.sessionPath,
				sessionCwd: options.sessionCwd,
				rawRequestPath: options.requestedPath,
				requestedPath: requested,
				resolvedPath: resolved,
				entries,
			});
		if (authorized) return { ok: true, path: resolved };
		foundForbiddenCandidate = true;
	}

	return foundForbiddenCandidate
		? { ok: false, reason: "forbidden" }
		: { ok: false, reason: "not_found" };
}

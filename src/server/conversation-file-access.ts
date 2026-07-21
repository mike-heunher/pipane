import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { buildSessionDisplayMessages } from "./session-jsonl.js";

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
}): boolean {
	try {
		const entries = parseSessionEntries(readFileSync(options.sessionPath, "utf8"));
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

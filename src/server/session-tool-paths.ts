import path from "node:path";

export interface SuccessfulToolPath {
	path: string;
	toolName: string;
	mutatesFile: boolean;
}

const PATH_ACTIVITY_TOOLS = new Set([
	"edit",
	"hypa_find",
	"hypa_grep",
	"hypa_ls",
	"hypa_read",
	"read",
	"write",
]);
const FILE_MUTATION_TOOLS = new Set(["edit", "write"]);

function parseToolArguments(rawArguments: unknown): Record<string, any> | null {
	if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
		return rawArguments as Record<string, any>;
	}
	if (typeof rawArguments !== "string") return null;
	try {
		const parsed = JSON.parse(rawArguments);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, any>
			: null;
	} catch {
		return null;
	}
}

function extractToolPaths(toolName: unknown, rawArguments: unknown, cwd: string): SuccessfulToolPath[] {
	if (typeof toolName !== "string") return [];
	const args = parseToolArguments(rawArguments);
	if (!args) return [];

	if (Array.isArray(args.tool_uses)) {
		return args.tool_uses.flatMap((toolUse: any) => extractToolPaths(
			toolUse?.recipient_name,
			toolUse?.parameters,
			cwd,
		));
	}

	const shortName = toolName.toLowerCase().split(".").pop() ?? "";
	if (!PATH_ACTIVITY_TOOLS.has(shortName)) return [];
	const candidate = typeof args.path === "string"
		? args.path
		: typeof args.file_path === "string"
			? args.file_path
			: "";
	if (!candidate || candidate.includes("\0")) return [];
	if (!path.isAbsolute(candidate) && !cwd) return [];
	return [{
		path: path.resolve(cwd || path.parse(candidate).root, candidate),
		toolName: shortName,
		mutatesFile: FILE_MUTATION_TOOLS.has(shortName),
	}];
}

/**
 * Follow the currently selected JSONL leaf back to the root without applying
 * compaction. This preserves older tool evidence from the active conversation
 * while excluding calls that belong only to an abandoned branch.
 */
export function buildActiveSessionEntries(entries: readonly any[]): any[] {
	const sessionEntries = entries.filter((entry) => entry?.type !== "session" && typeof entry?.id === "string");
	const leaf = sessionEntries.at(-1);
	if (!leaf) return [];

	const byId = new Map(sessionEntries.map((entry) => [entry.id, entry]));
	const active: any[] = [];
	const visited = new Set<string>();
	let current: any = leaf;
	while (current && typeof current.id === "string" && !visited.has(current.id)) {
		visited.add(current.id);
		active.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	return active.reverse();
}

/**
 * Pair path-bearing assistant tool calls with their successful tool results.
 * Returned activity is ordered oldest-to-newest and contains normalized
 * absolute paths. Failed and still-pending calls never provide evidence.
 */
export function extractSuccessfulToolPaths(
	entries: readonly any[],
	cwd: string,
): SuccessfulToolPath[] {
	const pending = new Map<string, SuccessfulToolPath[]>();
	const successful: SuccessfulToolPath[] = [];

	for (const entry of buildActiveSessionEntries(entries)) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const chunk of message.content) {
				if (chunk?.type !== "toolCall" || typeof chunk.id !== "string") continue;
				pending.set(chunk.id, extractToolPaths(chunk.name, chunk.arguments, cwd));
			}
			continue;
		}
		if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		const completed = pending.get(message.toolCallId);
		pending.delete(message.toolCallId);
		if (message.isError !== true && completed) successful.push(...completed);
	}

	return successful;
}

import type { SlashCommandInfo } from "../shared/ws-protocol.js";

export type SlashCommandSource = "builtin" | SlashCommandInfo["source"];

export interface SlashCommandSuggestion {
	name: string;
	description: string;
	source: SlashCommandSource;
	argumentHint?: string;
	acceptsArguments?: boolean;
}

export const PIPANE_SLASH_COMMANDS: readonly SlashCommandSuggestion[] = [
	{ name: "help", description: "Show this help", source: "builtin" },
	{ name: "new", description: "Start a new session", source: "builtin" },
	{ name: "session", description: "Show session file, messages, tokens, and cost", source: "builtin" },
	{ name: "fork", description: "Fork session from a previous message", source: "builtin" },
	{
		name: "compact",
		description: "Compact conversation history",
		source: "builtin",
		argumentHint: "[instructions]",
		acceptsArguments: true,
	},
	{
		name: "name",
		description: "Set session display name",
		source: "builtin",
		argumentHint: "<name>",
		acceptsArguments: true,
	},
	{ name: "reload", description: "Restart all pooled pi RPC processes", source: "builtin" },
];

/** Merge Pipane commands with Pi's ordered extension, prompt, and skill list. */
export function mergeSlashCommands(commands: readonly SlashCommandInfo[]): SlashCommandSuggestion[] {
	const result = PIPANE_SLASH_COMMANDS.map((command) => ({ ...command }));
	const names = new Set(result.map((command) => command.name.toLocaleLowerCase()));
	for (const command of commands) {
		const normalizedName = command.name.toLocaleLowerCase();
		// Pipane handles its built-ins before forwarding prompts to Pi, so a remote
		// collision would not actually be invokable and should not appear twice.
		if (names.has(normalizedName)) continue;
		names.add(normalizedName);
		result.push({
			name: command.name,
			description: command.description ?? "",
			source: command.source,
			// Pi's discovery protocol does not expose argument metadata. All three
			// remote command kinds accept trailing prompt text when supported, so leave
			// the editor ready for it rather than executing on selection.
			acceptsArguments: true,
		});
	}
	return result;
}

/** Return a higher score for a stronger case-insensitive fuzzy name match. */
export function scoreFuzzySlashCommand(name: string, query: string): number | undefined {
	const candidate = name.toLocaleLowerCase();
	const needle = query.toLocaleLowerCase();
	if (!needle) return 0;
	if (candidate === needle) return 100_000;

	let score = candidate.startsWith(needle) ? 50_000 : 0;
	let searchFrom = 0;
	let previousMatch = -2;
	let firstMatch = -1;

	for (const character of needle) {
		const match = candidate.indexOf(character, searchFrom);
		if (match === -1) return undefined;
		if (firstMatch === -1) firstMatch = match;

		const previousCharacter = match > 0 ? candidate[match - 1] : "";
		if (match === 0 || previousCharacter === "-" || previousCharacter === ":" || previousCharacter === "_") {
			score += 18;
		} else {
			score += 4;
		}
		if (match === previousMatch + 1) score += 12;

		previousMatch = match;
		searchFrom = match + 1;
	}

	// Prefer early, compact matches while keeping original command order for ties.
	score -= firstMatch * 3;
	score -= candidate.length - needle.length;
	return score;
}

/** Fuzzy-filter command names while preserving source order for equal scores. */
export function filterSlashCommands(
	commands: readonly SlashCommandSuggestion[],
	query: string,
): SlashCommandSuggestion[] {
	return commands
		.map((command, index) => ({
			command,
			index,
			score: scoreFuzzySlashCommand(command.name, query),
		}))
		.filter((item): item is typeof item & { score: number } => item.score !== undefined)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map((item) => item.command);
}

export function slashCommandSourceLabel(source: SlashCommandSource): string {
	switch (source) {
		case "builtin": return "Built-in";
		case "extension": return "Extension";
		case "prompt": return "Prompt";
		case "skill": return "Skill";
	}
}

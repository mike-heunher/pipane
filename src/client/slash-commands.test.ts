import { describe, expect, it } from "vitest";
import {
	filterSlashCommands,
	mergeSlashCommands,
	PIPANE_SLASH_COMMANDS,
	scoreFuzzySlashCommand,
} from "./slash-commands.js";

describe("slash command discovery", () => {
	it("keeps built-ins first, preserves Pi order, and removes shadowed duplicates", () => {
		const commands = mergeSlashCommands([
			{ name: "deploy", description: "Deploy the app", source: "extension" },
			{ name: "review", description: "Review changes", source: "prompt" },
			{ name: "skill:search", description: "Search the web", source: "skill" },
			{ name: "HELP", description: "Shadowed", source: "extension" },
		]);

		expect(commands.slice(0, PIPANE_SLASH_COMMANDS.length).map((command) => command.name))
			.toEqual(PIPANE_SLASH_COMMANDS.map((command) => command.name));
		expect(commands.slice(PIPANE_SLASH_COMMANDS.length).map((command) => command.name))
			.toEqual(["deploy", "review", "skill:search"]);
		expect(commands.find((command) => command.name === "deploy")).toMatchObject({
			description: "Deploy the app",
			source: "extension",
			acceptsArguments: true,
		});
	});

	it("fuzzy-matches case-insensitive subsequences and ranks stronger matches first", () => {
		const commands = mergeSlashCommands([
			{ name: "skill:brave-search", source: "skill" },
			{ name: "compact-report", source: "prompt" },
		]);

		expect(filterSlashCommands(commands, "SKBR").map((command) => command.name))
			.toEqual(["skill:brave-search"]);
		expect(filterSlashCommands(commands, "compact").map((command) => command.name).slice(0, 2))
			.toEqual(["compact", "compact-report"]);
		expect(filterSlashCommands(commands, "zzzz")).toEqual([]);
	});

	it("rejects out-of-order characters", () => {
		expect(scoreFuzzySlashCommand("compact", "cpct")).toBeTypeOf("number");
		expect(scoreFuzzySlashCommand("compact", "tcpc")).toBeUndefined();
	});
});

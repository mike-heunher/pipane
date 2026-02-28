export interface PiLaunch {
	command: string;
	baseArgs: string[];
}

export function resolvePiLaunch(piCli?: string | null): PiLaunch {
	const cli = (piCli ?? "").trim();
	if (!cli) {
		return { command: "pi", baseArgs: [] };
	}

	if (cli.endsWith(".js") || cli.endsWith(".mjs") || cli.endsWith(".cjs")) {
		return { command: "node", baseArgs: [cli] };
	}

	return { command: cli, baseArgs: [] };
}

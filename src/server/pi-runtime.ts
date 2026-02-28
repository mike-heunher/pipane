import path from "node:path";
import { existsSync as fsExistsSync } from "node:fs";
import { spawnSync as childSpawnSync } from "node:child_process";

type RuntimeDeps = {
	existsSync?: (file: string) => boolean;
	spawnSync?: typeof childSpawnSync;
};

function looksLikePath(command: string): boolean {
	return command.includes("/") || command.includes(path.sep);
}

export function checkCommandAvailable(command: string, deps: RuntimeDeps = {}): boolean {
	const existsSync = deps.existsSync ?? fsExistsSync;
	const spawnSync = deps.spawnSync ?? childSpawnSync;

	if (looksLikePath(command)) {
		return existsSync(command);
	}

	const result = spawnSync("which", [command], {
		stdio: "ignore",
		env: process.env,
	});
	return result.status === 0;
}

export function isPiInstallable(command: string, baseArgs: string[]): boolean {
	return command === "pi" && baseArgs.length === 0;
}

export function makePiNotFoundMessage(command: string): string {
	return `pi command not found: '${command}'. Install pi or set PI_CLI to a working CLI path/binary.`;
}

export async function installPiGlobal(deps: RuntimeDeps = {}): Promise<boolean> {
	const spawnSync = deps.spawnSync ?? childSpawnSync;
	const result = spawnSync("npm", ["install", "-g", "@mariozechner/pi-coding-agent"], {
		stdio: "inherit",
		env: process.env,
	});
	return result.status === 0;
}

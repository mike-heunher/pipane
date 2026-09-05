import path from "node:path";
import { existsSync as fsExistsSync } from "node:fs";
import {
	execFile as childExecFile,
	spawnSync as childSpawnSync,
} from "node:child_process";

type RuntimeDeps = {
	existsSync?: (file: string) => boolean;
	spawnSync?: typeof childSpawnSync;
	execFile?: typeof childExecFile;
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
	const result = spawnSync("npm", ["install", "-g", "@earendil-works/pi-coding-agent"], {
		stdio: "inherit",
		env: process.env,
	});
	return result.status === 0;
}

/** Force-refresh Pi's persisted remote model catalogs without updating Pi itself. */
export function refreshPiModelCatalog(
	launch: { command: string; baseArgs: string[] },
	cwd: string,
	deps: RuntimeDeps = {},
): Promise<void> {
	const execFile = deps.execFile ?? childExecFile;
	return new Promise((resolve, reject) => {
		execFile(
			launch.command,
			[...launch.baseArgs, "update", "--models"],
			{
				cwd,
				env: process.env,
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
			},
			(error, _stdout, stderr) => {
				if (!error) {
					resolve();
					return;
				}
				const details = String(stderr || "").trim();
				reject(new Error(
					details ? `Pi model catalog refresh failed: ${details}` : `Pi model catalog refresh failed: ${error.message}`,
					{ cause: error },
				));
			},
		);
	});
}

import { spawn } from "node:child_process";
import {
	DefaultPackageManager,
	SettingsManager,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
	UpdateNotice,
	UpdateRunResult,
	UpdateSnapshot,
	UpdateTarget,
} from "../shared/updates.js";
import {
	compareSemver,
	fetchLatestPiRelease,
	fetchLatestVersion,
	type LatestPiRelease,
} from "./update-check.js";

const UPDATE_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMAND_OUTPUT = 16 * 1024;
const NO_UPDATE_MESSAGES: Record<UpdateTarget, string> = {
	pipane: "pipane is already up to date.",
	pi: "Pi is already up to date.",
	extensions: "Pi packages are already up to date.",
};

export interface PiLaunchCommand {
	command: string;
	baseArgs: string[];
}

export interface CommandResult {
	stdout: string;
	stderr: string;
}

export interface UpdateManagerDependencies {
	fetchLatestVersion(packageName: string): Promise<string | null>;
	fetchLatestPiRelease(currentVersion: string): Promise<LatestPiRelease | null>;
	getPiVersion(launch: PiLaunchCommand, cwd: string): Promise<string | null>;
	checkExtensionUpdates(cwd: string): Promise<string[]>;
	runCommand(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

export interface UpdateManagerOptions {
	pipaneVersion: string;
	pipanePackageName: string;
	piLaunch: PiLaunchCommand;
	cwd: string;
	onPiRuntimeChanged?: () => void | Promise<void>;
	skipChecks?: boolean;
	skipPipaneCheck?: boolean;
	dependencies?: Partial<UpdateManagerDependencies>;
}

function appendBounded(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	return next.length > MAX_COMMAND_OUTPUT ? next.slice(-MAX_COMMAND_OUTPUT) : next;
}

export function runUpdateCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = UPDATE_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
		child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Failed to start ${command}: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`Update command timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
				return;
			}
			if (code !== 0) {
				const detail = (stderr || stdout).trim();
				const suffix = detail ? `: ${detail}` : signal ? ` (signal ${signal})` : "";
				reject(new Error(`Update command failed with exit code ${code ?? "unknown"}${suffix}`));
				return;
			}
			resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
		});
	});
}

async function getInstalledPiVersion(launch: PiLaunchCommand, cwd: string): Promise<string | null> {
	try {
		const result = await runUpdateCommand(launch.command, [...launch.baseArgs, "--version"], cwd, 10_000);
		const match = `${result.stdout}\n${result.stderr}`.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

async function checkManagedExtensionUpdates(cwd: string): Promise<string[]> {
	if (process.env.PI_OFFLINE) return [];
	const agentDir = getAgentDir();
	// RPC mode does not prompt for project trust. Check the user-level package set,
	// which is shared by every Pi worker, without loading untrusted project config.
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const updates = await packageManager.checkForAvailableUpdates();
	return updates.map((update) => update.displayName);
}

function cloneSnapshot(snapshot: UpdateSnapshot): UpdateSnapshot {
	return {
		checkedAt: snapshot.checkedAt,
		notices: snapshot.notices.map((notice) => ({
			...notice,
			...(notice.packages ? { packages: [...notice.packages] } : {}),
		})),
	};
}

export class UpdateManager {
	private readonly options: UpdateManagerOptions;
	private readonly dependencies: UpdateManagerDependencies;
	private snapshot: UpdateSnapshot = { checkedAt: new Date(0).toISOString(), notices: [] };
	private checkPromise: Promise<UpdateSnapshot> | undefined;
	private activeUpdate: UpdateTarget | undefined;

	constructor(options: UpdateManagerOptions) {
		this.options = options;
		this.dependencies = {
			fetchLatestVersion,
			fetchLatestPiRelease,
			getPiVersion: getInstalledPiVersion,
			checkExtensionUpdates: checkManagedExtensionUpdates,
			runCommand: runUpdateCommand,
			...options.dependencies,
		};
	}

	get currentSnapshot(): UpdateSnapshot {
		return cloneSnapshot(this.snapshot);
	}

	check(): Promise<UpdateSnapshot> {
		if (!this.checkPromise) {
			this.checkPromise = this.performCheck();
		}
		return this.checkPromise.then(cloneSnapshot);
	}

	private async performCheck(): Promise<UpdateSnapshot> {
		if (this.options.skipChecks || process.env.PIPANE_SKIP_UPDATE_CHECK || process.env.PI_OFFLINE) {
			this.snapshot = { checkedAt: new Date().toISOString(), notices: [] };
			return this.snapshot;
		}

		const pipaneCheck = this.options.skipPipaneCheck
			? Promise.resolve<UpdateNotice | null>(null)
			: this.checkPipaneUpdate();
		const piCheck = process.env.PI_SKIP_VERSION_CHECK
			? Promise.resolve<UpdateNotice | null>(null)
			: this.checkPiUpdate();
		const extensionCheck = this.checkExtensionUpdate();
		const notices = (await Promise.all([pipaneCheck, piCheck, extensionCheck]))
			.filter((notice): notice is UpdateNotice => notice !== null);
		this.snapshot = { checkedAt: new Date().toISOString(), notices };
		return this.snapshot;
	}

	private async checkPipaneUpdate(): Promise<UpdateNotice | null> {
		try {
			const latestVersion = await this.dependencies.fetchLatestVersion(this.options.pipanePackageName);
			if (!latestVersion || compareSemver(this.options.pipaneVersion, latestVersion) >= 0) return null;
			return {
				target: "pipane",
				currentVersion: this.options.pipaneVersion,
				latestVersion,
			};
		} catch {
			return null;
		}
	}

	private async checkPiUpdate(): Promise<UpdateNotice | null> {
		try {
			const currentVersion = await this.dependencies.getPiVersion(this.options.piLaunch, this.options.cwd);
			if (!currentVersion) return null;
			const release = await this.dependencies.fetchLatestPiRelease(currentVersion);
			if (!release || compareSemver(currentVersion, release.version) >= 0) return null;
			return {
				target: "pi",
				currentVersion,
				latestVersion: release.version,
			};
		} catch {
			return null;
		}
	}

	private async checkExtensionUpdate(): Promise<UpdateNotice | null> {
		try {
			const packages = [...new Set(await this.dependencies.checkExtensionUpdates(this.options.cwd))]
				.sort((left, right) => left.localeCompare(right));
			return packages.length > 0 ? { target: "extensions", packages } : null;
		} catch {
			return null;
		}
	}

	async run(target: UpdateTarget): Promise<UpdateRunResult> {
		await this.check();
		if (this.activeUpdate) {
			throw new Error(`An update is already running for ${this.activeUpdate}.`);
		}
		const notice = this.snapshot.notices.find((candidate) => candidate.target === target);
		if (!notice) {
			return {
				target,
				message: NO_UPDATE_MESSAGES[target],
				restartRequired: false,
			};
		}

		this.activeUpdate = target;
		try {
			const result = await this.performUpdate(notice);
			this.snapshot = {
				checkedAt: new Date().toISOString(),
				notices: this.snapshot.notices.filter((candidate) => candidate.target !== target),
			};
			return result;
		} finally {
			this.activeUpdate = undefined;
		}
	}

	private async performUpdate(notice: UpdateNotice): Promise<UpdateRunResult> {
		switch (notice.target) {
			case "pipane": {
				if (!notice.latestVersion) throw new Error("The pipane update has no target version.");
				await this.dependencies.runCommand(
					"npm",
					["install", "-g", "--ignore-scripts", `${this.options.pipanePackageName}@${notice.latestVersion}`],
					this.options.cwd,
				);
				return {
					target: "pipane",
					message: `pipane v${notice.latestVersion} installed. Restart pipane to use the new version.`,
					restartRequired: true,
				};
			}
			case "pi": {
				await this.dependencies.runCommand(
					this.options.piLaunch.command,
					[...this.options.piLaunch.baseArgs, "update", "--self"],
					this.options.cwd,
				);
				await this.options.onPiRuntimeChanged?.();
				return {
					target: "pi",
					message: `Pi${notice.latestVersion ? ` v${notice.latestVersion}` : ""} installed. Pi workers are restarting.`,
					restartRequired: false,
				};
			}
			case "extensions": {
				await this.dependencies.runCommand(
					this.options.piLaunch.command,
					[...this.options.piLaunch.baseArgs, "update", "--extensions"],
					this.options.cwd,
				);
				await this.options.onPiRuntimeChanged?.();
				const count = notice.packages?.length ?? 0;
				return {
					target: "extensions",
					message: `${count} Pi package${count === 1 ? "" : "s"} updated. Pi workers are restarting.`,
					restartRequired: false,
				};
			}
		}
	}
}

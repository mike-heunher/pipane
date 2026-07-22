/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateTarget } from "../shared/updates.js";
import {
	UpdateManager,
	type PiLaunchCommand,
	type UpdateManagerDependencies,
} from "./update-manager.js";

const piLaunch: PiLaunchCommand = { command: "pi-custom", baseArgs: ["--profile", "web"] };

function makeDependencies(overrides: Partial<UpdateManagerDependencies> = {}): UpdateManagerDependencies {
	return {
		fetchLatestVersion: vi.fn(async () => "1.2.0"),
		fetchLatestPiRelease: vi.fn(async () => ({ version: "0.81.0" })),
		getPiVersion: vi.fn(async () => "0.80.0"),
		checkExtensionUpdates: vi.fn(async () => ["npm:zeta", "npm:alpha", "npm:alpha"]),
		runCommand: vi.fn(async () => ({ stdout: "ok", stderr: "" })),
		...overrides,
	};
}

function makeManager(
	dependencies: UpdateManagerDependencies,
	onPiRuntimeChanged = vi.fn(),
	options: { skipPipaneCheck?: boolean } = {},
) {
	return {
		manager: new UpdateManager({
			pipaneVersion: "1.1.0",
			pipanePackageName: "pipane",
			piLaunch,
			cwd: "/srv/project",
			onPiRuntimeChanged,
			dependencies,
			...options,
		}),
		onPiRuntimeChanged,
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("UpdateManager", () => {
	it("reports pipane, Pi, and managed Pi package updates", async () => {
		const dependencies = makeDependencies();
		const { manager } = makeManager(dependencies);

		const snapshot = await manager.check();

		expect(snapshot.notices).toEqual([
			{ target: "pipane", currentVersion: "1.1.0", latestVersion: "1.2.0" },
			{ target: "pi", currentVersion: "0.80.0", latestVersion: "0.81.0" },
			{ target: "extensions", packages: ["npm:alpha", "npm:zeta"] },
		]);
		expect(dependencies.fetchLatestPiRelease).toHaveBeenCalledWith("0.80.0");

		// Callers cannot mutate the manager's cached snapshot.
		snapshot.notices.length = 0;
		expect(manager.currentSnapshot.notices).toHaveLength(3);
	});

	it("hides only the pipane update for development commits", async () => {
		const dependencies = makeDependencies();
		const { manager } = makeManager(dependencies, vi.fn(), { skipPipaneCheck: true });

		expect((await manager.check()).notices).toEqual([
			{ target: "pi", currentVersion: "0.80.0", latestVersion: "0.81.0" },
			{ target: "extensions", packages: ["npm:alpha", "npm:zeta"] },
		]);
		expect(dependencies.fetchLatestVersion).not.toHaveBeenCalled();
	});

	it("runs each update with fixed arguments and restarts Pi workers when needed", async () => {
		const dependencies = makeDependencies();
		const { manager, onPiRuntimeChanged } = makeManager(dependencies);
		await manager.check();

		const pipane = await manager.run("pipane");
		const pi = await manager.run("pi");
		const extensions = await manager.run("extensions");

		expect(dependencies.runCommand).toHaveBeenNthCalledWith(
			1,
			"npm",
			["install", "-g", "--ignore-scripts", "pipane@1.2.0"],
			"/srv/project",
		);
		expect(dependencies.runCommand).toHaveBeenNthCalledWith(
			2,
			"pi-custom",
			["--profile", "web", "update", "--self"],
			"/srv/project",
		);
		expect(dependencies.runCommand).toHaveBeenNthCalledWith(
			3,
			"pi-custom",
			["--profile", "web", "update", "--extensions"],
			"/srv/project",
		);
		expect(pipane.restartRequired).toBe(true);
		expect(pi.message).toContain("v0.81.0");
		expect(extensions.message).toContain("2 Pi packages");
		expect(onPiRuntimeChanged).toHaveBeenCalledTimes(2);
		expect(manager.currentSnapshot.notices).toEqual([]);
	});

	it("keeps a notice available when its update command fails", async () => {
		const dependencies = makeDependencies({
			runCommand: vi.fn(async () => { throw new Error("permission denied"); }),
		});
		const { manager } = makeManager(dependencies);

		await expect(manager.run("pi")).rejects.toThrow("permission denied");
		expect(manager.currentSnapshot.notices.some((notice) => notice.target === "pi")).toBe(true);
	});

	it("rejects concurrent updates and treats stale update requests as already current", async () => {
		let finishUpdate!: () => void;
		const dependencies = makeDependencies({
			fetchLatestVersion: vi.fn(async () => null),
			fetchLatestPiRelease: vi.fn(async () => null),
			checkExtensionUpdates: vi.fn(async () => ["npm:one"]),
			runCommand: vi.fn(() => new Promise<{ stdout: string; stderr: string }>((resolve) => {
				finishUpdate = () => resolve({ stdout: "", stderr: "" });
			})),
		});
		const { manager } = makeManager(dependencies);
		const running = manager.run("extensions");
		await vi.waitFor(() => expect(dependencies.runCommand).toHaveBeenCalled());

		await expect(manager.run("extensions")).rejects.toThrow("already running");
		finishUpdate();
		await running;
		await expect(manager.run("pi")).resolves.toEqual({
			target: "pi",
			message: "Pi is already up to date.",
			restartRequired: false,
		});
		expect(dependencies.runCommand).toHaveBeenCalledTimes(1);
	});

	it("honors offline and skip-version-check settings", async () => {
		const dependencies = makeDependencies();
		vi.stubEnv("PI_OFFLINE", "1");
		const { manager } = makeManager(dependencies);
		expect((await manager.check()).notices).toEqual([]);
		expect(dependencies.fetchLatestVersion).not.toHaveBeenCalled();

		vi.unstubAllEnvs();
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
		const secondDependencies = makeDependencies({
			fetchLatestVersion: vi.fn(async () => null),
			checkExtensionUpdates: vi.fn(async () => []),
		});
		const second = makeManager(secondDependencies).manager;
		expect((await second.check()).notices).toEqual([]);
		expect(secondDependencies.getPiVersion).not.toHaveBeenCalled();
	});

	it.each<UpdateTarget>(["pipane", "pi", "extensions"])("omits %s when its check fails", async (target) => {
		const overrides: Partial<UpdateManagerDependencies> = target === "pipane"
			? { fetchLatestVersion: vi.fn(async () => { throw new Error("offline"); }) }
			: target === "pi"
				? { getPiVersion: vi.fn(async () => { throw new Error("missing"); }) }
				: { checkExtensionUpdates: vi.fn(async () => { throw new Error("offline"); }) };
		const { manager } = makeManager(makeDependencies(overrides));
		expect((await manager.check()).notices.some((notice) => notice.target === target)).toBe(false);
	});
});

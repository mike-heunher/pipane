import { describe, expect, it, vi } from "vitest";
import {
	checkCommandAvailable,
	installPiGlobal,
	isPiInstallable,
	refreshPiModelCatalog,
} from "./pi-runtime";

describe("pi runtime checks", () => {
	it("treats absolute command paths as available when file exists", () => {
		const existsSync = vi.fn(() => true);
		expect(checkCommandAvailable("/usr/local/bin/pi", { existsSync })).toBe(true);
	});

	it("checks PATH commands with which", () => {
		const spawnSync = vi.fn(() => ({ status: 0 })) as any;
		expect(checkCommandAvailable("pi", { spawnSync })).toBe(true);
		expect(spawnSync).toHaveBeenCalledWith("which", ["pi"], expect.any(Object));
	});

	it("marks only default pi command as installable", () => {
		expect(isPiInstallable("pi", [])).toBe(true);
		expect(isPiInstallable("node", ["/tmp/cli.js"])).toBe(false);
		expect(isPiInstallable("pi-dev", [])).toBe(false);
	});

	it("installs pi with npm i -g when requested", async () => {
		const spawnSync = vi.fn(() => ({ status: 0 })) as any;
		const ok = await installPiGlobal({ spawnSync });
		expect(ok).toBe(true);
		expect(spawnSync).toHaveBeenCalledWith(
			"npm",
			["install", "-g", "@earendil-works/pi-coding-agent"],
			expect.objectContaining({ stdio: "inherit" }),
		);
	});

	it("refreshes only Pi model catalogs through the configured launch command", async () => {
		const execFile = vi.fn((_command, _args, _options, callback) => {
			callback(null, "Model catalogs refreshed\n", "");
		}) as any;

		await refreshPiModelCatalog(
			{ command: "node", baseArgs: ["/opt/pi/cli.js"] },
			"/work/project",
			{ execFile },
		);

		expect(execFile).toHaveBeenCalledWith(
			"node",
			["/opt/pi/cli.js", "update", "--models"],
			expect.objectContaining({ cwd: "/work/project", timeout: 30_000 }),
			expect.any(Function),
		);
	});

	it("reports model catalog refresh failures", async () => {
		const execFile = vi.fn((_command, _args, _options, callback) => {
			callback(new Error("exit 1"), "", "catalog endpoint unavailable\n");
		}) as any;

		await expect(refreshPiModelCatalog(
			{ command: "pi", baseArgs: [] },
			"/tmp",
			{ execFile },
		)).rejects.toThrow("Pi model catalog refresh failed: catalog endpoint unavailable");
	});
});

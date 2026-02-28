import { describe, expect, it, vi } from "vitest";
import { checkCommandAvailable, installPiGlobal, isPiInstallable } from "./pi-runtime";

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
			["install", "-g", "@mariozechner/pi-coding-agent"],
			expect.objectContaining({ stdio: "inherit" }),
		);
	});
});

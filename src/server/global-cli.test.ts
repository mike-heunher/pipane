/** @vitest-environment node */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const repoRoot = process.cwd();

describe("global npm CLI packaging", () => {
	it("defines a pipane bin entry and prepack build", () => {
		const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
		expect(pkg.private).toBe(false);
		expect(pkg.name).toBe("pipane");
		expect(pkg.bin?.["pipane"]).toBe("bin/pipane.js");
		expect(pkg.scripts?.prepack).toBe("npm run build");
		expect(pkg.files).toContain("dist/");
		expect(pkg.files).toContain("bin/");
		expect(pkg.files).toContain("extensions/");
		expect(pkg.files).toContain("patches/");
	});

	it("launcher resolves the built server entry", () => {
		const output = execFileSync(process.execPath, [path.join(repoRoot, "bin/pipane.js")], {
			env: { ...process.env, PIPANE_PRINT_ENTRY: "1" },
			encoding: "utf8",
		}).trim();
		expect(output).toBe(path.join(repoRoot, "dist/server/server/server.js"));
	});
});

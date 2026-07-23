// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPaths = [
	"deploy-dev.sh",
	"deploy-prod.sh",
	"scripts/deploy-local-release.sh",
];

describe("local deployment scripts", () => {
	it.each(scriptPaths)("keeps %s executable and syntactically valid", (relativePath) => {
		const scriptPath = path.join(repositoryRoot, relativePath);
		expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
		expect(() => execFileSync("bash", ["-n", scriptPath])).not.toThrow();
	});

	it("rejects an unknown deployment target before doing any work", () => {
		const result = spawnSync(
			path.join(repositoryRoot, "scripts/deploy-local-release.sh"),
			["unknown"],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Usage:");
	});

	it("keeps development on a distinct remote backend identity", () => {
		const service = readFileSync(path.join(repositoryRoot, "scripts/pipane-dev.service"), "utf8");

		expect(service).toContain("PORT=8223");
		expect(service).toContain("PIPANE_CONFIG_DIR=/root/.config/pipane-dev");
		expect(service).toContain("PIPANE_BACKEND_NAME=piweb-dev");
	});

	it("keeps production on the global binary for self-updates", () => {
		const service = readFileSync(path.join(repositoryRoot, "scripts/pipane.service"), "utf8");
		const deployScript = readFileSync(
			path.join(repositoryRoot, "scripts/deploy-local-release.sh"),
			"utf8",
		);

		expect(service).toContain("PORT=8222");
		expect(service).toContain("/usr/bin/pipane --verbose");
		expect(deployScript).toContain('GLOBAL_MODULE_PATH="/usr/lib/node_modules/pipane"');
	});
});

// @vitest-environment node

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const scriptPaths = [
	"deploy-dev.sh",
	"deploy-preview.sh",
	"deploy-prod.sh",
	"scripts/activate-preview-web.sh",
	"scripts/deploy-local-release.sh",
	"scripts/deploy-preview.sh",
];

describe("deployment scripts", () => {
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

	it("rejects incomplete remote preview activation before doing any work", () => {
		const result = spawnSync(
			path.join(repositoryRoot, "scripts/activate-preview-web.sh"),
			[],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Usage:");
	});

	it("shows preview help without starting a deployment", () => {
		const result = spawnSync(
			path.join(repositoryRoot, "deploy-preview.sh"),
			["--help"],
			{ encoding: "utf8", timeout: 2_000 },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Usage: npm run deploy:preview");
		expect(result.stdout).not.toContain("Deploying the preview backend");
	});

	it("keeps development on a distinct remote backend identity", () => {
		const service = readFileSync(path.join(repositoryRoot, "scripts/pipane-dev.service"), "utf8");

		expect(service).toContain("PORT=8223");
		expect(service).toContain("PIPANE_CONFIG_DIR=/root/.config/pipane-dev");
		expect(service).toContain("PIPANE_BACKEND_NAME=piweb-dev");
	});

	it("atomically activates and rolls back a browser preview", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "pipane-preview-script-"));
		const deployRoot = path.join(tempDir, "deploy");
		const packageClientDir = path.join(tempDir, "package-client");
		const activationScript = path.join(repositoryRoot, "scripts/activate-preview-web.sh");
		let healthy = true;
		mkdirSync(packageClientDir, { recursive: true });
		writeFileSync(path.join(packageClientDir, "index.html"), "packaged browser\n");

		const server = createServer((request, response) => {
			if (request.url === "/health") {
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify({ ok: healthy }));
				return;
			}
			try {
				response.end(readFileSync(path.join(packageClientDir, "index.html")));
			} catch {
				response.statusCode = 404;
				response.end("missing");
			}
		});

		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address() as AddressInfo;
			const publicUrl = `http://127.0.0.1:${address.port}`;
			const activate = async (releaseId: string, index: string): Promise<void> => {
				const stagingDir = path.join(deployRoot, `.staging-${releaseId}`);
				mkdirSync(stagingDir, { recursive: true });
				writeFileSync(path.join(stagingDir, "index.html"), index);
				const expectedHash = createHash("sha256").update(index).digest("hex");
				await execFileAsync(activationScript, [deployRoot, releaseId, expectedHash, publicUrl], {
					env: {
						...process.env,
						PIPANE_PREVIEW_PACKAGE_CLIENT_DIR: packageClientDir,
						PIPANE_PREVIEW_LOCK_FILE: path.join(tempDir, "deploy.lock"),
						PIPANE_PREVIEW_HEALTH_ATTEMPTS: "1",
						PIPANE_PREVIEW_HEALTH_DELAY: "0",
					},
				});
			};

			await activate("release-one", "browser one\n");
			expect(readFileSync(path.join(packageClientDir, "index.html"), "utf8")).toBe("browser one\n");

			healthy = false;
			await expect(activate("release-two", "browser two\n")).rejects.toMatchObject({ code: 1 });
			expect(readFileSync(path.join(packageClientDir, "index.html"), "utf8")).toBe("browser one\n");
			expect(existsSync(path.join(deployRoot, "releases/release-two"))).toBe(false);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("deploys previews without publishing npm or replacing rendezvous", () => {
		const pkg = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
		const previewScript = readFileSync(path.join(repositoryRoot, "scripts/deploy-preview.sh"), "utf8");
		const activationScript = readFileSync(path.join(repositoryRoot, "scripts/activate-preview-web.sh"), "utf8");

		expect(pkg.scripts["deploy:preview"]).toBe("./deploy-preview.sh");
		expect(previewScript).toContain('deploy-local-release.sh" dev');
		expect(previewScript).toContain("dist/client/");
		expect(previewScript).toContain("systemd-run --quiet --no-block --collect");
		expect(previewScript).toContain("PIPANE_PREVIEW_DEPLOY_IN_SYSTEMD=1");
		expect(previewScript).not.toContain("npm publish");
		expect(activationScript).toContain("/usr/lib/node_modules/pipane/dist/client");
		expect(activationScript).toContain("PUBLIC_INDEX_HASH");
		expect(activationScript).not.toContain("systemctl restart pipane-rendezvous");
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

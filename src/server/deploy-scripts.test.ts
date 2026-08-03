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
	"scripts/activate-preview-rendezvous.sh",
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
			path.join(repositoryRoot, "scripts/activate-preview-rendezvous.sh"),
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

	it("hashes the runtime-transformed browser shell used by preview verification", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "pipane-runtime-index-hash-"));
		try {
			const indexPath = path.join(tempDir, "index.html");
			const rendererPath = path.join(tempDir, "renderer.mjs");
			const source = '<meta name="pipane-runtime" content="local" />\n';
			const rendered = '<meta name="pipane-runtime" content="rendezvous" />\n';
			writeFileSync(indexPath, source);
			writeFileSync(rendererPath, `export function renderClientRuntimeIndex(source, mode) { return source.replace("local", mode); }\n`);

			const hash = execFileSync(process.execPath, [
				path.join(repositoryRoot, "scripts/hash-client-runtime-index.js"),
				indexPath,
				rendererPath,
				"rendezvous",
			], { encoding: "utf8" });
			expect(hash).toBe(createHash("sha256").update(rendered).digest("hex"));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps development on a distinct remote backend identity", () => {
		const service = readFileSync(path.join(repositoryRoot, "scripts/pipane-dev.service"), "utf8");

		expect(service).toContain("PORT=8223");
		expect(service).toContain("PIPANE_CONFIG_DIR=/root/.config/pipane-dev");
		expect(service).toContain("PIPANE_BACKEND_NAME=piweb-dev");
		expect(service).toContain("PIPANE_RENDEZVOUS_URL=https://preview.pipane.dev");
		expect(service).toContain("PIPANE_APP_URL=https://preview.pipane.dev");
	});

	it("atomically activates and rolls back an isolated rendezvous preview", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "pipane-preview-script-"));
		const deployRoot = path.join(tempDir, "deploy");
		const activationScript = path.join(repositoryRoot, "scripts/activate-preview-rendezvous.sh");
		const fakeSystemctl = path.join(tempDir, "systemctl");
		let healthy = true;
		writeFileSync(fakeSystemctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

		const server = createServer((request, response) => {
			if (request.url === "/health") {
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify({ ok: healthy }));
				return;
			}
			try {
				const source = readFileSync(path.join(deployRoot, "current/dist/client/index.html"), "utf8");
				response.end(source.replace('content="local"', 'content="rendezvous"'));
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
				for (const relativeDir of ["dist/client", "dist/server/rendezvous", "bin", "node_modules/ws"]) {
					mkdirSync(path.join(stagingDir, relativeDir), { recursive: true });
				}
				writeFileSync(path.join(stagingDir, "dist/client/index.html"), index);
				writeFileSync(path.join(stagingDir, "dist/server/rendezvous/server.js"), "// server\n");
				writeFileSync(path.join(stagingDir, "bin/pipane-rendezvous.js"), "// bin\n");
				writeFileSync(path.join(stagingDir, "node_modules/ws/package.json"), "{}\n");
				writeFileSync(path.join(stagingDir, "pipane-rendezvous-preview.service"), [
					"User=@SERVICE_USER@",
					"Group=@SERVICE_GROUP@",
					"WorkingDirectory=@STATE_DIR@",
					"ExecStart=@DEPLOY_ROOT@/current/bin/pipane-rendezvous.js",
				].join("\n"));
				const sourceHash = createHash("sha256").update(index).digest("hex");
				const publicIndex = index.replace('content="local"', 'content="rendezvous"');
				const publicHash = createHash("sha256").update(publicIndex).digest("hex");
				await execFileAsync(activationScript, [deployRoot, releaseId, sourceHash, publicHash, publicUrl], {
					env: {
						...process.env,
						PIPANE_PREVIEW_RENDEZVOUS_SERVICE_FILE: path.join(tempDir, "preview.service"),
						PIPANE_PREVIEW_RENDEZVOUS_STATE_DIR: path.join(tempDir, "state"),
						PIPANE_PREVIEW_SYSTEMCTL: fakeSystemctl,
						PIPANE_PREVIEW_SKIP_USER_SETUP: "1",
						PIPANE_PREVIEW_LOCK_FILE: path.join(tempDir, "deploy.lock"),
						PIPANE_PREVIEW_HEALTH_ATTEMPTS: "1",
						PIPANE_PREVIEW_HEALTH_DELAY: "0",
					},
				});
			};

			const firstIndex = '<meta name="pipane-runtime" content="local" />browser one\n';
			await activate("release-one", firstIndex);
			expect(readFileSync(path.join(deployRoot, "current/dist/client/index.html"), "utf8")).toBe(firstIndex);

			healthy = false;
			await expect(activate("release-two", '<meta name="pipane-runtime" content="local" />browser two\n'))
				.rejects.toMatchObject({ code: 1 });
			expect(readFileSync(path.join(deployRoot, "current/dist/client/index.html"), "utf8")).toBe(firstIndex);
			expect(existsSync(path.join(deployRoot, "releases/release-two"))).toBe(false);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("deploys a complete isolated preview stack without publishing npm", () => {
		const pkg = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
		const previewScript = readFileSync(path.join(repositoryRoot, "scripts/deploy-preview.sh"), "utf8");
		const activationScript = readFileSync(path.join(repositoryRoot, "scripts/activate-preview-rendezvous.sh"), "utf8");
		const previewService = readFileSync(path.join(repositoryRoot, "scripts/pipane-rendezvous-preview.service"), "utf8");

		expect(pkg.scripts["deploy:preview"]).toBe("./deploy-preview.sh");
		expect(previewScript).toContain('deploy-local-release.sh" dev');
		expect(previewScript).toContain("VITE_PIPANE_BOOTSTRAP_DIAGNOSTICS=1");
		expect(previewScript).toContain("hash-client-runtime-index.js");
		expect(previewScript).toContain("dist/server/server/client-assets.js");
		expect(previewScript).toContain("dist/server/rendezvous/server.js");
		expect(previewScript).toContain("npm ci --omit=dev");
		expect(previewScript).toContain("systemd-run --quiet --no-block --collect");
		expect(previewScript).toContain("PIPANE_PREVIEW_DEPLOY_IN_SYSTEMD=1");
		expect(previewScript).not.toContain("npm publish");
		expect(activationScript).toContain('SERVICE_NAME="${PIPANE_PREVIEW_RENDEZVOUS_SERVICE:-pipane-rendezvous-preview}"');
		expect(activationScript).toContain("SOURCE_INDEX_HASH");
		expect(activationScript).toContain("EXPECTED_PUBLIC_INDEX_HASH");
		expect(activationScript).toContain("PUBLIC_INDEX_HASH");
		expect(activationScript).not.toContain('restart "pipane-rendezvous"');
		expect(previewService).toContain("PORT=8788");
		expect(previewService).toContain("PIPANE_RENDEZVOUS_DATA_DIR=@STATE_DIR@");
	});

	it("detaches production deployment before restarting the hosting service", () => {
		const wrapper = readFileSync(path.join(repositoryRoot, "deploy-prod.sh"), "utf8");

		expect(wrapper).toContain("systemd-run --quiet --no-block --collect");
		expect(wrapper).toContain("PIPANE_PROD_DEPLOY_IN_SYSTEMD=1");
		expect(wrapper).toContain("pipane-prod-deploy");
		expect(wrapper).toContain('deploy-local-release.sh" prod');
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

/** @vitest-environment node */

import { describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
const repoRoot = process.cwd();
const execFileAsync = promisify(execFile);

describe("global npm CLI packaging", () => {
	it("defines a pipane bin entry and prepack build", () => {
		const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
		expect(pkg.private).toBe(false);
		expect(pkg.name).toBe("pipane");
		expect(pkg.bin?.["pipane"]).toBe("bin/pipane.js");
		expect(pkg.bin?.["pipane-rendezvous"]).toBe("bin/pipane-rendezvous.js");
		expect(pkg.scripts?.prepack).toBe("npm run build");
		expect(pkg.files).toContain("dist/");
		expect(pkg.files).toContain("bin/");
		expect(pkg.files).toContain("extensions/");
		expect(pkg.files).toContain("THIRD_PARTY_NOTICES.md");
		expect(pkg.files).not.toContain("patches/");
	});

	it("requests short-lived QR pairing links from a running local backend", async () => {
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ url: "https://app.example/pair/pair_test#backend=b_test&secret=secret" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("test server did not bind");
			const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/pipane.js"), "pair"], {
				env: { ...process.env, PIPANE_PAIR_ENDPOINT: `http://127.0.0.1:${address.port}/api/pairing` },
			});
			expect(stdout).toContain("https://app.example/pair/pair_test#backend=b_test&secret=secret");
			expect(stdout.split("\n").length).toBeGreaterThan(5);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("launchers resolve their built server entries", () => {
		const env = { ...process.env, PIPANE_PRINT_ENTRY: "1" };
		const backendOutput = execFileSync(process.execPath, [path.join(repoRoot, "bin/pipane.js")], {
			env,
			encoding: "utf8",
		}).trim();
		const rendezvousOutput = execFileSync(process.execPath, [path.join(repoRoot, "bin/pipane-rendezvous.js")], {
			env,
			encoding: "utf8",
		}).trim();
		expect(backendOutput).toBe(path.join(repoRoot, "dist/server/server/server.js"));
		expect(rendezvousOutput).toBe(path.join(repoRoot, "dist/server/rendezvous/server.js"));
	});
});

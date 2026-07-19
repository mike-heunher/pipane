import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveUsageExtensionPath } from "./bundled-extensions.js";

describe("bundled usage extension", () => {
	it("is pinned, resolvable, and loadable with its runtime dependencies", async () => {
		const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
		expect(packageJson.engines.node).toBe(">=22.19.0");
		expect(packageJson.dependencies["@sreetej510/pi-usage"]).toBe("0.1.20");
		expect(packageJson.dependencies["@earendil-works/pi-tui"]).toBe("0.80.10");
		expect(packageJson.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.80.10");

		const extensionPath = resolveUsageExtensionPath();
		expect(path.isAbsolute(extensionPath)).toBe(true);
		expect(existsSync(extensionPath)).toBe(true);
		const extension = await import(pathToFileURL(extensionPath).href);
		expect(extension.default).toEqual(expect.any(Function));
	});
});

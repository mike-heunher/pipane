/** @vitest-environment node */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDevelopmentCommit } from "./build-info.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "pipane-build-info-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("isDevelopmentCommit", () => {
	it("recognizes matching development build metadata", () => {
		const directory = makeTemporaryDirectory();
		const filePath = path.join(directory, "build-info.json");
		writeFileSync(filePath, JSON.stringify({ packageVersion: "1.2.3", developmentCommit: true }));

		expect(isDevelopmentCommit(filePath, "1.2.3")).toBe(true);
		expect(isDevelopmentCommit(filePath, "1.2.4")).toBe(false);
	});

	it("defaults to release behavior for missing, invalid, or release metadata", () => {
		const directory = makeTemporaryDirectory();
		const filePath = path.join(directory, "build-info.json");

		expect(isDevelopmentCommit(filePath, "1.2.3")).toBe(false);
		writeFileSync(filePath, "not json");
		expect(isDevelopmentCommit(filePath, "1.2.3")).toBe(false);
		writeFileSync(filePath, JSON.stringify({ packageVersion: "1.2.3", developmentCommit: false }));
		expect(isDevelopmentCommit(filePath, "1.2.3")).toBe(false);
	});
});

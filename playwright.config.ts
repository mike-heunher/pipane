import { defineConfig } from "@playwright/test";

const retainFailureArtifacts = process.env.PIPANE_E2E_ARTIFACTS === "1";
const coreRealStackTests = /real-stack\.e2e\.ts/;
const regressionRealStackTests = /(?:focus-new-session|input-clear|session-cwd|steering)\.e2e\.ts/;
const allRealStackTests = /(?:focus-new-session|input-clear|real-stack|session-cwd|steering)\.e2e\.ts/;

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.e2e.ts",
	projects: [
		{ name: "real-stack", testMatch: coreRealStackTests, workers: 2 },
		{ name: "real-regressions", testMatch: regressionRealStackTests, workers: 1 },
		{ name: "browser", testIgnore: allRealStackTests, workers: 2 },
	],
	workers: 5,
	timeout: 30000,
	retries: 0,
	outputDir: "test-results",
	snapshotPathTemplate: "{testDir}/goldens/{arg}{ext}",
	reporter: process.env.CI
		? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
		: "list",
	use: {
		headless: true,
		trace: retainFailureArtifacts ? "retain-on-failure" : "off",
		screenshot: "only-on-failure",
		video: retainFailureArtifacts ? "retain-on-failure" : "off",
	},
});

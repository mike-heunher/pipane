import { defineConfig } from "@playwright/test";

/**
 * Deliberately separate from the deterministic test suite: this workflow uses
 * real credentials/model traffic and produces README media.
 */
export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.walkthrough.ts",
	timeout: 180000,
	workers: 1,
	retries: 0,
	use: {
		headless: true,
	},
});

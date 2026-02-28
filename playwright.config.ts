import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.e2e.ts",
	timeout: 30000,
	snapshotPathTemplate: "{testDir}/goldens/{arg}{ext}",
	use: {
		headless: true,
	},
});

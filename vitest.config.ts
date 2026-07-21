import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		tsconfigRaw: {
			compilerOptions: {
				experimentalDecorators: true,
				useDefineForClassFields: false,
			},
		},
	},
	test: {
		environment: "happy-dom",
		// Reuse each VM worker's environment across files; per-test guards in the
		// setup file still reset network/console state and catch leaked activity.
		pool: "vmThreads",
		maxWorkers: 4,
		isolate: false,
		include: ["src/**/*.test.ts"],
		setupFiles: ["./vitest.setup.ts"],
		// Increase timeout for Lit component rendering
		testTimeout: 10000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/test/**"],
			reporter: ["text", "json-summary", "lcov"],
			thresholds: {
				lines: 45,
				statements: 45,
				functions: 60,
				branches: 70,
			},
		},
	},
});

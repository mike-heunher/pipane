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
		include: ["src/**/*.test.ts"],
		// Increase timeout for Lit component rendering
		testTimeout: 10000,
	},
});

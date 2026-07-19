import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const devPort = parseInt(process.env.DEV_PORT || "8111", 10);
const backendPort = process.env.BACKEND_PORT || "18111";

export default defineConfig({
	plugins: [tailwindcss()],
	esbuild: {
		tsconfigRaw: {
			compilerOptions: {
				experimentalDecorators: true,
				useDefineForClassFields: false,
			},
		},
	},
	optimizeDeps: {
		esbuildOptions: {
			tsconfigRaw: {
				compilerOptions: {
					experimentalDecorators: true,
					useDefineForClassFields: false,
				},
			},
		},
	},
	server: {
		port: devPort,
		hmr: {
			path: "/__hmr",
		},
		proxy: {
			"/ws": {
				target: `ws://localhost:${backendPort}`,
				ws: true,
			},
			"/api": {
				target: `http://localhost:${backendPort}`,
			},
		},
	},
	build: {
		outDir: "dist/client",
	},
});

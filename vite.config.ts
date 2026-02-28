import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

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
	server: {
		proxy: {
			"/ws": {
				target: "ws://localhost:3001",
				ws: true,
			},
		},
	},
	build: {
		outDir: "dist/client",
	},
});

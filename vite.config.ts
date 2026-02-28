import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import path from "node:path";

const devPort = parseInt(process.env.DEV_PORT || "8111", 10);
const backendPort = process.env.BACKEND_PORT || "18111";

// Stub out Node.js built-ins that get pulled in transitively by server-only
// code (AWS SDK, undici, etc.) via pi-ai barrel exports. These modules are
// never actually called at runtime in the browser.
const nodeBuiltins = [
	"assert", "async_hooks", "buffer", "child_process", "cluster", "console",
	"constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
	"events", "fs", "fs/promises", "http", "http2", "https", "inspector",
	"module", "net", "os", "path", "perf_hooks", "process", "punycode",
	"querystring", "readline", "repl", "sqlite", "stream", "string_decoder",
	"sys", "timers", "tls", "tty", "url", "util", "util/types", "v8", "vm",
	"worker_threads", "zlib",
];

function nodeStubPlugin(): Plugin {
	const stubIds = new Set<string>();
	for (const mod of nodeBuiltins) {
		stubIds.add(mod);
		stubIds.add(`node:${mod}`);
	}

	return {
		name: "node-stub",
		enforce: "pre",
		resolveId(id) {
			if (stubIds.has(id)) return { id: `\0node-stub:${id}`, syntheticNamedExports: true };
		},
		load(id) {
			if (id.startsWith("\0node-stub:")) {
				return `export default new Proxy({}, { get(_, key) { if (key === '__esModule') return true; return new Proxy(function(){}, { get: () => () => {}, apply: () => ({}) }); } });`;
			}
		},
	};
}

export default defineConfig({
	plugins: [tailwindcss(), nodeStubPlugin()],
	resolve: {
		alias: [
			{
				// Resolve pi-web-ui JS/TS imports from TypeScript source so we only
				// need to patch-package the .ts files (not compiled dist/).
				// The CSS import (@mariozechner/pi-web-ui/app.css) must NOT match.
				find: /^@mariozechner\/pi-web-ui$/,
				replacement: path.resolve(
					__dirname,
					"node_modules/@mariozechner/pi-web-ui/src/index.ts",
				),
			},
		],
	},
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

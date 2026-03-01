#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "../dist/server/server/server.js");

if (process.env.PIPANE_PRINT_ENTRY === "1") {
	process.stdout.write(serverEntry);
	process.exit(0);
}

const child = spawn(process.execPath, [serverEntry], {
	stdio: "inherit",
	env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
});

child.on("exit", (code) => {
	process.exit(code ?? 0);
});

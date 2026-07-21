#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "../dist/server/server/server.js");

if (process.env.PIPANE_PRINT_ENTRY === "1") {
	process.stdout.write(serverEntry);
	process.exit(0);
}

const args = process.argv.slice(2);
if (args[0] === "pair") {
	const endpoint = process.env.PIPANE_PAIR_ENDPOINT || `http://127.0.0.1:${process.env.PORT || "8222"}/api/pairing`;
	try {
		const headers = process.env.PIPANE_AUTH_TOKEN
			? { cookie: `pipane_auth=${encodeURIComponent(process.env.PIPANE_AUTH_TOKEN)}` }
			: undefined;
		const response = await fetch(endpoint, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
		const value = await response.json();
		if (!response.ok || typeof value?.url !== "string") throw new Error(value?.error || `Pairing request failed (${response.status})`);
		process.stdout.write(`${value.url}\n`);
		qrcode.generate(value.url, { small: true }, (code) => process.stdout.write(`${code}\n`));
		process.exit(0);
	} catch (error) {
		process.stderr.write(`Could not create pairing link: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}

// Pass through CLI args (e.g. --verbose)
const child = spawn(process.execPath, [serverEntry, ...args], {
	stdio: "inherit",
	env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
});

child.on("exit", (code) => {
	process.exit(code ?? 0);
});

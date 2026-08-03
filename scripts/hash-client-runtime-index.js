#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [indexPath, rendererPath, runtimeMode] = process.argv.slice(2);
if (!indexPath || !rendererPath || (runtimeMode !== "local" && runtimeMode !== "rendezvous")) {
	console.error("Usage: hash-client-runtime-index.js <index.html> <compiled-client-assets.js> <local|rendezvous>");
	process.exit(2);
}

const renderer = await import(pathToFileURL(path.resolve(rendererPath)).href);
if (typeof renderer.renderClientRuntimeIndex !== "function") {
	throw new Error("Compiled client asset module does not export renderClientRuntimeIndex");
}
const source = readFileSync(indexPath, "utf8");
const rendered = renderer.renderClientRuntimeIndex(source, runtimeMode);
process.stdout.write(createHash("sha256").update(rendered, "utf8").digest("hex"));

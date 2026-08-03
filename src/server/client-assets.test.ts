// @vitest-environment node

import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { mountClientApp } from "./client-assets.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function startClient(runtimeMode: "local" | "rendezvous") {
	const directory = mkdtempSync(path.join(tmpdir(), "pipane-client-assets-"));
	const assets = path.join(directory, "assets");
	mkdirSync(assets);
	writeFileSync(path.join(directory, "index.html"), '<!doctype html><html><head><meta name="pipane-runtime" content="local" /></head><body>shell</body></html>');
	writeFileSync(path.join(directory, "favicon.png"), "icon");
	const source = "export const startupSentinel = 'compressed';\n".repeat(100);
	writeFileSync(path.join(assets, "main-hash.js"), source);
	writeFileSync(path.join(assets, "main-hash.js.br"), brotliCompressSync(source));
	writeFileSync(path.join(assets, "main-hash.js.gz"), gzipSync(source));

	const app = express();
	mountClientApp(app, {
		clientDist: directory,
		runtimeMode,
		isAppPath: (pathname) => pathname === "/" || pathname === "/settings",
	});
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => closeServer(server));
	cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not bind");
	return { baseUrl: `http://127.0.0.1:${address.port}`, source };
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("client asset delivery", () => {
	it("serves Brotli and gzip representations with immutable caching", async () => {
		const { baseUrl, source } = await startClient("local");
		const brotli = await fetch(`${baseUrl}/assets/main-hash.js`, { headers: { "Accept-Encoding": "br, gzip" } });
		expect(brotli.headers.get("content-encoding")).toBe("br");
		expect(brotli.headers.get("content-type")).toContain("text/javascript");
		expect(brotli.headers.get("cache-control")).toContain("max-age=31536000");
		expect(brotli.headers.get("cache-control")).toContain("immutable");
		expect(brotli.headers.get("vary")).toContain("Accept-Encoding");
		expect(await brotli.text()).toBe(source);

		const gzip = await fetch(`${baseUrl}/assets/main-hash.js`, { headers: { "Accept-Encoding": "gzip" } });
		expect(gzip.headers.get("content-encoding")).toBe("gzip");
		expect(await gzip.text()).toBe(source);
	});

	it("injects runtime mode into revalidated application HTML", async () => {
		const { baseUrl } = await startClient("rendezvous");
		const response = await fetch(`${baseUrl}/settings`);
		expect(response.headers.get("cache-control")).toBe("no-cache");
		expect(await response.text()).toContain('<meta name="pipane-runtime" content="rendezvous" />');
	});
});

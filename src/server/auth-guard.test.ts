/** @vitest-environment node */

import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { AuthGuard, type AuthGuardOptions } from "./auth-guard.js";

type RunningServer = {
	server: Server;
	wss: WebSocketServer;
	port: number;
	baseUrl: string;
	wsUrl: string;
};

async function startServer(options: AuthGuardOptions, instanceId: string): Promise<RunningServer> {
	const app = express();
	const authGuard = new AuthGuard(options);
	authGuard.register(app);
	app.get("/api/sessions", (_req, res) => res.json([]));
	app.get("/debug/pool", (_req, res) => res.json({ processes: [] }));
	app.get("/api/debug/health", (_req, res) => res.json({ ok: true, instanceId }));

	const server = createServer(app);
	const wss = new WebSocketServer({ server, path: "/ws" });
	wss.on("connection", (ws, req) => {
		if (!authGuard.isAuthorizedRequest(req)) {
			ws.close(1008, "Unauthorized");
			return;
		}
		ws.send(JSON.stringify({ type: "init" }));
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Auth test server did not bind to a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});

	return {
		server,
		wss,
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
	};
}

async function stopServer(running: RunningServer | null): Promise<void> {
	if (!running) return;
	for (const client of running.wss.clients) client.terminate();
	await new Promise<void>((resolve) => running.wss.close(() => resolve()));
	await new Promise<void>((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve()));
}

function extractCookiePair(setCookieHeader: string | null): string {
	expect(setCookieHeader).toBeTruthy();
	return (setCookieHeader || "").split(";")[0];
}

describe("auth guard", () => {
	let server: RunningServer | null = null;

	beforeAll(async () => {
		server = await startServer({ token: "test-auth-token", disableLocalBypass: true }, "remote-auth-test");
	});

	afterAll(async () => {
		await stopServer(server);
		server = null;
	});

	it("blocks protected HTTP endpoints without auth", async () => {
		const root = await fetch(`${server!.baseUrl}/`);
		expect(root.status).toBe(401);

		const api = await fetch(`${server!.baseUrl}/api/sessions`);
		expect(api.status).toBe(401);

		const debug = await fetch(`${server!.baseUrl}/debug/pool`);
		expect(debug.status).toBe(401);
	});

	it("only accepts /auth with valid token and then allows access with cookie", async () => {
		const bad = await fetch(`${server!.baseUrl}/auth?token=wrong-token`);
		expect(bad.status).toBe(401);

		const good = await fetch(`${server!.baseUrl}/auth?token=test-auth-token`, { redirect: "manual" });
		expect(good.status).toBe(302);
		const cookiePair = extractCookiePair(good.headers.get("set-cookie"));
		expect(cookiePair.startsWith("pipane_auth=")).toBe(true);

		const authed = await fetch(`${server!.baseUrl}/api/sessions`, {
			headers: { Cookie: cookiePair },
		});
		expect(authed.status).toBe(200);
	});

	it("blocks unauthorized websocket and allows authorized websocket", async () => {
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(server!.wsUrl);
			ws.on("close", (code) => {
				try {
					expect(code).toBe(1008);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			ws.on("error", () => {
				// Expected on some platforms when closed immediately by the server.
			});
		});

		const authResponse = await fetch(`${server!.baseUrl}/auth?token=test-auth-token`, { redirect: "manual" });
		const cookiePair = extractCookiePair(authResponse.headers.get("set-cookie"));

		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(server!.wsUrl, { headers: { Cookie: cookiePair } });
			ws.on("message", (raw) => {
				try {
					const message = JSON.parse(raw.toString("utf8"));
					expect(message.type).toBe("init");
					ws.close();
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			ws.on("error", reject);
		});
	});
});

describe("localhost bypass", () => {
	let server: RunningServer | null = null;

	beforeAll(async () => {
		server = await startServer({ token: "test-auth-token" }, "auth-test-instance");
	});

	afterAll(async () => {
		await stopServer(server);
		server = null;
	});

	it("localhost is allowed, identifies the instance, and sets auth cookie automatically", async () => {
		const response = await fetch(`${server!.baseUrl}/api/sessions`);
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie") || "").toContain("pipane_auth=");

		const health = await fetch(`${server!.baseUrl}/api/debug/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			ok: true,
			instanceId: "auth-test-instance",
		});
	});
});

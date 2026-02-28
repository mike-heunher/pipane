/** @vitest-environment node */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";

type RunningServer = {
	proc: ChildProcessWithoutNullStreams;
	port: number;
	baseUrl: string;
	wsUrl: string;
};

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const s = createServer();
		s.on("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			if (!addr || typeof addr === "string") {
				s.close();
				reject(new Error("Failed to allocate free port"));
				return;
			}
			const port = addr.port;
			s.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

async function startServer(envOverrides: Record<string, string>): Promise<RunningServer> {
	const port = await getFreePort();
	const env = {
		...process.env,
		PORT: String(port),
		PI_CLI: "definitely-not-an-installed-pi-binary",
		PI_WEB_AUTH_TOKEN: "test-auth-token",
		...envOverrides,
	};

	const proc = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
		cwd: process.cwd(),
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for server startup")), 15000);
		const onData = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (text.includes("pi-web server listening")) {
				clearTimeout(timeout);
				proc.stdout.off("data", onData);
				proc.stderr.off("data", onData);
				resolve();
			}
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.on("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Server exited before startup (code=${code})`));
		});
	});

	return {
		proc,
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
	};
}

async function stopServer(server: RunningServer | null): Promise<void> {
	if (!server) return;
	if (server.proc.killed) return;
	await new Promise<void>((resolve) => {
		server.proc.once("exit", () => resolve());
		server.proc.kill("SIGTERM");
		setTimeout(() => {
			if (!server.proc.killed) server.proc.kill("SIGKILL");
			resolve();
		}, 3000);
	});
}

function extractCookiePair(setCookieHeader: string | null): string {
	expect(setCookieHeader).toBeTruthy();
	return (setCookieHeader || "").split(";")[0];
}

describe("auth guard", () => {
	let server: RunningServer | null = null;

	beforeAll(async () => {
		server = await startServer({ PI_WEB_DISABLE_LOCAL_BYPASS: "1" });
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

		const good = await fetch(`${server!.baseUrl}/auth?token=test-auth-token`);
		expect(good.status).toBe(200);
		const cookiePair = extractCookiePair(good.headers.get("set-cookie"));
		expect(cookiePair.startsWith("pi_web_auth=")).toBe(true);

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
				} catch (err) {
					reject(err);
				}
			});
			ws.on("error", () => {
				// Expected on some platforms when closed immediately by server.
			});
		});

		const authResp = await fetch(`${server!.baseUrl}/auth?token=test-auth-token`);
		const cookiePair = extractCookiePair(authResp.headers.get("set-cookie"));

		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(server!.wsUrl, {
				headers: { Cookie: cookiePair },
			});

			ws.on("message", (raw) => {
				try {
					const msg = JSON.parse(raw.toString("utf8"));
					expect(msg.type).toBe("init");
					ws.close();
					resolve();
				} catch (err) {
					reject(err);
				}
			});
			ws.on("error", reject);
		});
	});
});

describe("localhost bypass", () => {
	let server: RunningServer | null = null;

	beforeAll(async () => {
		server = await startServer({});
	});

	afterAll(async () => {
		await stopServer(server);
		server = null;
	});

	it("localhost is allowed and sets auth cookie automatically", async () => {
		const res = await fetch(`${server!.baseUrl}/api/sessions`);
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie") || "").toContain("pi_web_auth=");
	});
});

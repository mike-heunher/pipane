/** @vitest-environment node */

import express from "express";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateSnapshot } from "../shared/updates.js";
import { registerUpdateApi, type UpdateApiManager } from "./update-api.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startApi(manager: UpdateApiManager): Promise<string> {
	const app = express();
	registerUpdateApi(app, manager);
	const server = createServer(app);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind");
	return `http://127.0.0.1:${address.port}`;
}

function makeManager() {
	let snapshot: UpdateSnapshot = {
		checkedAt: "2026-07-20T00:00:00.000Z",
		notices: [{ target: "pi", currentVersion: "1.0.0", latestVersion: "1.1.0" }],
	};
	const manager: UpdateApiManager = {
		check: vi.fn(async () => snapshot),
		run: vi.fn(async (target) => {
			snapshot = { checkedAt: "2026-07-20T00:01:00.000Z", notices: [] };
			return { target, message: "updated", restartRequired: false };
		}),
		get currentSnapshot() { return snapshot; },
	};
	return manager;
}

describe("update API", () => {
	it("returns checks and runs a confirmed update action", async () => {
		const manager = makeManager();
		const baseUrl = await startApi(manager);

		const check = await fetch(`${baseUrl}/api/updates`);
		expect(check.status).toBe(200);
		expect((await check.json() as UpdateSnapshot).notices[0].target).toBe("pi");

		const update = await fetch(`${baseUrl}/api/updates/pi`, {
			method: "POST",
			headers: { "X-Pipane-Action": "update" },
		});
		expect(update.status).toBe(200);
		expect(await update.json()).toMatchObject({
			result: { target: "pi", message: "updated" },
			snapshot: { notices: [] },
		});
		expect(manager.run).toHaveBeenCalledWith("pi");
	});

	it("rejects requests without the action header or a known target", async () => {
		const manager = makeManager();
		const baseUrl = await startApi(manager);

		expect((await fetch(`${baseUrl}/api/updates/pi`, { method: "POST" })).status).toBe(400);
		expect((await fetch(`${baseUrl}/api/updates/other`, {
			method: "POST",
			headers: { "X-Pipane-Action": "update" },
		})).status).toBe(400);
		expect(manager.run).not.toHaveBeenCalled();
	});

	it("reports check and update failures without crashing the server", async () => {
		const snapshot: UpdateSnapshot = { checkedAt: "x", notices: [] };
		const manager: UpdateApiManager = {
			check: vi.fn(async () => { throw new Error("check failed"); }),
			run: vi.fn(async () => { throw new Error("update failed"); }),
			currentSnapshot: snapshot,
		};
		const baseUrl = await startApi(manager);

		expect((await fetch(`${baseUrl}/api/updates`)).status).toBe(500);
		const update = await fetch(`${baseUrl}/api/updates/pi`, {
			method: "POST",
			headers: { "X-Pipane-Action": "update" },
		});
		expect(update.status).toBe(409);
		expect(await update.json()).toEqual({ error: "update failed" });
	});
});

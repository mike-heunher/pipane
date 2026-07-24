import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
	BrowserSessionSyncCache,
	MemorySessionSyncCache,
} from "./session-sync-cache.js";

const databases: string[] = [];

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	});
}

afterEach(async () => {
	await Promise.all(databases.splice(0).map(deleteDatabase));
});

const record = {
	json: JSON.stringify({ messages: [{ role: "user", content: "cached" }] }),
	hash: "a".repeat(64),
	revision: 7,
	updatedAt: 123,
};

describe("session sync cache", () => {
	it("keeps adapter-local baselines in memory", async () => {
		const cache = new MemorySessionSyncCache();
		cache.set("/one.jsonl", record);
		expect(await cache.get("/one.jsonl")).toEqual(record);
		cache.delete("/one.jsonl");
		expect(await cache.get("/one.jsonl")).toBeUndefined();
	});

	it("persists records across cache instances and scopes identical paths", async () => {
		const databaseName = `pipane-sync-cache-${crypto.randomUUID()}`;
		databases.push(databaseName);
		const first = new BrowserSessionSyncCache("backend-one", { databaseName, writeDelayMs: 0 });
		first.set("/same.jsonl", record);
		await first.flush();

		const restored = new BrowserSessionSyncCache("backend-one", { databaseName });
		const otherBackend = new BrowserSessionSyncCache("backend-two", { databaseName });
		expect(await restored.get("/same.jsonl")).toEqual(record);
		expect(await otherBackend.get("/same.jsonl")).toBeUndefined();

		restored.delete("/same.jsonl");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await new BrowserSessionSyncCache("backend-one", { databaseName }).get("/same.jsonl"))
			.toBeUndefined();
	});
});

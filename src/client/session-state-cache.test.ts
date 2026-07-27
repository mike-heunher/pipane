import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { computeHash } from "../shared/jsonl-sync.js";
import { IndexedDbSessionStateCache } from "./session-state-cache.js";

function sessionJson(label: string) {
	return JSON.stringify({
		messages: [
			{ role: "user", content: label, timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: `${label} response` }], timestamp: 2 },
		],
		isStreaming: false,
		pendingToolCalls: [],
		toolCallTimings: {},
		model: null,
		thinkingLevel: "off",
		steeringQueue: [],
	});
}

describe("IndexedDbSessionStateCache", () => {
	it("restores a serialized state and its content-addressed message inventory", async () => {
		const cache = new IndexedDbSessionStateCache({ indexedDB: new IDBFactory() });
		const json = sessionJson("cached");
		const hash = await computeHash(json);
		await cache.save("backend-a", "/sessions/a.jsonl", json, hash);

		const restored = await cache.load("backend-a", "/sessions/a.jsonl");
		expect(restored).toMatchObject({ json, hash });
		expect(restored?.messageHashes).toHaveLength(2);
		expect(restored?.messageObjects.get(restored.messageHashes[0])).toMatchObject({ role: "user", content: "cached" });
	});

	it("evicts least-recently-saved sessions by count", async () => {
		const cache = new IndexedDbSessionStateCache({ indexedDB: new IDBFactory(), maxSessions: 1 });
		const first = sessionJson("first");
		const second = sessionJson("second");
		await cache.save("backend-a", "/sessions/first.jsonl", first, await computeHash(first));
		await new Promise((resolve) => setTimeout(resolve, 1));
		await cache.save("backend-a", "/sessions/second.jsonl", second, await computeHash(second));

		expect(await cache.load("backend-a", "/sessions/first.jsonl")).toBeUndefined();
		expect(await cache.load("backend-a", "/sessions/second.jsonl")).toMatchObject({ json: second });
	});

	it("keeps identical paths isolated by backend", async () => {
		const cache = new IndexedDbSessionStateCache({ indexedDB: new IDBFactory() });
		const one = sessionJson("one");
		const two = sessionJson("two");
		await cache.save("backend-one", "/sessions/shared.jsonl", one, await computeHash(one));
		await cache.save("backend-two", "/sessions/shared.jsonl", two, await computeHash(two));

		expect((await cache.load("backend-one", "/sessions/shared.jsonl"))?.state.messages[0]).toMatchObject({ content: "one" });
		expect((await cache.load("backend-two", "/sessions/shared.jsonl"))?.state.messages[0]).toMatchObject({ content: "two" });
	});
});

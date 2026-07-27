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

	it("loads a small render-ready tail before the full snapshot", async () => {
		const cache = new IndexedDbSessionStateCache({ indexedDB: new IDBFactory() });
		const messages = Array.from({ length: 80 }, (_, index) => ({
			role: "user",
			content: `message ${index + 1}`,
			timestamp: index + 1,
		}));
		const json = JSON.stringify({
			messages,
			isStreaming: false,
			pendingToolCalls: [],
			toolCallTimings: {},
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});
		await cache.save("backend-a", "/sessions/preview.jsonl", json, await computeHash(json));

		const preview = await cache.loadPreview("backend-a", "/sessions/preview.jsonl");
		expect(preview?.state.messages).toHaveLength(50);
		expect(preview?.state.messages[0]).toMatchObject({ content: "message 31" });
		expect((await cache.load("backend-a", "/sessions/preview.jsonl"))?.state.messages).toHaveLength(80);
	});

	it("omits a preview that would duplicate an oversized message", async () => {
		const cache = new IndexedDbSessionStateCache({ indexedDB: new IDBFactory() });
		const json = sessionJson("x".repeat(300 * 1024));
		await cache.save("backend-a", "/sessions/oversized.jsonl", json, await computeHash(json));

		expect(await cache.loadPreview("backend-a", "/sessions/oversized.jsonl")).toBeUndefined();
		expect(await cache.load("backend-a", "/sessions/oversized.jsonl")).toBeDefined();
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

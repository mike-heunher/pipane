import { afterEach, describe, expect, it, vi } from "vitest";
import { computeHash, computePatches } from "../shared/jsonl-sync.js";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { WS_PROTOCOL_VERSION } from "../shared/ws-protocol.js";

const SESSION_PATH = "/tmp/sessions/sync-burst.jsonl";

function sessionState(text: string) {
	return JSON.stringify({
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		isStreaming: true,
		pendingToolCalls: [],
		toolCallTimings: {},
		model: { provider: "mock", modelId: "mock-model" },
		thinkingLevel: "medium",
		steeringQueue: [],
	});
}

function createAdapter() {
	const adapter = new WsAgentAdapter();
	const sent: any[] = [];

	(adapter as any).ws = {
		readyState: WebSocket.OPEN,
		send: vi.fn((raw: string) => {
			sent.push(JSON.parse(raw));
		}),
		close: vi.fn(),
	};
	(adapter as any)._sessionPath = SESSION_PATH;
	(adapter as any)._sessionNonce = 7;
	(adapter as any)._sessionStatus = "attached";

	return { adapter, sent };
}

const revisions = new WeakMap<WsAgentAdapter, number>();

function deliver(adapter: WsAgentAdapter, message: Record<string, unknown>) {
	const revision = (revisions.get(adapter) ?? 0) + 1;
	revisions.set(adapter, revision);
	(adapter as any).handleMessage(JSON.stringify({
		protocolVersion: WS_PROTOCOL_VERSION,
		type: "session_sync",
		sessionPath: SESSION_PATH,
		revision,
		...message,
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("WsAgentAdapter burst session sync", () => {
	it("applies every hash-dependent delta received behind a full snapshot without recovery", async () => {
		// Keep the whole burst in one animation frame. This mirrors fast token
		// streaming and deterministically exposes latest-delta coalescing bugs.
		vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter, sent } = createAdapter();
		const a = adapter as any;

		const states = ["start", "start one", "start one two", "start one two three"].map(sessionState);
		const hashes = await Promise.all(states.map(computeHash));

		// The server advances its per-client hash after every send. Therefore the
		// client must retain all three operations, even if they arrive in one frame.
		deliver(adapter, { op: "full", data: states[0], hash: hashes[0] });
		deliver(adapter, {
			op: "delta",
			patches: computePatches(states[0], states[1]),
			baseHash: hashes[0],
			hash: hashes[1],
		});
		deliver(adapter, {
			op: "delta",
			patches: computePatches(states[1], states[2]),
			baseHash: hashes[1],
			hash: hashes[2],
		});
		await a.flushSessionSyncQueue();

		// The next frame starts from the hash the server believes we have. Dropping
		// either earlier delta makes this operation request a full sync forever.
		deliver(adapter, {
			op: "delta",
			patches: computePatches(states[2], states[3]),
			baseHash: hashes[2],
			hash: hashes[3],
		});
		await a.flushSessionSyncQueue();

		expect(a._syncHash).toBe(hashes[3]);
		expect(a._syncJson).toBe(states[3]);
		expect((adapter.state.messages[0] as any).content[0].text).toBe("start one two three");
		expect(sent.filter((message) => message.type === "subscribe_session")).toEqual([]);
		expect(warn).not.toHaveBeenCalledWith(
			"[jsonl-sync] Base hash mismatch, need full sync",
			expect.anything(),
		);
		expect(error).not.toHaveBeenCalledWith("[ws-adapter] Sync verification failed, re-subscribing");
	});

	it("recovers with a full subscription when a session revision is skipped", async () => {
		vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter, sent } = createAdapter();
		const a = adapter as any;
		const first = sessionState("one");
		const second = sessionState("two");
		const firstHash = await computeHash(first);
		const secondHash = await computeHash(second);

		deliver(adapter, { op: "full", data: first, hash: firstHash });
		await a.flushSessionSyncQueue();
		deliver(adapter, {
			revision: 3,
			op: "delta",
			patches: computePatches(first, second),
			baseHash: firstHash,
			hash: secondHash,
		});
		await a.flushSessionSyncQueue();

		const subscribe = sent.find((message) => message.type === "subscribe_session");
		expect(subscribe).toMatchObject({
			protocolVersion: WS_PROTOCOL_VERSION,
			sessionPath: SESSION_PATH,
		});
		expect(consoleError).toHaveBeenCalledWith(
			"[ws-adapter] Session revision gap, re-subscribing",
			expect.objectContaining({ expected: 2, actual: 3 }),
		);
		(adapter as any).handleMessage(JSON.stringify({
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "response",
			id: subscribe.id,
			command: "subscribe_session",
			success: true,
			data: {},
		}));
		consoleError.mockRestore();
	});

	it("publishes only the final state from a queued burst", async () => {
		vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
		const { adapter } = createAdapter();
		const a = adapter as any;
		const contentChange = vi.fn();
		const statusChange = vi.fn();
		const steeringChange = vi.fn();
		adapter.onContentChange(contentChange);
		adapter.onStatusChange(statusChange);
		adapter.onSteeringQueueChange(steeringChange);

		const states = Array.from({ length: 25 }, (_, index) => sessionState(`chunk ${index}`));
		const hashes = await Promise.all(states.map(computeHash));
		deliver(adapter, { op: "full", data: states[0], hash: hashes[0] });
		for (let index = 1; index < states.length; index++) {
			deliver(adapter, {
				op: "delta",
				patches: computePatches(states[index - 1], states[index]),
				baseHash: hashes[index - 1],
				hash: hashes[index],
			});
		}

		await a.flushSessionSyncQueue();

		expect((adapter.state.messages[0] as any).content[0].text).toBe("chunk 24");
		expect(contentChange).toHaveBeenCalledTimes(1);
		expect(statusChange).toHaveBeenCalledTimes(1);
		expect(steeringChange).not.toHaveBeenCalled();
	});
});

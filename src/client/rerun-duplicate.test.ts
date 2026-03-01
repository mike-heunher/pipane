/**
 * Tests that the flat state model (session_sync) doesn't produce duplicates.
 *
 * Previously, the two-zone rendering model (message-list + streaming-container)
 * could cause duplicate rendering between message_end and agent_end. With the
 * flat state model, all state comes from session_sync and there's a single
 * messages array to render. These tests verify the basics still work.
 */

import { describe, it, expect, vi } from "vitest";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { computeHash } from "../shared/jsonl-sync.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestAdapter() {
	const adapter = new WsAgentAdapter();
	const sent: any[] = [];
	let messageHandler: ((ev: { data: string }) => void) | null = null;

	const mockWs = {
		readyState: 1,
		send: vi.fn((data: string) => {
			const parsed = JSON.parse(data);
			sent.push(parsed);
			if (parsed.id) {
				setTimeout(() => {
					messageHandler?.({
						data: JSON.stringify({
							type: "response",
							id: parsed.id,
							success: true,
							data: {},
						}),
					});
				}, 0);
			}
		}),
		close: vi.fn(),
		onopen: null as any,
		onerror: null as any,
		onclose: null as any,
		onmessage: null as any,
	};

	(adapter as any).ws = mockWs;

	Object.defineProperty(mockWs, "onmessage", {
		set(fn) { messageHandler = fn; },
		get() { return messageHandler; },
	});

	messageHandler = (ev: { data: string }) => {
		(adapter as any).handleMessage(ev.data);
	};

	const simulateServerMessage = (msg: any) => {
		messageHandler?.({ data: JSON.stringify(msg) });
	};

	return { adapter, sent, simulateServerMessage };
}

const SESSION_PATH = "/tmp/sessions/test-session.jsonl";

function setupAdapter() {
	const { adapter, sent, simulateServerMessage } = createTestAdapter();

	(adapter as any)._sessionPath = SESSION_PATH;
	(adapter as any)._sessionId = "test-session";
	(adapter as any)._sessionStatus = "detached";
	(adapter as any)._state.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

	return { adapter, sent, simulateServerMessage };
}

/**
 * Simulate a session_sync push with a flat state.
 * This is how the server sends ALL state now.
 * Must be async because computeHash is async (uses SubtleCrypto).
 */
async function pushSessionSync(simulateServerMessage: (msg: any) => void, state: any) {
	const json = JSON.stringify(state);
	const hash = await computeHash(json);
	simulateServerMessage({
		type: "session_sync",
		sessionPath: SESSION_PATH,
		op: "full",
		data: json,
		hash,
	});
	// Wait a tick for async hash verification in applySyncOp to complete
	await new Promise(r => setTimeout(r, 10));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Flat state model (no duplicate rendering)", () => {
	it("session_sync sets messages from flat array", async () => {
		const { adapter, simulateServerMessage } = setupAdapter();

		await pushSessionSync(simulateServerMessage, {
			messages: [
				{ role: "user", content: "hello", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1001 },
			],
			isStreaming: false,
			pendingToolCalls: [],
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});

		expect(adapter.state.messages).toHaveLength(2);
		expect(adapter.state.messages[0].role).toBe("user");
		expect(adapter.state.messages[1].role).toBe("assistant");
		expect(adapter.state.isStreaming).toBe(false);
	});

	it("session_sync with streaming includes stream message in flat array", async () => {
		const { adapter, simulateServerMessage } = setupAdapter();

		await pushSessionSync(simulateServerMessage, {
			messages: [
				{ role: "user", content: "hello", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "text", text: "I'm thinking..." }], timestamp: 1001 },
			],
			isStreaming: true,
			pendingToolCalls: [],
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});

		expect(adapter.state.messages).toHaveLength(2);
		expect(adapter.state.isStreaming).toBe(true);
		// streamMessage is always null in the new model — everything is in messages
		expect(adapter.state.streamMessage).toBeNull();
	});

	it("session_sync with pending tool calls and partial results", async () => {
		const { adapter, simulateServerMessage } = setupAdapter();

		await pushSessionSync(simulateServerMessage, {
			messages: [
				{ role: "user", content: "run ls", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "Bash", arguments: '{"command":"ls"}' }], stopReason: "toolUse", timestamp: 1001 },
				// Partial tool result (synthetic, from server)
				{ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "file1.ts\n" }], isError: false, timestamp: 1002 },
			],
			isStreaming: true,
			pendingToolCalls: ["call_1"],
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});

		expect(adapter.state.messages).toHaveLength(3);
		expect(adapter.state.isStreaming).toBe(true);
		expect(adapter.pendingToolCallIds.has("call_1")).toBe(true);
	});

	it("no duplicates: sequential session_sync pushes replace state cleanly", async () => {
		const { adapter, simulateServerMessage } = setupAdapter();

		// First push: streaming
		await pushSessionSync(simulateServerMessage, {
			messages: [
				{ role: "user", content: "hello", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 1001 },
			],
			isStreaming: true,
			pendingToolCalls: [],
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});
		expect(adapter.state.messages).toHaveLength(2);

		// Second push: message complete, tool executing
		await pushSessionSync(simulateServerMessage, {
			messages: [
				{ role: "user", content: "hello", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "text", text: "done" }, { type: "toolCall", id: "t1", name: "Bash", arguments: "{}" }], stopReason: "toolUse", timestamp: 1001 },
			],
			isStreaming: true,
			pendingToolCalls: ["t1"],
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});
		// Still 2 messages — no duplication
		expect(adapter.state.messages).toHaveLength(2);

		// Third push: tool done, final response
		await pushSessionSync(simulateServerMessage, {
			messages: [
				{ role: "user", content: "hello", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "text", text: "done" }, { type: "toolCall", id: "t1", name: "Bash", arguments: "{}" }], stopReason: "toolUse", timestamp: 1001 },
				{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "output" }], isError: false, timestamp: 1002 },
				{ role: "assistant", content: [{ type: "text", text: "All done!" }], timestamp: 1003 },
			],
			isStreaming: false,
			pendingToolCalls: [],
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});
		expect(adapter.state.messages).toHaveLength(4);
		expect(adapter.state.isStreaming).toBe(false);
	});

	it("session_detached clears streaming state", async () => {
		const { adapter, simulateServerMessage } = setupAdapter();

		// Start streaming
		await pushSessionSync(simulateServerMessage, {
			messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			isStreaming: true,
			pendingToolCalls: [],
			model: null,
			thinkingLevel: "off",
			steeringQueue: [],
		});
		expect(adapter.state.isStreaming).toBe(true);

		// Session detached
		simulateServerMessage({ type: "session_detached", sessionPath: SESSION_PATH });
		expect(adapter.state.isStreaming).toBe(false);
		expect(adapter.sessionStatus).toBe("detached");
	});
});

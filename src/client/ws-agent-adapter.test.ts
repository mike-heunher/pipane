/**
 * Tests for WsAgentAdapter steering / prompt routing.
 *
 * Verifies:
 * - Prompts to an idle session are sent as "prompt" (not "steer")
 * - Prompts to a running session are sent as "steer"
 * - When session A is running and user switches to idle session B,
 *   a prompt to B is sent as "prompt" (NOT queued as steer) ← the bug
 * - Steering queue only fills for the running session
 * - steer() method also respects per-session running state
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WsAgentAdapter, type WsAgentAdapterOptions } from "./ws-agent-adapter.js";
import { computeHash, computePatches } from "../shared/jsonl-sync.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create an adapter with a mocked WebSocket. Returns the adapter and a
 * spy that captures all messages sent over the WS.
 */
function createTestAdapter(options: Pick<WsAgentAdapterOptions, "fetch"> = {}) {
	const sent: any[] = [];
	let messageHandler: ((ev: { data: string }) => void) | null = null;

	const mockWs = {
		readyState: 1,
		send: vi.fn((data: string) => {
			const parsed = JSON.parse(data);
			sent.push(parsed);
			if (!parsed.id || !messageHandler) return;

			// Resolve requests synchronously: send() installs its pending request
			// before writing to the socket, so arbitrary sleeps are unnecessary.
			if (parsed.type === "prompt" && parsed.sessionPath === "__new__") {
				messageHandler({ data: JSON.stringify({
					type: "session_attached",
					sessionPath: "/tmp/sessions/new-session.jsonl",
					cwd: "/tmp",
				}) });
			}
			messageHandler({ data: JSON.stringify({
				type: "response",
				id: parsed.id,
				success: true,
				data: {},
			}) });
		}),
		close: vi.fn(),
		onopen: null as any,
		onerror: null as any,
		onclose: null as any,
		onmessage: null as any,
	};

	Object.defineProperty(mockWs, "onmessage", {
		set(fn) { messageHandler = fn; },
		get() { return messageHandler; },
	});

	const adapter = new WsAgentAdapter({
		socket: mockWs as any,
		fetch: options.fetch ?? (async (input) => {
			throw new Error(`Unexpected adapter HTTP request: ${String(input)}`);
		}),
		startTrace: () => () => {},
		getTraceId: () => "test-trace",
	});

	return { adapter, sent, mockWs, simulateServerMessage: (msg: any) => messageHandler?.({ data: JSON.stringify(msg) }) };
}

/**
 * Set up an adapter that has an existing session loaded in detached state.
 */
function setupWithSession(sessionPath: string) {
	const { adapter, sent, mockWs, simulateServerMessage } = createTestAdapter();

	// Set session path and status to detached (like after switchSession)
	(adapter as any)._sessionPath = sessionPath;
	(adapter as any)._sessionId = "test-session";
	(adapter as any)._sessionStatus = "detached";

	// Give it a model so prompt() doesn't bail
	(adapter as any)._state.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

	return { adapter, sent, mockWs, simulateServerMessage };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("WsAgentAdapter transport injection", () => {
	it("uses the injected HTTP transport instead of global fetch", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));
		const { adapter } = createTestAdapter({ fetch: fetchMock });

		await expect(adapter.listSessions()).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {}, "frontend_fetch_sessions");
	});
});

describe("WsAgentAdapter prompt routing", () => {
	describe("prompt to idle session sends 'prompt' command", () => {
		it("sends a prompt command when session is not running", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent } = setupWithSession(sessionPath);

			// Session is not in globalSessionStatus → idle
			await adapter.prompt("hello world");

			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].sessionPath).toBe(sessionPath);
			expect(promptMsgs[0].message).toBe("hello world");

			// No steer messages
			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);
		});

		it("sends the displayed model, thinking level, and control revision", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent } = setupWithSession(sessionPath);
			(adapter as any)._state.model = {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				reasoning: true,
				thinkingLevelMap: { max: "max" },
			};
			adapter.setThinkingLevel("max");
			const revision = (adapter as any)._pendingControl.revision;

			await adapter.prompt("use effort");

			const prompt = sent.find((message) => message.type === "prompt");
			expect(prompt).toMatchObject({
				model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
				thinkingLevel: "max",
				controlRevision: revision,
			});
		});

		it("sends a prompt command when session status is 'done'", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent, simulateServerMessage } = setupWithSession(sessionPath);

			// Mark session as "done" (previously ran, now finished)
			(adapter as any)._globalSessionStatus.set(sessionPath, "done");

			await adapter.prompt("hello again");

			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].message).toBe("hello again");

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);
		});
	});

	describe("prompt to running session sends 'steer' command", () => {
		it("sends a steer when the current session is running", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent } = setupWithSession(sessionPath);

			// Mark THIS session as running
			(adapter as any)._globalSessionStatus.set(sessionPath, "running");

			await adapter.prompt("steer me");

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(1);
			expect(steerMsgs[0].sessionPath).toBe(sessionPath);
			expect(steerMsgs[0].message).toBe("steer me");

			// Should NOT have sent a prompt command
			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(0);
		});

		it("adds to steering queue when routing as steer", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter } = setupWithSession(sessionPath);

			(adapter as any)._globalSessionStatus.set(sessionPath, "running");

			expect(adapter.steeringQueue).toHaveLength(0);

			await adapter.prompt("steer msg 1");
			await adapter.prompt("steer msg 2");

			expect(adapter.steeringQueue).toHaveLength(2);
			expect(adapter.steeringQueue[0]).toBe("steer msg 1");
			expect(adapter.steeringQueue[1]).toBe("steer msg 2");
		});
	});

	describe("cross-conversation isolation (the bug fix)", () => {
		it("does NOT steer when another session is running but current is idle", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter, sent } = setupWithSession(sessionB);

			// Session A is running, but we are viewing session B (which is idle)
			(adapter as any)._globalSessionStatus.set(sessionA, "running");
			// Session B has no status → idle

			await adapter.prompt("prompt for B");

			// Should send a prompt, NOT a steer
			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].sessionPath).toBe(sessionB);
			expect(promptMsgs[0].message).toBe("prompt for B");

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);

			// Steering queue should be empty
			expect(adapter.steeringQueue).toHaveLength(0);
		});

		it("does NOT steer when another session is running but current session is not", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter, sent } = setupWithSession(sessionB);

			// Session A is running on the server, but we're viewing session B (idle)
			(adapter as any)._globalSessionStatus.set(sessionA, "running");
			// Session B is idle (not in the map)

			await adapter.prompt("this should be a prompt not steer");

			// Should send prompt, NOT steer
			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].message).toBe("this should be a prompt not steer");

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);
		});

		it("steers correctly when you switch back to the running session", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";

			// Start on session A which is running
			const { adapter, sent } = setupWithSession(sessionA);
			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			// Send a steer to session A (should work)
			await adapter.prompt("steer for A");

			expect(sent.filter((m) => m.type === "steer")).toHaveLength(1);
			expect(sent.filter((m) => m.type === "steer")[0].sessionPath).toBe(sessionA);

			// Now switch to session B (idle)
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";

			// Send prompt to B (should be a prompt, not steer)
			await adapter.prompt("prompt for B");

			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].sessionPath).toBe(sessionB);

			// Switch back to session A (still running)
			(adapter as any)._sessionPath = sessionA;
			(adapter as any)._sessionId = "session-a";

			// Send another steer to A
			await adapter.prompt("another steer for A");

			const allSteers = sent.filter((m) => m.type === "steer");
			expect(allSteers).toHaveLength(2);
			expect(allSteers[1].sessionPath).toBe(sessionA);
			expect(allSteers[1].message).toBe("another steer for A");
		});
	});

	describe("steer() method respects per-session state", () => {
		it("steer() only works when the current session is running", () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter, sent } = setupWithSession(sessionB);

			// Session A is running, session B is idle
			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			adapter.steer({ role: "user", content: "should not steer", timestamp: Date.now() });

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);
			expect(adapter.steeringQueue).toHaveLength(0);
		});

		it("steer() works when the current session IS running", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent } = setupWithSession(sessionPath);

			(adapter as any)._globalSessionStatus.set(sessionPath, "running");

			adapter.steer({ role: "user", content: "steer this", timestamp: Date.now() });

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(1);
			expect(steerMsgs[0].message).toBe("steer this");
			expect(adapter.steeringQueue).toHaveLength(1);
		});
	});

	describe("virtual session startup routing", () => {
		it("sends prompt with __new__ for virtual sessions even when other sessions are running", async () => {
			const { adapter, sent } = createTestAdapter();

			// Set up as virtual session
			(adapter as any)._sessionStatus = "virtual";
			(adapter as any)._sessionPath = undefined;
			(adapter as any)._state.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

			// Some other session is running
			(adapter as any)._globalSessionStatus.set("/tmp/sessions/other.jsonl", "running");
			// Session A is still running on the server (adapter tracks this globally)

			await adapter.prompt("new conversation");

			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].sessionPath).toBe("__new__");
			expect(promptMsgs[0].message).toBe("new conversation");

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);
		});

		it("routes a rapid second send into the first newly attached session", async () => {
			const { adapter, sent } = createTestAdapter();
			(adapter as any)._sessionStatus = "virtual";
			(adapter as any)._sessionPath = undefined;
			(adapter as any)._state.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

			await Promise.all([
				adapter.prompt("first"),
				adapter.prompt("second"),
			]);

			expect(sent.filter((message) => message.type === "prompt")).toHaveLength(1);
			expect(sent.filter((message) => message.type === "prompt")[0]).toMatchObject({
				sessionPath: "__new__",
				message: "first",
			});
			expect(sent.filter((message) => message.type === "steer")).toHaveLength(1);
			expect(sent.filter((message) => message.type === "steer")[0]).toMatchObject({
				sessionPath: "/tmp/sessions/new-session.jsonl",
				message: "second",
			});
		});
	});

	describe("steering queue is per-session", () => {
		it("shows steering queue only for the current session", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			// Mark session A as running and queue steers
			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			await adapter.prompt("steer 1");
			await adapter.prompt("steer 2");

			// Should see 2 items in the queue for session A
			expect(adapter.steeringQueue).toHaveLength(2);
			expect(adapter.steeringQueue[0]).toBe("steer 1");
			expect(adapter.steeringQueue[1]).toBe("steer 2");

			// Switch to session B
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";

			// Steering queue for session B should be empty
			expect(adapter.steeringQueue).toHaveLength(0);

			// Switch back to session A — queue should still be there
			(adapter as any)._sessionPath = sessionA;
			(adapter as any)._sessionId = "session-a";
			expect(adapter.steeringQueue).toHaveLength(2);
		});

		it("does not leak steering queue items across sessions", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			// Both sessions running
			(adapter as any)._globalSessionStatus.set(sessionA, "running");
			(adapter as any)._globalSessionStatus.set(sessionB, "running");

			// Queue steer for session A
			await adapter.prompt("steer for A");
			expect(adapter.steeringQueue).toHaveLength(1);

			// Switch to B and queue steer for B
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";
			await adapter.prompt("steer for B");
			expect(adapter.steeringQueue).toHaveLength(1);
			expect(adapter.steeringQueue[0]).toBe("steer for B");

			// Switch back to A — should only see A's queue
			(adapter as any)._sessionPath = sessionA;
			(adapter as any)._sessionId = "session-a";
			expect(adapter.steeringQueue).toHaveLength(1);
			expect(adapter.steeringQueue[0]).toBe("steer for A");
		});

		it("clearSteeringQueue only clears the current session", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			// Both sessions running
			(adapter as any)._globalSessionStatus.set(sessionA, "running");
			(adapter as any)._globalSessionStatus.set(sessionB, "running");

			// Queue steers for A
			await adapter.prompt("steer A");

			// Switch to B and queue steers
			(adapter as any)._sessionPath = sessionB;
			await adapter.prompt("steer B");

			// Clear B's queue via internal API (clearSteeringQueue was removed)
			(adapter as any)._steeringQueues.delete(sessionB);
			expect(adapter.steeringQueue).toHaveLength(0);

			// A's queue should still be intact
			(adapter as any)._sessionPath = sessionA;
			expect(adapter.steeringQueue).toHaveLength(1);
			expect(adapter.steeringQueue[0]).toBe("steer A");
		});

		it("steeringQueue reflects only current session", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			await adapter.prompt("steer");
			expect(adapter.steeringQueue.length > 0).toBe(true);

			// Switch to B — no queued messages there
			(adapter as any)._sessionPath = sessionB;
			expect(adapter.steeringQueue.length > 0).toBe(false);

			// Back to A
			(adapter as any)._sessionPath = sessionA;
			expect(adapter.steeringQueue.length > 0).toBe(true);
		});

		it("steering queue returns empty for virtual session (no path)", () => {
			const { adapter } = createTestAdapter();
			(adapter as any)._sessionPath = undefined;
			(adapter as any)._sessionStatus = "virtual";

			expect(adapter.steeringQueue).toHaveLength(0);
		});
	});

	describe("UI consumer must re-read steeringQueue on session switch", () => {
		it("consumer that snapshots steeringQueue on change AND session switch sees correct values", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			// Simulate what main.ts does: keep a local snapshot variable
			// updated via onSteeringQueueChange AND onSessionChange
			let snapshot: readonly string[] = adapter.steeringQueue;

			adapter.onSteeringQueueChange(() => {
				snapshot = adapter.steeringQueue;
			});
			// This is the critical part: on session change, re-read the queue
			adapter.onSessionChange(() => {
				snapshot = adapter.steeringQueue;
			});

			// Mark A as running, queue a steer
			(adapter as any)._globalSessionStatus.set(sessionA, "running");
			await adapter.prompt("steer for A");

			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]).toBe("steer for A");

			// Switch to session B (idle) — this calls emitSessionChange
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";
			(adapter as any)._sessionStatus = "detached";
			// Trigger the session change event (like switchSession does)
			(adapter as any).emitSessionChange();

			// The snapshot should now be empty (session B has no queued steers)
			expect(snapshot).toHaveLength(0);
		});

		it("consumer that only listens to onSteeringQueueChange sees STALE data after switch", async () => {
			// This test documents the bug pattern: if main.ts only updated
			// the snapshot in onSteeringQueueChange (not onSessionChange),
			// switching sessions would leave a stale queue visible.
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			// Simulate the BUGGY consumer: only update on queue change, NOT session change
			let buggySnapshot: readonly string[] = adapter.steeringQueue;
			adapter.onSteeringQueueChange(() => {
				buggySnapshot = adapter.steeringQueue;
			});

			// Mark A as running, queue a steer
			(adapter as any)._globalSessionStatus.set(sessionA, "running");
			await adapter.prompt("steer for A");

			expect(buggySnapshot).toHaveLength(1);

			// Switch to session B — no emitSteeringQueueChange is fired,
			// so the buggy consumer never re-reads. The snapshot is stale.
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";
			(adapter as any)._sessionStatus = "detached";
			(adapter as any).emitSessionChange();

			// The buggy snapshot still shows session A's queue!
			// (This is the bug that main.ts had before the fix)
			expect(buggySnapshot).toHaveLength(1);
			expect(buggySnapshot[0]).toBe("steer for A");

			// But the adapter itself reports correctly per-session:
			expect(adapter.steeringQueue).toHaveLength(0);
		});
	});

	describe("server-pushed session_messages replaces state", () => {
		it("session_messages push replaces messages completely", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession(sessionPath);

			// Start with some messages
			(adapter as any)._state.messages = [
				{ role: "user", content: "old message", timestamp: 999 },
			];

			// Server pushes new message state
			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [
					{ role: "user", content: "hello", timestamp: 1000 },
					{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1001 },
				],
			});

			expect(adapter.state.messages).toHaveLength(2);
			expect(adapter.state.messages[0].role).toBe("user");
			expect(adapter.state.messages[1].role).toBe("assistant");
		});

		it("message_end is no longer processed by updateState (state comes from session_sync)", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter } = setupWithSession(sessionPath);

			(adapter as any)._state.messages = [
				{ role: "user", content: "test", timestamp: 999 },
			];

			// updateState no longer handles message_end — state comes from session_sync
			(adapter as any).updateState({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "new_tool_456", name: "bash", input: { command: "ls" } }],
					timestamp: 2000,
				},
			});

			// Message NOT appended — updateState only handles agent_start/end/turn_end
			expect(adapter.state.messages).toHaveLength(1);
		});

		it("turn_end does NOT append tool results (they arrive via message_end)", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter } = setupWithSession(sessionPath);

			(adapter as any)._state.messages = [
				{ role: "user", content: "test", timestamp: 999 },
			];

			(adapter as any).updateState({
				type: "turn_end",
				message: { role: "assistant", content: [], timestamp: 1000 },
				toolResults: [
					{ role: "tool", tool_use_id: "tool_1", content: [{ type: "text", text: "output" }], timestamp: 1001 },
				],
			});

			// turn_end should NOT add tool results — only message_end does
			expect(adapter.state.messages).toHaveLength(1);
		});

		it("sets sessionStatus to attached when switching to a running session", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter } = setupWithSession(sessionPath);

			(adapter as any)._globalSessionStatus.set(sessionPath, "running");

			await adapter.switchSession(sessionPath);

			expect(adapter.sessionStatus).toBe("attached");
		});
	});

	describe("stop button visibility (isStreaming) for running sessions", () => {
		it("sets isStreaming=true when switching to a session that is running", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			// Session A starts streaming
			(adapter as any).updateState({ type: "agent_start" });
			expect(adapter.state.isStreaming).toBe(true);

			// Switch to idle session B — isStreaming should be false
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";
			(adapter as any)._sessionStatus = "detached";
			(adapter as any)._state.isStreaming = false;
			(adapter as any)._state.streamMessage = null;
			(adapter as any)._state.pendingToolCalls = new Set();

			expect(adapter.state.isStreaming).toBe(false);

			// Now switch back to session A, which is still running on the server
			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			// Simulate switchSession behavior (clear state then check running status)
			await adapter.switchSession(sessionA);

			// BUG: isStreaming should be true because session A is running,
			// but switchSession always sets it to false
			expect(adapter.state.isStreaming).toBe(true);
		});

		it("keeps isStreaming=false when switching to a session that is not running", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			// Session A is running
			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			// Session B is idle (not in the map or "done")
			(adapter as any)._globalSessionStatus.set(sessionB, "done");

			await adapter.switchSession(sessionB);

			expect(adapter.state.isStreaming).toBe(false);
		});

		it("sets isStreaming=true when session_attached arrives for current session", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession(sessionPath);

			expect(adapter.state.isStreaming).toBe(false);

			// Server notifies that our session is now attached (running)
			simulateServerMessage({ type: "session_attached", sessionPath });

			// isStreaming should be true so the stop button shows
			expect(adapter.state.isStreaming).toBe(true);
		});

		it("emits statusChange when isStreaming changes on switchSession", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const { adapter } = setupWithSession(sessionA);

			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			let statusChanges = 0;
			adapter.onStatusChange(() => { statusChanges++; });

			await adapter.switchSession(sessionA);

			// Should have emitted at least one status change
			expect(statusChanges).toBeGreaterThan(0);
			expect(adapter.state.isStreaming).toBe(true);
		});
	});

	describe("local model/thinking updates notify UI", () => {
		it("emits content change when setModel is called", () => {
			const { adapter } = setupWithSession("/tmp/sessions/session-a.jsonl");
			let changes = 0;
			adapter.onContentChange(() => { changes++; });

			adapter.setModel({ provider: "openai", id: "gpt-5", reasoning: true } as any);

			expect((adapter as any)._state.model).toEqual({ provider: "openai", id: "gpt-5", reasoning: true });
			expect(changes).toBe(1);
		});

		it("clamps thinking level to off when selecting a non-reasoning model", () => {
			const { adapter } = setupWithSession("/tmp/sessions/session-a.jsonl");
			(adapter as any)._state.model = { provider: "openai", id: "gpt-5", reasoning: true };
			adapter.setThinkingLevel("high");

			adapter.setModel({ provider: "openai", id: "gpt-4o-mini", reasoning: false } as any);

			expect(adapter.state.thinkingLevel).toBe("off");
		});

		it("preserves a supported thinking level across reasoning model changes", () => {
			const { adapter } = setupWithSession("/tmp/sessions/session-a.jsonl");
			(adapter as any)._state.model = { provider: "anthropic", id: "claude-old", reasoning: true };
			(adapter as any)._state.thinkingLevel = "high";

			adapter.setModel({ provider: "openai", id: "gpt-5", reasoning: true } as any);

			expect(adapter.state.thinkingLevel).toBe("high");
		});

		it("preserves thinking for inferred openai-codex reasoning models", () => {
			const { adapter } = setupWithSession("/tmp/sessions/session-a.jsonl");
			(adapter as any)._state.thinkingLevel = "high";

			adapter.setModel({ provider: "openai-codex", id: "gpt-5.3-codex" } as any);

			expect(adapter.state.thinkingLevel).toBe("high");
		});

		it("previews pi's upward clamp for model capability holes", () => {
			const { adapter } = setupWithSession("/tmp/sessions/session-a.jsonl");
			(adapter as any)._state.thinkingLevel = "medium";

			adapter.setModel({
				provider: "deepseek",
				id: "deepseek-v4",
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: "max" },
			} as any);

			expect(adapter.state.thinkingLevel).toBe("high");
		});

		it("rolls a failed sent control revision back to the last authoritative state", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession(sessionPath);
			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [],
				model: { provider: "anthropic", modelId: "claude-authoritative" },
				thinkingLevel: "high",
			});
			adapter.setModel({ provider: "openai", id: "gpt-5", reasoning: true } as any);
			const revision = (adapter as any)._pendingControl.revision;
			(adapter as any).markControlSent(revision);

			(adapter as any).rollbackSentControl(revision);

			expect(adapter.state.model).toMatchObject({ provider: "anthropic", id: "claude-authoritative" });
			expect(adapter.state.thinkingLevel).toBe("high");
			expect((adapter as any)._pendingControl).toBeUndefined();
		});

		it("supports max and emits content change when setThinkingLevel is called", () => {
			const { adapter } = setupWithSession("/tmp/sessions/session-a.jsonl");
			(adapter as any)._state.model = {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			};
			let changes = 0;
			adapter.onContentChange(() => { changes++; });

			adapter.setThinkingLevel("max");

			expect(adapter.state.thinkingLevel).toBe("max");
			expect(changes).toBe(1);
		});
	});

	describe("model persistence across session messages", () => {
		it("does not overwrite a locally selected model when server pushes session_messages", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession(sessionPath);

			const localModel = { provider: "openai", id: "gpt-5" };
			adapter.setModel(localModel as any);

			// A local revision is pending, so an older snapshot must not overwrite it.
			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [],
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
				thinkingLevel: "off",
			});

			// Local selection preserved
			expect(adapter.state.model).toEqual(localModel);
		});

		it("restores persisted model when switching sessions via session_messages", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession(sessionPath);

			(adapter as any)._state.model = { provider: "openai", id: "gpt-5" };

			// Pre-populate available models cache
			(adapter as any)._availableModels = [
				{ provider: "anthropic", id: "claude-sonnet-4-20250514" },
			];

			await adapter.switchSession(sessionPath);

			// Server pushes session_messages (this is what subscribe_session triggers)
			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [],
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
				thinkingLevel: "high",
			});

			expect(adapter.state.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-20250514" });
			expect(adapter.state.thinkingLevel).toBe("high");

			// A subsequent local selection remains optimistic until acknowledged.
			adapter.setModel({ provider: "openai", id: "gpt-5" } as any);
			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [],
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
				thinkingLevel: "off",
			});
			expect(adapter.state.model).toEqual({ provider: "openai", id: "gpt-5" });
		});

		it("restores a compact model ref without a catalog instead of retaining another session's model", async () => {
			const sessionPath = "/tmp/sessions/session-b.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession("/tmp/sessions/session-a.jsonl");
			(adapter as any)._state.model = { provider: "openai", id: "wrong-model" };

			await adapter.switchSession(sessionPath);
			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [],
				model: { provider: "anthropic", modelId: "claude-session-model" },
				thinkingLevel: "high",
			});

			expect(adapter.state.model).toMatchObject({
				provider: "anthropic",
				id: "claude-session-model",
			});
			expect(adapter.state.thinkingLevel).toBe("high");
		});

		it("applies a matching effective control acknowledgement and waits for its snapshot", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession(sessionPath);
			(adapter as any)._state.model = { provider: "deepseek", id: "deepseek-v4", reasoning: true };
			adapter.setThinkingLevel("medium");
			const revision = (adapter as any)._pendingControl.revision;

			// Older queued session state cannot erase the local choice.
			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [],
				model: { provider: "deepseek", modelId: "deepseek-v4" },
				thinkingLevel: "off",
			});
			expect(adapter.state.thinkingLevel).toBe("medium");

			// Pi clamps medium to high and acknowledges that effective value.
			simulateServerMessage({
				type: "control_state",
				sessionPath,
				controlRevision: revision,
				model: { provider: "deepseek", id: "deepseek-v4", reasoning: true },
				thinkingLevel: "high",
			});
			expect(adapter.state.thinkingLevel).toBe("high");
			expect((adapter as any)._pendingControl.phase).toBe("acknowledged");

			simulateServerMessage({
				type: "session_messages",
				sessionPath,
				messages: [],
				model: { provider: "deepseek", modelId: "deepseek-v4" },
				thinkingLevel: "high",
			});
			expect((adapter as any)._pendingControl).toBeUndefined();
		});

		it("ignores an older acknowledgement after a newer local edit", () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, simulateServerMessage } = setupWithSession(sessionPath);
			(adapter as any)._state.model = {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				reasoning: true,
				thinkingLevelMap: { max: "max" },
			};
			adapter.setThinkingLevel("high");
			const oldRevision = (adapter as any)._pendingControl.revision;
			adapter.setThinkingLevel("max");

			simulateServerMessage({
				type: "control_state",
				sessionPath,
				controlRevision: oldRevision,
				model: { provider: "openai-codex", id: "gpt-5.6-sol" },
				thinkingLevel: "high",
			});

			expect(adapter.state.thinkingLevel).toBe("max");
			expect((adapter as any)._pendingControl.revision).toBeGreaterThan(oldRevision);
		});
	});

	describe("session_sync ordering", () => {
		it("keeps deltas after a pending full sync", () => {
			const { adapter } = createTestAdapter();
			const a = adapter as any;

			a.enqueueSessionSync({ type: "session_sync", op: "full", data: "{}", hash: "h1" });
			a.enqueueSessionSync({ type: "session_sync", op: "delta", patches: [], baseHash: "h1", hash: "h2" });

			expect(a._pendingSessionSyncs.map((op: any) => op.op)).toEqual(["full", "delta"]);
			expect(a._pendingSessionSyncs.map((op: any) => op.hash)).toEqual(["h1", "h2"]);
		});

		it("keeps hash-dependent deltas in order", () => {
			const { adapter } = createTestAdapter();
			const a = adapter as any;

			a.enqueueSessionSync({ type: "session_sync", op: "delta", patches: [{ offset: 0, deleteCount: 0, insert: "a" }], baseHash: "h0", hash: "h1" });
			a.enqueueSessionSync({ type: "session_sync", op: "delta", patches: [{ offset: 0, deleteCount: 0, insert: "b" }], baseHash: "h1", hash: "h2" });

			expect(a._pendingSessionSyncs.map((op: any) => op.hash)).toEqual(["h1", "h2"]);
		});

		it("lets a newer full snapshot supersede queued history", () => {
			const { adapter } = createTestAdapter();
			const a = adapter as any;

			a.enqueueSessionSync({ type: "session_sync", op: "delta", patches: [], baseHash: "h0", hash: "h1" });
			a.enqueueSessionSync({ type: "session_sync", op: "full", data: "{\"new\":true}", hash: "h2" });

			expect(a._pendingSessionSyncs).toHaveLength(1);
			expect(a._pendingSessionSyncs[0]).toMatchObject({ op: "full", hash: "h2" });
		});

		it("applies a full snapshot and all dependent deltas in order with one render", async () => {
			const { adapter } = createTestAdapter();
			const a = adapter as any;
			const contentChange = vi.fn();
			adapter.onContentChange(contentChange);
			const sessionPath = "/tmp/ordered.jsonl";
			a._sessionPath = sessionPath;
			a._sessionNonce = 4;
			const makeState = (text: string) => JSON.stringify({
				messages: [{ role: "user", content: text }],
				isStreaming: false,
				pendingToolCalls: [],
				model: { provider: "openai", modelId: "gpt-5" },
				thinkingLevel: "high",
				steeringQueue: [],
			});
			const states = [makeState("one"), makeState("two"), makeState("three")];
			const hashes = await Promise.all(states.map(computeHash));
			const scope = { __sessionPath: sessionPath, __sessionNonce: 4 };

			a.enqueueSessionSync({ ...scope, op: "full", data: states[0], hash: hashes[0] });
			a.enqueueSessionSync({ ...scope, op: "delta", patches: computePatches(states[0], states[1]), baseHash: hashes[0], hash: hashes[1] });
			a.enqueueSessionSync({ ...scope, op: "delta", patches: computePatches(states[1], states[2]), baseHash: hashes[1], hash: hashes[2] });
			await a.flushSessionSyncQueue();

			expect(a._syncJson).toBe(states[2]);
			expect(a._syncHash).toBe(hashes[2]);
			expect(adapter.state.messages[0]).toMatchObject({ content: "three" });
			expect(contentChange).toHaveBeenCalledTimes(1);
		});

		it("leaves updates received during hashing for the next animation frame", async () => {
			const { adapter } = createTestAdapter();
			const a = adapter as any;
			const sessionPath = "/tmp/progressive.jsonl";
			a._sessionPath = sessionPath;
			a._sessionNonce = 5;
			const first = JSON.stringify({ messages: [{ role: "user", content: "first" }] });
			const second = JSON.stringify({ messages: [{ role: "user", content: "second" }] });
			const firstHash = await computeHash(first);
			const secondHash = await computeHash(second);
			const scope = { __sessionPath: sessionPath, __sessionNonce: 5 };
			const nextFrame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);

			a._pendingSessionSyncs = [{ ...scope, op: "full", data: first, hash: firstHash }];
			const flushing = a.flushSessionSyncQueue();
			a._pendingSessionSyncs.push({
				...scope,
				op: "delta",
				patches: computePatches(first, second),
				baseHash: firstHash,
				hash: secondHash,
			});
			await flushing;

			expect(a._syncJson).toBe(first);
			expect(a._pendingSessionSyncs).toHaveLength(1);
			expect(nextFrame).toHaveBeenCalledTimes(1);
			nextFrame.mockRestore();
		});

		it("cannot commit an async sync after the active session changes", async () => {
			const { adapter } = createTestAdapter();
			const a = adapter as any;
			const sessionA = "/tmp/a.jsonl";
			const stateA = JSON.stringify({ messages: [{ role: "user", content: "A" }] });
			const hashA = await computeHash(stateA);
			a._sessionPath = sessionA;
			a._sessionNonce = 10;
			a._state.messages = [{ role: "user", content: "B" }];

			const applying = a.applySessionSync({
				op: "full",
				data: stateA,
				hash: hashA,
				__sessionPath: sessionA,
				__sessionNonce: 10,
			});
			a._sessionPath = "/tmp/b.jsonl";
			a._sessionNonce = 11;
			a._syncJson = "";
			a._syncHash = "";
			await applying;

			expect(adapter.state.messages[0]).toMatchObject({ content: "B" });
			expect(a._syncJson).toBe("");
		});
	});

	describe("error visibility", () => {
		it("stores response errors in state.error", () => {
			const { adapter } = createTestAdapter();
			const reject = vi.fn();
			const resolve = vi.fn();
			(adapter as any).pendingRequests.set("req_x", { resolve, reject });

			(adapter as any).handleMessage(JSON.stringify({
				type: "response",
				id: "req_x",
				success: false,
				error: "Upstream provider is unavailable",
			}));

			expect(adapter.state.error).toBe("Upstream provider is unavailable");
			expect(reject).toHaveBeenCalledTimes(1);
		});

		it("reportError appends a visible assistant message", () => {
			const { adapter } = createTestAdapter();
			adapter.reportError(new Error("Rate limit reached"), "Prompt failed");

			const last = adapter.state.messages.at(-1) as any;
			expect(adapter.state.error).toBe("Rate limit reached");
			expect(last?.role).toBe("assistant");
			expect(last?.content?.[0]?.text || "").toContain("Prompt failed: Rate limit reached");
		});
	});

	describe("slash commands", () => {
		it("/reload sends reload_processes, does not send a prompt, and adds a confirmation message", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent } = setupWithSession(sessionPath);

			await adapter.prompt("/reload");

			const reloadMsgs = sent.filter((m) => m.type === "reload_processes");
			expect(reloadMsgs).toHaveLength(1);
			expect(sent.filter((m) => m.type === "prompt")).toHaveLength(0);

			const last = adapter.state.messages.at(-1) as any;
			expect(last?.content?.[0]?.text || "").toContain("Reload requested");
		});

		it("/help output includes /reload", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter } = setupWithSession(sessionPath);

			await adapter.prompt("/help");
			const last = adapter.state.messages.at(-1) as any;
			const text = last?.content?.[0]?.text || "";
			expect(text).toContain("`/reload`");
		});
	});
});

describe("WsAgentAdapter extension statuses", () => {
	it("replaces complete snapshots and notifies dedicated listeners", () => {
		const sessionPath = "/tmp/sessions/session-a.jsonl";
		const { adapter, simulateServerMessage } = setupWithSession(sessionPath);
		const statusListener = vi.fn();
		const agentListener = vi.fn();
		adapter.onExtensionStatusChange(statusListener);
		adapter.subscribe(agentListener);

		simulateServerMessage({
			type: "extension_status",
			sessionPath,
			statuses: { usage: "codex 25% 5h", other: "ready" },
		});
		expect(Object.fromEntries(adapter.extensionStatuses)).toEqual({
			usage: "codex 25% 5h",
			other: "ready",
		});

		simulateServerMessage({
			type: "extension_status",
			sessionPath,
			statuses: { usage: "codex 26% 5h" },
		});
		expect(Object.fromEntries(adapter.extensionStatuses)).toEqual({ usage: "codex 26% 5h" });
		expect(statusListener).toHaveBeenCalledTimes(2);
		expect(agentListener).not.toHaveBeenCalled();
	});

	it("ignores another session and clears immediately when switching", async () => {
		const sessionPath = "/tmp/sessions/session-a.jsonl";
		const { adapter, simulateServerMessage } = setupWithSession(sessionPath);
		simulateServerMessage({
			type: "extension_status",
			sessionPath,
			statuses: { usage: "claude 10% 5h" },
		});
		simulateServerMessage({
			type: "extension_status",
			sessionPath: "/tmp/sessions/other.jsonl",
			statuses: { usage: "wrong session" },
		});
		expect(adapter.extensionStatuses.get("usage")).toBe("claude 10% 5h");

		const switching = adapter.switchSession("/tmp/sessions/session-b.jsonl");
		expect(adapter.extensionStatuses.size).toBe(0);
		await switching;
	});

	it("keeps provider usage visible in empty and virtual conversations", async () => {
		const sessionPath = "/tmp/sessions/empty-session.jsonl";
		const { adapter, simulateServerMessage } = setupWithSession(sessionPath);
		simulateServerMessage({
			type: "provider_usage",
			statuses: {
				anthropic: "claude 18% 5h 42% 7d",
				codex: "codex 25% 5h 60% wk",
			},
		});
		// An empty per-session snapshot must not erase the account-wide value.
		simulateServerMessage({
			type: "extension_status",
			sessionPath,
			statuses: {},
		});
		expect(adapter.extensionStatuses.get("provider-usage"))
			.toBe("claude 18% 5h 42% 7d");

		await adapter.newSession("/tmp");
		expect(adapter.extensionStatuses.get("provider-usage"))
			.toBe("claude 18% 5h 42% 7d");

		(adapter as any)._state.model = { provider: "openai-codex", id: "gpt-5.6-sol" };
		expect(adapter.extensionStatuses.get("provider-usage"))
			.toBe("codex 25% 5h 60% wk");
	});

	it("restores provider usage from the initial server snapshot", () => {
		const { adapter, simulateServerMessage } = createTestAdapter();
		(adapter as any)._state.model = { provider: "anthropic", id: "claude-sonnet" };
		const listener = vi.fn();
		adapter.onExtensionStatusChange(listener);

		simulateServerMessage({
			type: "init",
			sessionStatuses: {},
			steeringQueues: {},
			providerUsageStatuses: { anthropic: "claude 9% 5h" },
		});

		expect(adapter.extensionStatuses.get("provider-usage")).toBe("claude 9% 5h");
		expect(listener).toHaveBeenCalledOnce();
	});

	it("clears session statuses for a virtual session but retains the last snapshot on detach", async () => {
		const sessionPath = "/tmp/sessions/session-a.jsonl";
		const { adapter, simulateServerMessage } = setupWithSession(sessionPath);
		simulateServerMessage({
			type: "extension_status",
			sessionPath,
			statuses: { usage: "codex 25% 5h" },
		});
		simulateServerMessage({ type: "session_detached", sessionPath });
		expect(adapter.extensionStatuses.get("usage")).toBe("codex 25% 5h");

		await adapter.newSession("/tmp");
		expect(adapter.extensionStatuses.size).toBe(0);
	});
});

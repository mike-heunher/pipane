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
import { WsAgentAdapter } from "./ws-agent-adapter.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create an adapter with a mocked WebSocket. Returns the adapter and a
 * spy that captures all messages sent over the WS.
 */
function createTestAdapter() {
	const adapter = new WsAgentAdapter();
	const sent: any[] = [];
	let messageHandler: ((ev: { data: string }) => void) | null = null;

	// Mock WebSocket
	const mockWs = {
		readyState: 1, // WebSocket.OPEN
		send: vi.fn((data: string) => {
			const parsed = JSON.parse(data);
			sent.push(parsed);

			// Auto-respond to requests so promises resolve
			if (parsed.id) {
				// Simulate server response
				setTimeout(() => {
					if (messageHandler) {
						if (parsed.type === "prompt" && parsed.sessionPath === "__new__") {
							// For new session: respond to prompt, then send session_attached, then response
							messageHandler({ data: JSON.stringify({ type: "session_attached", sessionPath: "/tmp/sessions/new-session.jsonl", cwd: "/tmp" }) });
							messageHandler({ data: JSON.stringify({ type: "response", id: parsed.id, success: true, data: {} }) });
						} else {
							messageHandler({ data: JSON.stringify({ type: "response", id: parsed.id, success: true, data: {} }) });
						}
					}
				}, 0);
			}
		}),
		close: vi.fn(),
		onopen: null as any,
		onerror: null as any,
		onclose: null as any,
		onmessage: null as any,
	};

	// Patch the adapter's ws field directly
	(adapter as any).ws = mockWs;

	// Capture the message handler
	Object.defineProperty(mockWs, 'onmessage', {
		set(fn) { messageHandler = fn; },
		get() { return messageHandler; },
	});

	// Wire up the adapter's handleMessage
	messageHandler = (ev: { data: string }) => {
		(adapter as any).handleMessage(ev.data);
	};

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

describe("WsAgentAdapter prompt routing", () => {
	describe("prompt to idle session sends 'prompt' command", () => {
		it("sends a prompt command when session is not running", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent } = setupWithSession(sessionPath);

			// Session is not in globalSessionStatus → idle
			await adapter.prompt("hello world");

			// Wait for async
			await new Promise((r) => setTimeout(r, 50));

			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].sessionPath).toBe(sessionPath);
			expect(promptMsgs[0].message).toBe("hello world");

			// No steer messages
			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);
		});

		it("sends a prompt command when session status is 'done'", async () => {
			const sessionPath = "/tmp/sessions/session-a.jsonl";
			const { adapter, sent, simulateServerMessage } = setupWithSession(sessionPath);

			// Mark session as "done" (previously ran, now finished)
			(adapter as any)._globalSessionStatus.set(sessionPath, "done");

			await adapter.prompt("hello again");
			await new Promise((r) => setTimeout(r, 50));

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
			await new Promise((r) => setTimeout(r, 50));

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
			await new Promise((r) => setTimeout(r, 50));

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
			await new Promise((r) => setTimeout(r, 50));

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

		it("does NOT steer when _isReallyStreaming is true but current session is not running", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter, sent } = setupWithSession(sessionB);

			// Simulate the old bug scenario:
			// _isReallyStreaming is true (leftover from session A)
			// but session B is not running
			(adapter as any)._isReallyStreaming = true;
			(adapter as any)._globalSessionStatus.set(sessionA, "running");
			// Session B is idle (not in the map)

			await adapter.prompt("this should be a prompt not steer");
			await new Promise((r) => setTimeout(r, 50));

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
			await new Promise((r) => setTimeout(r, 50));

			expect(sent.filter((m) => m.type === "steer")).toHaveLength(1);
			expect(sent.filter((m) => m.type === "steer")[0].sessionPath).toBe(sessionA);

			// Now switch to session B (idle)
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";

			// Send prompt to B (should be a prompt, not steer)
			await adapter.prompt("prompt for B");
			await new Promise((r) => setTimeout(r, 50));

			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].sessionPath).toBe(sessionB);

			// Switch back to session A (still running)
			(adapter as any)._sessionPath = sessionA;
			(adapter as any)._sessionId = "session-a";

			// Send another steer to A
			await adapter.prompt("another steer for A");
			await new Promise((r) => setTimeout(r, 50));

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

	describe("virtual sessions are never steered", () => {
		it("sends prompt with __new__ for virtual sessions even when other sessions are running", async () => {
			const { adapter, sent } = createTestAdapter();

			// Set up as virtual session
			(adapter as any)._sessionStatus = "virtual";
			(adapter as any)._sessionPath = undefined;
			(adapter as any)._state.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

			// Some other session is running
			(adapter as any)._globalSessionStatus.set("/tmp/sessions/other.jsonl", "running");
			(adapter as any)._isReallyStreaming = true; // leftover from old session

			await adapter.prompt("new conversation");
			await new Promise((r) => setTimeout(r, 50));

			const promptMsgs = sent.filter((m) => m.type === "prompt");
			expect(promptMsgs).toHaveLength(1);
			expect(promptMsgs[0].sessionPath).toBe("__new__");
			expect(promptMsgs[0].message).toBe("new conversation");

			const steerMsgs = sent.filter((m) => m.type === "steer");
			expect(steerMsgs).toHaveLength(0);
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
			await new Promise((r) => setTimeout(r, 50));

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
			await new Promise((r) => setTimeout(r, 50));
			expect(adapter.steeringQueue).toHaveLength(1);

			// Switch to B and queue steer for B
			(adapter as any)._sessionPath = sessionB;
			(adapter as any)._sessionId = "session-b";
			await adapter.prompt("steer for B");
			await new Promise((r) => setTimeout(r, 50));
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
			await new Promise((r) => setTimeout(r, 50));

			// Switch to B and queue steers
			(adapter as any)._sessionPath = sessionB;
			await adapter.prompt("steer B");
			await new Promise((r) => setTimeout(r, 50));

			// Clear B's queue
			adapter.clearSteeringQueue();
			expect(adapter.steeringQueue).toHaveLength(0);

			// A's queue should still be intact
			(adapter as any)._sessionPath = sessionA;
			expect(adapter.steeringQueue).toHaveLength(1);
			expect(adapter.steeringQueue[0]).toBe("steer A");
		});

		it("hasQueuedMessages reflects only current session", async () => {
			const sessionA = "/tmp/sessions/session-a.jsonl";
			const sessionB = "/tmp/sessions/session-b.jsonl";
			const { adapter } = setupWithSession(sessionA);

			(adapter as any)._globalSessionStatus.set(sessionA, "running");

			await adapter.prompt("steer");
			await new Promise((r) => setTimeout(r, 50));
			expect(adapter.hasQueuedMessages()).toBe(true);

			// Switch to B — no queued messages there
			(adapter as any)._sessionPath = sessionB;
			expect(adapter.hasQueuedMessages()).toBe(false);

			// Back to A
			(adapter as any)._sessionPath = sessionA;
			expect(adapter.hasQueuedMessages()).toBe(true);
		});

		it("steering queue returns empty for virtual session (no path)", () => {
			const { adapter } = createTestAdapter();
			(adapter as any)._sessionPath = undefined;
			(adapter as any)._sessionStatus = "virtual";

			expect(adapter.steeringQueue).toHaveLength(0);
			expect(adapter.hasQueuedMessages()).toBe(false);
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
			await new Promise((r) => setTimeout(r, 50));

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
			await new Promise((r) => setTimeout(r, 50));

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
});

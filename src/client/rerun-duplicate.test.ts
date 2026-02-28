/**
 * E2E-style reproduction test for the "rerun renders twice" bug.
 *
 * Simulates the exact sequence of events that happens when:
 * 1. A session has a completed (aborted) run
 * 2. User clicks "rerun" (sends the same prompt again)
 * 3. The agent streams a new turn with a tool call
 *
 * Checks that the tool-call assistant message does NOT appear twice
 * in state.messages at any point during the flow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsAgentAdapter } from "./ws-agent-adapter.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestAdapter() {
	const adapter = new WsAgentAdapter();
	const sent: any[] = [];
	let messageHandler: ((ev: { data: string }) => void) | null = null;

	const mockWs = {
		readyState: 1, // WebSocket.OPEN
		send: vi.fn((data: string) => {
			const parsed = JSON.parse(data);
			sent.push(parsed);

			// Auto-respond to requests so promises resolve
			if (parsed.id) {
				setTimeout(() => {
					if (messageHandler) {
						messageHandler({
							data: JSON.stringify({
								type: "response",
								id: parsed.id,
								success: true,
								data: {},
							}),
						});
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

	(adapter as any).ws = mockWs;

	Object.defineProperty(mockWs, "onmessage", {
		set(fn) {
			messageHandler = fn;
		},
		get() {
			return messageHandler;
		},
	});

	messageHandler = (ev: { data: string }) => {
		(adapter as any).handleMessage(ev.data);
	};

	const simulateServerMessage = (msg: any) => {
		messageHandler?.({ data: JSON.stringify(msg) });
	};

	return { adapter, sent, mockWs, simulateServerMessage };
}

function countAssistantMessages(adapter: WsAgentAdapter): number {
	return adapter.state.messages.filter((m: any) => m.role === "assistant").length;
}

function countToolUseMessages(adapter: WsAgentAdapter, toolName: string): number {
	return adapter.state.messages.filter((m: any) => {
		if (m.role !== "assistant") return false;
		if (!Array.isArray(m.content)) return false;
		return m.content.some(
			(c: any) => c.type === "tool_use" && c.name === toolName,
		);
	}).length;
}

/** Build a typical assistant message with a bash tool call */
function makeAssistantWithBash(toolCallId: string, command: string, opts?: { usage?: any; timestamp?: number }) {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "I'll run the command." },
			{
				type: "tool_use",
				id: toolCallId,
				name: "Bash",
				input: { command },
				arguments: { command },
			},
		],
		usage: opts?.usage ?? { inputTokens: 3700, outputTokens: 72, totalCost: 0.0203 },
		timestamp: opts?.timestamp ?? Date.now(),
		stopReason: "tool_use",
	};
}

function makeToolResult(toolCallId: string, output: string, opts?: { timestamp?: number }) {
	return {
		role: "tool",
		tool_use_id: toolCallId,
		content: [{ type: "text", text: output }],
		timestamp: opts?.timestamp ?? Date.now(),
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Rerun duplicate rendering bug", () => {
	const SESSION_PATH = "/tmp/sessions/test-session.jsonl";

	function setupWithAbortedRun() {
		const { adapter, sent, simulateServerMessage } = createTestAdapter();

		// Set up session in detached state (after a completed/aborted run)
		(adapter as any)._sessionPath = SESSION_PATH;
		(adapter as any)._sessionId = "test-session";
		(adapter as any)._sessionStatus = "detached";
		(adapter as any)._state.model = {
			provider: "anthropic",
			id: "claude-sonnet-4-20250514",
		};

		// Pre-populate with messages from the aborted run
		const oldToolCallId = "tool_old_001";
		(adapter as any)._state.messages = [
			{ role: "user", content: "sleep 200", timestamp: 1000 },
			{
				...makeAssistantWithBash(oldToolCallId, "sleep 200", { timestamp: 1001 }),
				stopReason: "aborted",
			},
			{
				...makeToolResult(oldToolCallId, "Command aborted", { timestamp: 1002 }),
				isError: true,
			},
		];

		return { adapter, sent, simulateServerMessage };
	}

	it("should NOT duplicate assistant message during normal rerun streaming", async () => {
		const { adapter, simulateServerMessage } = setupWithAbortedRun();

		// Initial state: 1 assistant message (the aborted one)
		expect(countAssistantMessages(adapter)).toBe(1);

		// User clicks rerun → prompt("sleep 200") sent to server
		// (we just simulate the server-side events that come back)

		// 1. Server attaches session
		simulateServerMessage({
			type: "session_attached",
			sessionPath: SESSION_PATH,
		});
		expect(adapter.sessionStatus).toBe("attached");
		expect(adapter.state.isStreaming).toBe(true);

		// 2. agent_start
		simulateServerMessage({
			type: "agent_start",
			sessionPath: SESSION_PATH,
		});

		// 3. User message echoed back
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: { role: "user", content: "sleep 200", timestamp: 2000 },
		});

		// Should have 2 user messages (original + rerun)
		const userMsgs = adapter.state.messages.filter((m: any) => m.role === "user");
		expect(userMsgs.length).toBe(2);

		// 4. Assistant message starts streaming
		const newToolCallId = "tool_new_001";
		const newAssistant = makeAssistantWithBash(newToolCallId, "sleep 200", {
			timestamp: 2001,
		});

		simulateServerMessage({
			type: "message_start",
			sessionPath: SESSION_PATH,
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "" }],
			},
		});

		// Check streamMessage is set
		expect(adapter.state.streamMessage).not.toBeNull();

		// 5. Message updates (thinking, then tool_use appears)
		simulateServerMessage({
			type: "message_update",
			sessionPath: SESSION_PATH,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I'll run the command." },
				],
			},
		});

		simulateServerMessage({
			type: "message_update",
			sessionPath: SESSION_PATH,
			message: newAssistant,
		});

		// Still 1 assistant message in stable messages (the old aborted one)
		// The new one is only in streamMessage
		expect(countAssistantMessages(adapter)).toBe(1);
		expect(adapter.state.streamMessage).not.toBeNull();

		// 6. message_end → assistant message finalized
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: newAssistant,
		});

		// NOW we should have exactly 2 assistant messages (old aborted + new)
		expect(countAssistantMessages(adapter)).toBe(2);
		// streamMessage should be cleared
		expect(adapter.state.streamMessage).toBeNull();

		// 7. Tool execution starts
		simulateServerMessage({
			type: "tool_execution_start",
			sessionPath: SESSION_PATH,
			toolCallId: newToolCallId,
		});

		// Still 2 assistant messages - no duplication
		expect(countAssistantMessages(adapter)).toBe(2);
		expect(countToolUseMessages(adapter, "Bash")).toBe(2); // old + new

		// 8. Check: no duplicate tool call IDs
		const allToolIds = adapter.state.messages
			.filter((m: any) => m.role === "assistant")
			.flatMap((m: any) =>
				Array.isArray(m.content)
					? m.content
						.filter((c: any) => c.type === "tool_use")
						.map((c: any) => c.id)
					: [],
			);
		const uniqueToolIds = new Set(allToolIds);
		expect(allToolIds.length).toBe(uniqueToolIds.size);
	});

	it("session_detached followed by rerun has no race (server pushes authoritative state)", async () => {
		const { adapter, simulateServerMessage } = setupWithAbortedRun();

		// Track content changes
		let contentChanges = 0;
		adapter.onContentChange(() => contentChanges++);

		// Simulate: session_detached from previous run
		// In the new architecture, the server pushes session_messages after detach
		// so there's no client-side fetch to race with.
		simulateServerMessage({
			type: "session_detached",
			sessionPath: SESSION_PATH,
		});

		// Server pushes final state (authoritative, from disk)
		simulateServerMessage({
			type: "session_messages",
			sessionPath: SESSION_PATH,
			messages: [...adapter.state.messages], // same messages (the aborted run)
		});

		// Now user clicks rerun — server attaches and streams
		simulateServerMessage({
			type: "session_attached",
			sessionPath: SESSION_PATH,
		});

		simulateServerMessage({
			type: "agent_start",
			sessionPath: SESSION_PATH,
		});

		const newToolCallId = "tool_new_002";
		const newAssistant = makeAssistantWithBash(newToolCallId, "sleep 200", {
			timestamp: 3001,
		});

		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: { role: "user", content: "sleep 200", timestamp: 3000 },
		});

		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: newAssistant,
		});

		// Should have exactly 2 assistant messages (old aborted + new rerun)
		const assistantMsgs = adapter.state.messages.filter(
			(m: any) => m.role === "assistant",
		);
		expect(assistantMsgs.length).toBe(2);

		// No duplicate tool call IDs
		const bashToolUseIds = assistantMsgs.flatMap((m: any) =>
			Array.isArray(m.content)
				? m.content
					.filter((c: any) => c.type === "tool_use")
					.map((c: any) => c.id)
				: [],
		);
		expect(bashToolUseIds.length).toBe(new Set(bashToolUseIds).size);
	});

	it("should NOT duplicate when sessions_changed triggers fetchMessagesFromDisk during streaming", async () => {
		const { adapter, simulateServerMessage } = setupWithAbortedRun();

		// Start a rerun: session attached, events streaming
		simulateServerMessage({
			type: "session_attached",
			sessionPath: SESSION_PATH,
		});

		simulateServerMessage({
			type: "agent_start",
			sessionPath: SESSION_PATH,
		});

		const newToolCallId = "tool_new_003";
		const newAssistant = makeAssistantWithBash(newToolCallId, "sleep 200", {
			timestamp: 4001,
		});

		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: { role: "user", content: "sleep 200", timestamp: 4000 },
		});

		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: newAssistant,
		});

		// 2 assistant messages: old aborted + new
		expect(countAssistantMessages(adapter)).toBe(2);

		// Now sessions_changed arrives (file watcher detected JSONL change)
		// Since sessionStatus is "attached", this should NOT trigger fetchMessagesFromDisk
		simulateServerMessage({
			type: "sessions_changed",
			file: SESSION_PATH,
		});

		// Still 2 assistant messages
		expect(countAssistantMessages(adapter)).toBe(2);
	});

	it("should NOT duplicate when turn_end fires with toolResults already in messages", async () => {
		const { adapter, simulateServerMessage } = setupWithAbortedRun();

		simulateServerMessage({
			type: "session_attached",
			sessionPath: SESSION_PATH,
		});

		simulateServerMessage({
			type: "agent_start",
			sessionPath: SESSION_PATH,
		});

		const newToolCallId = "tool_new_004";
		const newAssistant = makeAssistantWithBash(newToolCallId, "sleep 200", {
			timestamp: 5001,
		});
		const toolResult = makeToolResult(newToolCallId, "done", {
			timestamp: 5002,
		});

		// User message
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: { role: "user", content: "sleep 200", timestamp: 5000 },
		});

		// Assistant with tool call
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: newAssistant,
		});

		// Tool result via message_end
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: toolResult,
		});

		// Now turn_end also delivers the same tool result
		simulateServerMessage({
			type: "turn_end",
			sessionPath: SESSION_PATH,
			message: newAssistant,
			toolResults: [{ ...toolResult }],
		});

		// Check: tool result should NOT be duplicated
		const toolResults = adapter.state.messages.filter(
			(m: any) => m.role === "tool",
		);
		console.log(
			"[turn_end test] tool results:",
			toolResults.length,
			"tool_use_ids:",
			toolResults.map((m: any) => m.tool_use_id),
		);

		// Original aborted tool result + new tool result = 2
		expect(toolResults.length).toBe(2);
	});

	it("should NOT duplicate when message_end fires for assistant that is also current streamMessage", async () => {
		const { adapter, simulateServerMessage } = setupWithAbortedRun();

		simulateServerMessage({
			type: "session_attached",
			sessionPath: SESSION_PATH,
		});
		simulateServerMessage({
			type: "agent_start",
			sessionPath: SESSION_PATH,
		});

		// User message
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: { role: "user", content: "sleep 200", timestamp: 6000 },
		});

		const newToolCallId = "tool_new_005";
		const newAssistant = makeAssistantWithBash(newToolCallId, "sleep 200", {
			timestamp: 6001,
		});

		// message_start → sets streamMessage
		simulateServerMessage({
			type: "message_start",
			sessionPath: SESSION_PATH,
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "" }],
			},
		});
		expect(adapter.state.streamMessage).not.toBeNull();

		// message_update
		simulateServerMessage({
			type: "message_update",
			sessionPath: SESSION_PATH,
			message: newAssistant,
		});
		expect(adapter.state.streamMessage).not.toBeNull();

		// message_end → clears streamMessage, adds to messages
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: newAssistant,
		});

		expect(adapter.state.streamMessage).toBeNull();
		expect(countAssistantMessages(adapter)).toBe(2);

		// Immediately followed by another message_end with the SAME message
		// (simulating a potential server double-send)
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: { ...newAssistant },
		});

		// Should still be 2, not 3
		expect(countAssistantMessages(adapter)).toBe(2);
	});

	it("comprehensive: simulates full rerun lifecycle end-to-end", async () => {
		const { adapter, simulateServerMessage } = setupWithAbortedRun();

		// Track all message counts at each step
		const snapshots: Array<{
			step: string;
			assistantCount: number;
			userCount: number;
			toolCount: number;
			streamMessage: boolean;
			isStreaming: boolean;
			messages: string[];
		}> = [];

		function snapshot(step: string) {
			snapshots.push({
				step,
				assistantCount: adapter.state.messages.filter(
					(m: any) => m.role === "assistant",
				).length,
				userCount: adapter.state.messages.filter(
					(m: any) => m.role === "user",
				).length,
				toolCount: adapter.state.messages.filter(
					(m: any) => m.role === "tool",
				).length,
				streamMessage: adapter.state.streamMessage !== null,
				isStreaming: adapter.state.isStreaming,
				messages: adapter.state.messages.map(
					(m: any) =>
						`${m.role}${m.role === "assistant" ? `(${Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_use").map((c: any) => c.id).join(",") : ""})` : ""}`,
				),
			});
		}

		snapshot("initial");

		// --- RERUN FLOW ---

		// Step 1: session_attached
		simulateServerMessage({
			type: "session_attached",
			sessionPath: SESSION_PATH,
		});
		snapshot("session_attached");

		// Step 2: agent_start
		simulateServerMessage({
			type: "agent_start",
			sessionPath: SESSION_PATH,
		});
		snapshot("agent_start");

		// Step 3: user message echo
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: { role: "user", content: "sleep 200", timestamp: 7000 },
		});
		snapshot("user_message_end");

		// Step 4: assistant message_start
		const newToolCallId = "tool_rerun_001";
		simulateServerMessage({
			type: "message_start",
			sessionPath: SESSION_PATH,
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "" }],
			},
		});
		snapshot("assistant_message_start");

		// Step 5: assistant message_update (thinking)
		simulateServerMessage({
			type: "message_update",
			sessionPath: SESSION_PATH,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Running sleep 200..." },
				],
			},
		});
		snapshot("assistant_message_update_thinking");

		// Step 6: assistant message_update (with tool_use)
		const fullAssistant = makeAssistantWithBash(
			newToolCallId,
			"sleep 200",
			{ timestamp: 7001 },
		);
		simulateServerMessage({
			type: "message_update",
			sessionPath: SESSION_PATH,
			message: fullAssistant,
		});
		snapshot("assistant_message_update_tool");

		// Step 7: assistant message_end
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: fullAssistant,
		});
		snapshot("assistant_message_end");

		// Step 8: tool_execution_start
		simulateServerMessage({
			type: "tool_execution_start",
			sessionPath: SESSION_PATH,
			toolCallId: newToolCallId,
		});
		snapshot("tool_execution_start");

		// Step 9: tool_execution_end
		simulateServerMessage({
			type: "tool_execution_end",
			sessionPath: SESSION_PATH,
			toolCallId: newToolCallId,
		});
		snapshot("tool_execution_end");

		// Step 10: turn_end with tool result
		const toolResult = makeToolResult(newToolCallId, "done", {
			timestamp: 7002,
		});
		simulateServerMessage({
			type: "turn_end",
			sessionPath: SESSION_PATH,
			message: fullAssistant,
			toolResults: [toolResult],
		});
		snapshot("turn_end");

		// Step 11: NEW turn - message_start for continuation
		simulateServerMessage({
			type: "message_start",
			sessionPath: SESSION_PATH,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "" }],
			},
		});
		snapshot("continuation_message_start");

		// Step 12: continuation message_end
		const continuationAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "The command completed successfully." },
			],
			usage: {
				inputTokens: 4000,
				outputTokens: 30,
				totalCost: 0.015,
			},
			timestamp: 7003,
			stopReason: "end_turn",
		};
		simulateServerMessage({
			type: "message_end",
			sessionPath: SESSION_PATH,
			message: continuationAssistant,
		});
		snapshot("continuation_message_end");

		// Step 13: agent_end
		simulateServerMessage({
			type: "agent_end",
			sessionPath: SESSION_PATH,
		});
		snapshot("agent_end");

		// Print all snapshots for debugging
		console.log("\n=== RERUN LIFECYCLE SNAPSHOTS ===");
		for (const s of snapshots) {
			console.log(
				`[${s.step}] assistants=${s.assistantCount} users=${s.userCount} tools=${s.toolCount} stream=${s.streamMessage} streaming=${s.isStreaming}`,
			);
			console.log(`  messages: [${s.messages.join(", ")}]`);
		}

		// ASSERTIONS: At no point should there be a duplicate
		for (const s of snapshots) {
			// After agent_start, count new assistant messages only
			// Old aborted run has 1 assistant + 1 tool result
			// New run should add at most 1 assistant per message_end

			// Extract all tool_use IDs from assistant messages
			const toolIds = adapter.state.messages
				.filter((m: any) => m.role === "assistant")
				.flatMap((m: any) =>
					Array.isArray(m.content)
						? m.content
							.filter((c: any) => c.type === "tool_use")
							.map((c: any) => c.id)
						: [],
				);
			const uniqueToolIds = new Set(toolIds);

			if (toolIds.length !== uniqueToolIds.size) {
				console.error(
					`DUPLICATE DETECTED at step "${s.step}": tool IDs =`,
					toolIds,
				);
			}
		}

		// Final assertions
		// 3 assistant messages: old aborted + new tool call + continuation
		expect(countAssistantMessages(adapter)).toBe(3);

		// All tool_use IDs should be unique
		const allToolIds = adapter.state.messages
			.filter((m: any) => m.role === "assistant")
			.flatMap((m: any) =>
				Array.isArray(m.content)
					? m.content
						.filter((c: any) => c.type === "tool_use")
						.map((c: any) => c.id)
					: [],
			);
		expect(allToolIds.length).toBe(new Set(allToolIds).size);
	});

	describe("Rendering count (simulated)", () => {
		it("counts how many times message-list would show each tool call", async () => {
			const { adapter, simulateServerMessage } = setupWithAbortedRun();

			/**
			 * Simulate what message-list + streaming-message-container
			 * would render at each point in time.
			 *
			 * message-list: renders state.messages (stable)
			 *   - For assistant messages, hidePendingToolCalls when isStreaming
			 * streaming-container: renders state.streamMessage
			 */
			function countVisibleBashBlocks(): {
				fromStableMessages: number;
				fromStreamMessage: number;
				total: number;
			} {
				const isStreaming = adapter.state.isStreaming;
				const pendingToolCalls = adapter.state.pendingToolCalls;

				// Count bash tool calls in stable messages
				let fromStable = 0;
				for (const msg of adapter.state.messages) {
					if (msg.role !== "assistant" || !Array.isArray(msg.content))
						continue;
					for (const c of msg.content as any[]) {
						if (c.type !== "tool_use" || c.name !== "Bash") continue;
						const isPending = pendingToolCalls.has(c.id);
						const hasResult = adapter.state.messages.some(
							(m: any) =>
								m.role === "tool" && m.tool_use_id === c.id,
						);
						// hidePendingToolCalls logic from AssistantMessage
						if (isStreaming && isPending && !hasResult) {
							continue; // hidden
						}
						fromStable++;
					}
				}

				// Count bash tool calls in streamMessage
				let fromStream = 0;
				const sm = adapter.state.streamMessage;
				if (sm && sm.role === "assistant" && Array.isArray(sm.content)) {
					for (const c of sm.content as any[]) {
						if (c.type === "tool_use" && c.name === "Bash") {
							fromStream++;
						}
					}
				}

				return {
					fromStableMessages: fromStable,
					fromStreamMessage: fromStream,
					total: fromStable + fromStream,
				};
			}

			// Initial: 1 bash from aborted run (with result, so visible)
			let visible = countVisibleBashBlocks();
			console.log("[visible] initial:", visible);
			expect(visible.total).toBe(1);

			// session_attached
			simulateServerMessage({
				type: "session_attached",
				sessionPath: SESSION_PATH,
			});
			visible = countVisibleBashBlocks();
			console.log("[visible] session_attached:", visible);
			// Old bash has result → still visible even during streaming
			expect(visible.total).toBe(1);

			// agent_start
			simulateServerMessage({
				type: "agent_start",
				sessionPath: SESSION_PATH,
			});
			visible = countVisibleBashBlocks();
			console.log("[visible] agent_start:", visible);
			expect(visible.total).toBe(1);

			// User message
			simulateServerMessage({
				type: "message_end",
				sessionPath: SESSION_PATH,
				message: {
					role: "user",
					content: "sleep 200",
					timestamp: 8000,
				},
			});
			visible = countVisibleBashBlocks();
			console.log("[visible] user_msg:", visible);
			expect(visible.total).toBe(1);

			// Assistant message_start
			simulateServerMessage({
				type: "message_start",
				sessionPath: SESSION_PATH,
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "" }],
				},
			});
			visible = countVisibleBashBlocks();
			console.log("[visible] assistant_start:", visible);
			expect(visible.total).toBe(1); // no tool_use yet in stream

			// Assistant message_update with tool_use
			const newToolId = "tool_vis_001";
			const assistantMsg = makeAssistantWithBash(newToolId, "sleep 200", {
				timestamp: 8001,
			});
			simulateServerMessage({
				type: "message_update",
				sessionPath: SESSION_PATH,
				message: assistantMsg,
			});
			visible = countVisibleBashBlocks();
			console.log("[visible] assistant_update_with_tool:", visible);
			// Old bash (has result, visible) + new bash in streamMessage = 2
			expect(visible.total).toBe(2);

			// Assistant message_end → tool_use moves from stream to stable
			simulateServerMessage({
				type: "message_end",
				sessionPath: SESSION_PATH,
				message: assistantMsg,
			});
			visible = countVisibleBashBlocks();
			console.log("[visible] assistant_end:", visible);
			// streamMessage is null now
			// New bash is in stable messages, NOT pending yet, isStreaming=true
			// hidePendingToolCalls check: pending=false (not in pendingToolCalls set yet)
			// So it's visible! = old bash + new bash = 2
			expect(visible.fromStreamMessage).toBe(0);
			expect(visible.fromStableMessages).toBe(2);
			expect(visible.total).toBe(2);

			// tool_execution_start
			simulateServerMessage({
				type: "tool_execution_start",
				sessionPath: SESSION_PATH,
				toolCallId: newToolId,
			});
			visible = countVisibleBashBlocks();
			console.log("[visible] tool_start:", visible);
			// NOW the new bash is pending AND isStreaming=true AND no result
			// → hidePendingToolCalls applies → HIDDEN in stable messages
			// Old bash has result → still visible
			// streamMessage is null → 0 from stream
			// Total: 1 (just the old one!) The new tool call is INVISIBLE!
			expect(visible.total).toBe(1);
			// ^^^ This is actually a bug: the running tool call is INVISIBLE
			// because it's hidden in message-list and streamMessage is null!

			console.log("\n=== RENDERING COUNT SUMMARY ===");
			console.log(
				"After message_end (before tool_execution_start): tool shows from stable messages",
			);
			console.log(
				"After tool_execution_start: tool HIDDEN in stable (pending+streaming), and streamMessage is null",
			);
			console.log(
				"→ The tool call disappears briefly, then reappears when... something re-renders",
			);
		});
	});
});

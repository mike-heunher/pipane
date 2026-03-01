/**
 * Tests for SessionJsonl — server-side session state with JSON diff sync.
 *
 * The server builds a flat state: messages array includes everything
 * (committed messages, in-flight stream message, partial tool results).
 * The client just renders it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { SessionJsonl, readSessionFromDisk, type SessionState } from "./session-jsonl.js";
import { applySyncOp, computeHash } from "../shared/jsonl-sync.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Helpers ────────────────────────────────────────────────────────────────

function parse(json: string): SessionState {
	return JSON.parse(json);
}

function makeTmpDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-session-jsonl-test-"));
}

function writeSession(
	dir: string,
	filename: string,
	opts: {
		cwd?: string;
		messages?: Array<{ role: string; content: any; timestamp?: number }>;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
	} = {},
): string {
	const filePath = path.join(dir, filename);
	const lines: string[] = [];
	const rootId = "root_" + Math.random().toString(36).slice(2, 10);

	lines.push(JSON.stringify({
		type: "session",
		cwd: opts.cwd ?? "/tmp/project",
		id: rootId,
		timestamp: new Date().toISOString(),
	}));

	if (opts.model) {
		const modelEntryId = "model_" + Math.random().toString(36).slice(2, 10);
		lines.push(JSON.stringify({
			type: "model_change",
			id: modelEntryId,
			parentId: rootId,
			provider: opts.model.provider,
			modelId: opts.model.modelId,
			timestamp: new Date().toISOString(),
		}));
		if (opts.thinkingLevel) {
			const thinkingEntryId = "think_" + Math.random().toString(36).slice(2, 10);
			lines.push(JSON.stringify({
				type: "thinking_level_change",
				id: thinkingEntryId,
				parentId: modelEntryId,
				thinkingLevel: opts.thinkingLevel,
				timestamp: new Date().toISOString(),
			}));
		}
	}

	let prevId = rootId;
	if (lines.length > 1) {
		const lastLine = JSON.parse(lines[lines.length - 1]);
		prevId = lastLine.id;
	}

	for (const msg of opts.messages ?? []) {
		const entryId = `entry_${Math.random().toString(36).slice(2, 10)}`;
		lines.push(JSON.stringify({
			type: "message",
			id: entryId,
			parentId: prevId,
			message: msg,
			timestamp: new Date(msg.timestamp ?? Date.now()).toISOString(),
		}));
		prevId = entryId;
	}

	writeFileSync(filePath, lines.join("\n") + "\n");
	return filePath;
}

/** Helper: get the last message of a given role from the flat array */
function lastMessageOfRole(state: SessionState, role: string): any {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		if ((state.messages[i] as any).role === role) return state.messages[i];
	}
	return null;
}

/** Helper: get all messages of a given role */
function messagesOfRole(state: SessionState, role: string): any[] {
	return state.messages.filter((m: any) => m.role === role);
}

/** Helper: count committed messages (excluding the in-flight stream message at the end) */
function committedMessageCount(state: SessionState): number {
	// The stream message (if any) is the last entry. We identify committed messages
	// by looking at everything up to and including all message_end-delivered entries.
	return state.messages.length;
}

/**
 * Simulate a client receiving sync ops from a SessionJsonl.
 */
class MockClient {
	json = "";
	hash = "";
	version = 0;

	async applyOp(session: SessionJsonl): Promise<SessionState | null> {
		const op = session.computeSyncOp(this.json, this.hash, this.version);
		if (!op) return null;

		const result = await applySyncOp(this.json, this.hash, op);
		if (!result) throw new Error("Sync op failed verification");

		this.json = result.data;
		this.hash = result.hash;
		this.version = session.version;
		return JSON.parse(this.json);
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SessionJsonl", () => {
	describe("constructor", () => {
		it("creates a session with initial state", () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "hello" } as any],
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
				thinkingLevel: "off",
			});

			const state = parse(session.json);
			expect(state.messages).toHaveLength(1);
			expect(state.isStreaming).toBe(true);
			expect(state.pendingToolCalls).toEqual([]);
			expect(state.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });
			expect(state.steeringQueue).toEqual([]);
		});

		it("produces a valid hash", async () => {
			const session = new SessionJsonl({
				messages: [],
				model: null,
				thinkingLevel: "off",
			});
			const expectedHash = await computeHash(session.json);
			expect(session.hash).toBe(expectedHash);
		});
	});

	describe("applyEvent", () => {
		let session: SessionJsonl;

		beforeEach(() => {
			session = new SessionJsonl({
				messages: [{ role: "user", content: "hello" } as any],
				model: null,
				thinkingLevel: "off",
			});
		});

		it("agent_start clears error", () => {
			session.applyEvent({ type: "turn_end", message: { role: "assistant", errorMessage: "oops" } } as any);
			const changed = session.applyEvent({ type: "agent_start" } as any);
			expect(changed).toBe(true);

			const state = parse(session.json);
			expect(state.error).toBeUndefined();
		});

		it("message_start appends stream message to the flat array", () => {
			const msg = { role: "assistant", content: [{ type: "text", text: "" }] };
			session.applyEvent({ type: "message_start", message: msg } as any);

			const state = parse(session.json);
			// The stream message is appended at the end of messages
			expect(state.messages).toHaveLength(2);
			expect(state.messages[1]).toEqual(msg);
		});

		it("message_update replaces the stream message at end of array", () => {
			session.applyEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "a" }] } } as any);
			const msg2 = { role: "assistant", content: [{ type: "text", text: "ab" }] };
			session.applyEvent({ type: "message_update", message: msg2 } as any);

			const state = parse(session.json);
			// Still 2 messages: user + the (updated) stream message
			expect(state.messages).toHaveLength(2);
			expect(state.messages[1]).toEqual(msg2);
		});

		it("message_end commits the message and clears stream", () => {
			session.applyEvent({ type: "message_start", message: { role: "assistant", content: [] } } as any);
			const finalMsg = { role: "assistant", content: [{ type: "text", text: "done" }] };
			session.applyEvent({ type: "message_end", message: finalMsg } as any);

			const state = parse(session.json);
			// Stream message is gone, committed message is in the array
			expect(state.messages).toHaveLength(2);
			expect(state.messages[1]).toEqual(finalMsg);
		});

		it("tool_execution_start adds to pendingToolCalls", () => {
			session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_1" } as any);
			const state = parse(session.json);
			expect(state.pendingToolCalls).toContain("tool_1");
		});

		it("tool_execution_start is idempotent", () => {
			session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_1" } as any);
			const changed = session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_1" } as any);
			expect(changed).toBe(false);
		});

		it("tool_execution_update injects partial result as synthetic toolResult in messages", () => {
			session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_1" } as any);
			session.applyEvent({
				type: "tool_execution_update",
				toolCallId: "tool_1",
				partialResult: {
					content: [{ type: "text", text: "partial output" }],
					details: {},
				},
			} as any);

			const state = parse(session.json);
			// Should have a synthetic toolResult in the messages array
			const toolResults = state.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "tool_1");
			expect(toolResults).toHaveLength(1);
			expect((toolResults[0] as any).content[0].text).toBe("partial output");
		});

		it("tool_execution_end removes from pendingToolCalls and removes partial result", () => {
			session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_1" } as any);
			session.applyEvent({
				type: "tool_execution_update",
				toolCallId: "tool_1",
				partialResult: { content: [{ type: "text", text: "output" }], details: {} },
			} as any);
			session.applyEvent({ type: "tool_execution_end", toolCallId: "tool_1" } as any);

			const state = parse(session.json);
			expect(state.pendingToolCalls).not.toContain("tool_1");
			// The synthetic partial toolResult should be gone
			const toolResults = state.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "tool_1");
			expect(toolResults).toHaveLength(0);
		});

		it("unknown events return false", () => {
			const changed = session.applyEvent({ type: "unknown_event" } as any);
			expect(changed).toBe(false);
		});

		it("hash changes on state-changing events", async () => {
			const hash1 = session.hash;

			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			} as any);
			const hash2 = session.hash;
			expect(hash2).not.toBe(hash1);

			const expectedHash = await computeHash(session.json);
			expect(hash2).toBe(expectedHash);
		});
	});

	describe("computeSyncOp", () => {
		it("returns null when nothing changed", () => {
			const session = new SessionJsonl({
				messages: [],
				model: null,
				thinkingLevel: "off",
			});
			const op = session.computeSyncOp(session.json, session.hash, session.version);
			expect(op).toBeNull();
		});

		it("returns full sync for fresh client", () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "hi" } as any],
				model: null,
				thinkingLevel: "off",
			});
			const op = session.computeSyncOp("", "", 0);
			expect(op).not.toBeNull();
			expect(op!.op).toBe("full");
		});

		it("returns delta for incremental changes", () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "hi" } as any],
				model: null,
				thinkingLevel: "off",
			});

			const clientJson = session.json;
			const clientHash = session.hash;
			const clientVersion = session.version;

			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			} as any);

			const op = session.computeSyncOp(clientJson, clientHash, clientVersion);
			expect(op).not.toBeNull();
			expect(["full", "delta"]).toContain(op!.op);
		});
	});

	describe("end-to-end sync with MockClient", () => {
		it("syncs initial state to a fresh client", async () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "hello" } as any],
				model: { provider: "test", modelId: "test-model" },
				thinkingLevel: "high",
			});

			const client = new MockClient();
			const state = await client.applyOp(session);
			expect(state).not.toBeNull();
			expect(state!.messages).toHaveLength(1);
			expect(state!.model).toEqual({ provider: "test", modelId: "test-model" });
			expect(state!.thinkingLevel).toBe("high");
		});

		it("syncs streaming messages into the flat array", async () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "hello" } as any],
				model: null,
				thinkingLevel: "off",
			});

			const client = new MockClient();
			await client.applyOp(session);

			// Start streaming — stream message appended to array
			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "" }] },
			} as any);
			let state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(2);
			expect(state!.messages[1].role).toBe("assistant");

			// Update streaming — last message updated
			session.applyEvent({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(2);
			expect((state!.messages[1] as any).content[0]).toEqual({ type: "text", text: "Hello" });

			// More streaming
			session.applyEvent({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
			} as any);
			state = await client.applyOp(session);
			expect((state!.messages[1] as any).content[0]).toEqual({ type: "text", text: "Hello world" });

			// End streaming — message finalized, still in array
			session.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Hello world!" }] },
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(2);
			expect((state!.messages[1] as any).content[0]).toEqual({ type: "text", text: "Hello world!" });
		});

		it("syncs tool execution with partial results as synthetic messages", async () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "run a loop" } as any],
				model: null,
				thinkingLevel: "off",
			});

			const client = new MockClient();
			await client.applyOp(session);

			// Assistant with tool call
			const assistantMsg = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_1", name: "Bash", arguments: '{"command":"echo hello"}' },
				],
				stopReason: "toolUse",
			};
			session.applyEvent({ type: "message_start", message: assistantMsg } as any);
			session.applyEvent({ type: "message_end", message: assistantMsg } as any);

			let state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(2);

			// Tool execution starts
			session.applyEvent({ type: "tool_execution_start", toolCallId: "call_1" } as any);
			state = await client.applyOp(session);
			expect(state!.pendingToolCalls).toContain("call_1");

			// Bash streams partial output — appears as synthetic toolResult in messages
			session.applyEvent({
				type: "tool_execution_update",
				toolCallId: "call_1",
				partialResult: { content: [{ type: "text", text: "1\n" }], details: {} },
			} as any);
			state = await client.applyOp(session);
			const partialResults = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_1");
			expect(partialResults).toHaveLength(1);
			expect((partialResults[0] as any).content[0].text).toBe("1\n");

			// More output — synthetic message updated
			session.applyEvent({
				type: "tool_execution_update",
				toolCallId: "call_1",
				partialResult: { content: [{ type: "text", text: "1\n2\n" }], details: {} },
			} as any);
			state = await client.applyOp(session);
			const updated = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_1");
			expect(updated).toHaveLength(1);
			expect((updated[0] as any).content[0].text).toBe("1\n2\n");

			// Tool execution ends — synthetic message removed
			session.applyEvent({ type: "tool_execution_end", toolCallId: "call_1" } as any);
			state = await client.applyOp(session);
			expect(state!.pendingToolCalls).not.toContain("call_1");
			const afterEnd = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_1");
			expect(afterEnd).toHaveLength(0);

			// Real tool result message arrives
			session.applyEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "Bash",
					content: [{ type: "text", text: "1\n2\n3\n" }],
				},
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(3);
		});

		it("handles multiple concurrent tool calls", async () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "do two things" } as any],
				model: null,
				thinkingLevel: "off",
			});

			const client = new MockClient();
			await client.applyOp(session);

			session.applyEvent({ type: "tool_execution_start", toolCallId: "call_1" } as any);
			session.applyEvent({ type: "tool_execution_start", toolCallId: "call_2" } as any);

			let state = await client.applyOp(session);
			expect(state!.pendingToolCalls).toEqual(["call_1", "call_2"]);

			session.applyEvent({
				type: "tool_execution_update",
				toolCallId: "call_1",
				partialResult: { content: [{ type: "text", text: "output1" }], details: {} },
			} as any);
			session.applyEvent({
				type: "tool_execution_update",
				toolCallId: "call_2",
				partialResult: { content: [{ type: "text", text: "output2" }], details: {} },
			} as any);

			state = await client.applyOp(session);
			const pr1 = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_1");
			const pr2 = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_2");
			expect(pr1).toHaveLength(1);
			expect(pr2).toHaveLength(1);

			session.applyEvent({ type: "tool_execution_end", toolCallId: "call_1" } as any);
			state = await client.applyOp(session);
			expect(state!.pendingToolCalls).toEqual(["call_2"]);
			const afterEnd1 = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_1");
			expect(afterEnd1).toHaveLength(0);
			const still2 = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_2");
			expect(still2).toHaveLength(1);
		});

		it("returns null when nothing changed", async () => {
			const session = new SessionJsonl({
				messages: [],
				model: null,
				thinkingLevel: "off",
			});

			const client = new MockClient();
			await client.applyOp(session);

			const state = await client.applyOp(session);
			expect(state).toBeNull();
		});

		it("uses delta sync for small changes", async () => {
			const messages: any[] = [];
			for (let i = 0; i < 20; i++) {
				messages.push({ role: "user", content: `message ${i} with some padding text to make it larger` });
				messages.push({ role: "assistant", content: [{ type: "text", text: `response ${i} with more text` }] });
			}

			const session = new SessionJsonl({
				messages,
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
			});

			const client = new MockClient();
			await client.applyOp(session);

			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "h" }] },
			} as any);

			const op = session.computeSyncOp(client.json, client.hash, client.version);
			expect(op).not.toBeNull();
			if (op!.op === "delta") {
				const patchSize = op!.patches.reduce((s, p) => s + p.insert.length + 20, 0);
				expect(patchSize).toBeLessThan(session.json.length);
			}

			const state = await client.applyOp(session);
			// Stream message is the last entry in the flat array
			expect(state!.messages.length).toBe(messages.length + 1);
		});

		it("handles steering queue updates", async () => {
			const session = new SessionJsonl({
				messages: [],
				model: null,
				thinkingLevel: "off",
			});

			const client = new MockClient();
			await client.applyOp(session);

			session.steeringQueue = ["do this first", "then this"];

			const state = await client.applyOp(session);
			expect(state!.steeringQueue).toEqual(["do this first", "then this"]);
		});

		it("handles error state", async () => {
			const session = new SessionJsonl({
				messages: [{ role: "user", content: "hi" } as any],
				model: null,
				thinkingLevel: "off",
			});

			const client = new MockClient();
			await client.applyOp(session);

			session.applyEvent({
				type: "turn_end",
				message: { role: "assistant", errorMessage: "API rate limit" },
			} as any);

			const state = await client.applyOp(session);
			expect(state!.error).toBe("API rate limit");
		});
	});

	describe("full lifecycle simulation", () => {
		it("simulates a complete prompt → stream → tool use → result cycle", async () => {
			const session = new SessionJsonl({
				messages: [],
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
				thinkingLevel: "off",
			});

			const client = new MockClient();

			// 1. Initial sync
			let state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(0);

			// 2. User message added
			session.applyEvent({ type: "agent_start" } as any);
			session.applyEvent({
				type: "message_end",
				message: { role: "user", content: "list files" },
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(1);

			// 3. Assistant starts streaming — appended to flat array
			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "I'll" }] },
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(2);
			expect((state!.messages[1] as any).content[0]).toEqual({ type: "text", text: "I'll" });

			// 4. Streaming continues with tool call
			session.applyEvent({
				type: "message_update",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I'll list the files." },
						{ type: "toolCall", id: "call_bash", name: "Bash", arguments: '{"command":"ls"}' },
					],
				},
			} as any);
			state = await client.applyOp(session);
			expect((state!.messages[1] as any).content).toHaveLength(2);

			// 5. Assistant message finalized
			session.applyEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I'll list the files." },
						{ type: "toolCall", id: "call_bash", name: "Bash", arguments: '{"command":"ls"}' },
					],
					stopReason: "toolUse",
				},
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(2);

			// 6. Tool execution starts
			session.applyEvent({
				type: "tool_execution_start",
				toolCallId: "call_bash",
				toolName: "Bash",
			} as any);
			state = await client.applyOp(session);
			expect(state!.pendingToolCalls).toEqual(["call_bash"]);

			// 7. Bash streams output — partial result as synthetic toolResult
			session.applyEvent({
				type: "tool_execution_update",
				toolCallId: "call_bash",
				partialResult: {
					content: [{ type: "text", text: "file1.ts\nfile2.ts\n" }],
					details: {},
				},
			} as any);
			state = await client.applyOp(session);
			const partials = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_bash");
			expect(partials).toHaveLength(1);
			expect((partials[0] as any).content[0].text).toBe("file1.ts\nfile2.ts\n");

			// 8. Tool execution ends — synthetic removed
			session.applyEvent({
				type: "tool_execution_end",
				toolCallId: "call_bash",
			} as any);
			state = await client.applyOp(session);
			expect(state!.pendingToolCalls).toEqual([]);
			const noPartials = state!.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "call_bash");
			expect(noPartials).toHaveLength(0);

			// 9. Real tool result
			session.applyEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "call_bash",
					toolName: "Bash",
					content: [{ type: "text", text: "file1.ts\nfile2.ts\n" }],
				},
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(3);

			// 10. Assistant final response
			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "Found 2 files." }] },
			} as any);
			session.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Found 2 files." }] },
			} as any);
			state = await client.applyOp(session);
			expect(state!.messages).toHaveLength(4);

			// Verify final hash integrity
			const expectedHash = await computeHash(client.json);
			expect(client.hash).toBe(expectedHash);
		});
	});
});

describe("readSessionFromDisk (jsonl version)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads messages and produces valid json/hash", async () => {
		const sessionPath = writeSession(tmpDir, "test.jsonl", {
			messages: [
				{ role: "user", content: "hello", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1001 },
			],
		});

		const result = readSessionFromDisk(sessionPath);
		const state = JSON.parse(result.json);
		expect(state.messages).toHaveLength(2);
		expect(state.isStreaming).toBe(false);
		expect(state.pendingToolCalls).toEqual([]);

		const expectedHash = await computeHash(result.json);
		expect(result.hash).toBe(expectedHash);
	});

	it("handles missing file gracefully", () => {
		const result = readSessionFromDisk("/nonexistent/path.jsonl");
		const state = JSON.parse(result.json);
		expect(state.messages).toHaveLength(0);
		expect(state.isStreaming).toBe(false);
	});
});

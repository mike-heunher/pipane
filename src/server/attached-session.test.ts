/**
 * Tests for AttachedSession and readSessionFromDisk.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AttachedSession, readSessionFromDisk, getSessionFileSize } from "./attached-session.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-attached-test-"));
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("AttachedSession", () => {
	describe("constructor and toSnapshot", () => {
		it("creates an attached session with initial state", () => {
			const session = new AttachedSession({
				messages: [{ role: "user", content: "hello" } as any],
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
				thinkingLevel: "off",
			});

			const snapshot = session.toSnapshot();
			expect(snapshot.messages).toHaveLength(1);
			expect(snapshot.streamMessage).toBeNull();
			expect(snapshot.status).toBe("streaming");
			expect(snapshot.pendingToolCalls).toEqual([]);
			expect(snapshot.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });
			expect(snapshot.steeringQueue).toEqual([]);
		});
	});

	describe("applyEvent", () => {
		let session: AttachedSession;

		beforeEach(() => {
			session = new AttachedSession({
				messages: [{ role: "user", content: "hello" } as any],
				model: null,
				thinkingLevel: "off",
			});
		});

		it("agent_start clears error and streamMessage", () => {
			session.error = "old error";
			session.streamMessage = { role: "assistant", content: "partial" } as any;

			const changed = session.applyEvent({ type: "agent_start" } as any);
			expect(changed).toBe(true);
			expect(session.error).toBeUndefined();
			expect(session.streamMessage).toBeNull();
		});

		it("message_start sets streamMessage", () => {
			const msg = { role: "assistant", content: [{ type: "text", text: "" }] };
			const changed = session.applyEvent({ type: "message_start", message: msg } as any);
			expect(changed).toBe(true);
			expect(session.streamMessage).toBe(msg);
		});

		it("message_update updates streamMessage", () => {
			const msg1 = { role: "assistant", content: [{ type: "text", text: "a" }] };
			session.applyEvent({ type: "message_start", message: msg1 } as any);

			const msg2 = { role: "assistant", content: [{ type: "text", text: "ab" }] };
			const changed = session.applyEvent({ type: "message_update", message: msg2 } as any);
			expect(changed).toBe(true);
			expect(session.streamMessage).toBe(msg2);
		});

		it("message_end clears streamMessage and appends to messages", () => {
			const streamMsg = { role: "assistant", content: [{ type: "text", text: "" }] };
			session.applyEvent({ type: "message_start", message: streamMsg } as any);

			const finalMsg = { role: "assistant", content: [{ type: "text", text: "done" }] };
			const changed = session.applyEvent({ type: "message_end", message: finalMsg } as any);
			expect(changed).toBe(true);
			expect(session.streamMessage).toBeNull();
			expect(session.messages).toHaveLength(2);
			expect(session.messages[1]).toBe(finalMsg);
		});

		it("turn_end extracts error from assistant message", () => {
			const changed = session.applyEvent({
				type: "turn_end",
				message: { role: "assistant", errorMessage: "something failed" },
			} as any);
			expect(changed).toBe(true);
			expect(session.error).toBe("something failed");
		});

		it("turn_end without error is a no-op", () => {
			const changed = session.applyEvent({
				type: "turn_end",
				message: { role: "assistant", content: [] },
			} as any);
			expect(changed).toBe(false);
		});

		it("turn_end does NOT append tool results (they come via message_end)", () => {
			const toolCallId = "tool_abc";
			session.applyEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: toolCallId, name: "bash", input: { command: "ls" } }],
				},
			} as any);

			session.applyEvent({
				type: "message_end",
				message: {
					role: "tool",
					tool_use_id: toolCallId,
					content: [{ type: "text", text: "output" }],
				},
			} as any);

			// turn_end arrives — should NOT add anything
			session.applyEvent({
				type: "turn_end",
				message: { role: "assistant", content: [] },
				toolResults: [{ role: "tool", tool_use_id: toolCallId, content: [{ type: "text", text: "output" }] }],
			} as any);

			const toolMsgs = session.messages.filter((m: any) => m.role === "tool");
			expect(toolMsgs).toHaveLength(1);
		});

		it("tool_execution_start adds to pendingToolCalls", () => {
			const changed = session.applyEvent({
				type: "tool_execution_start",
				toolCallId: "tool_123",
			} as any);
			expect(changed).toBe(true);
			expect(session.pendingToolCalls).toContain("tool_123");
		});

		it("tool_execution_start is idempotent", () => {
			session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_123" } as any);
			const changed = session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_123" } as any);
			expect(changed).toBe(false);
			expect(session.pendingToolCalls.filter(id => id === "tool_123")).toHaveLength(1);
		});

		it("tool_execution_end removes from pendingToolCalls", () => {
			session.applyEvent({ type: "tool_execution_start", toolCallId: "tool_123" } as any);
			const changed = session.applyEvent({ type: "tool_execution_end", toolCallId: "tool_123" } as any);
			expect(changed).toBe(true);
			expect(session.pendingToolCalls).not.toContain("tool_123");
		});

		it("unknown events return false", () => {
			const changed = session.applyEvent({ type: "unknown_event" } as any);
			expect(changed).toBe(false);
		});
	});

	describe("computeUpdateOp", () => {
		let session: AttachedSession;

		beforeEach(() => {
			session = new AttachedSession({
				messages: [{ role: "user", content: "hello" } as any],
				model: null,
				thinkingLevel: "off",
			});
		});

		it("returns null when version matches", () => {
			const v = session.version;
			const op = session.computeUpdateOp(v, 1);
			expect(op).toBeNull();
		});

		it("returns snapshot when client version is 0 (fresh subscription)", () => {
			const op = session.computeUpdateOp(0, 0);
			expect(op).not.toBeNull();
			expect(op!.op).toBe("snapshot");
		});

		it("returns snapshot when message count changed", () => {
			// Sync client to current state
			const v = session.version;

			session.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			} as any);

			const op = session.computeUpdateOp(v, 1);
			expect(op).not.toBeNull();
			expect(op!.op).toBe("snapshot");
		});

		it("returns stream_delta when only streamMessage changed", () => {
			// Sync client to current state
			const v1 = session.version;

			// Now update just the stream message
			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "" }] },
			} as any);

			const op = session.computeUpdateOp(v1, 1);
			expect(op).not.toBeNull();
			expect(op!.op).toBe("stream_delta");
			if (op!.op === "stream_delta") {
				expect(op!.streamMessage).not.toBeNull();
			}
		});

		it("returns snapshot for non-stream changes (error, etc.)", () => {
			const v1 = session.version;

			session.applyEvent({
				type: "turn_end",
				message: { role: "assistant", errorMessage: "oops" },
			} as any);

			const op = session.computeUpdateOp(v1, 1);
			expect(op).not.toBeNull();
			expect(op!.op).toBe("snapshot");
		});
	});

	describe("version tracking", () => {
		it("bumps version on each state-changing event", () => {
			const session = new AttachedSession({
				messages: [],
				model: null,
				thinkingLevel: "off",
			});

			const v0 = session.version;
			session.applyEvent({ type: "agent_start" } as any);
			expect(session.version).toBe(v0 + 1);

			session.applyEvent({
				type: "message_start",
				message: { role: "assistant", content: [] },
			} as any);
			expect(session.version).toBe(v0 + 2);
		});
	});
});

describe("readSessionFromDisk", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads messages from a JSONL file", () => {
		const sessionPath = writeSession(tmpDir, "test.jsonl", {
			messages: [
				{ role: "user", content: "hello", timestamp: 1000 },
				{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1001 },
			],
		});

		const snapshot = readSessionFromDisk(sessionPath);
		expect(snapshot.messages).toHaveLength(2);
		expect(snapshot.messages[0].role).toBe("user");
		expect(snapshot.messages[1].role).toBe("assistant");
		expect(snapshot.streamMessage).toBeNull();
		expect(snapshot.status).toBe("idle");
		expect(snapshot.pendingToolCalls).toEqual([]);
	});

	it("reads model and thinkingLevel", () => {
		const sessionPath = writeSession(tmpDir, "test.jsonl", {
			model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
			thinkingLevel: "high",
			messages: [{ role: "user", content: "hello", timestamp: 1000 }],
		});

		const snapshot = readSessionFromDisk(sessionPath);
		expect(snapshot.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });
		expect(snapshot.thinkingLevel).toBe("high");
	});

	it("handles missing file gracefully", () => {
		const snapshot = readSessionFromDisk("/nonexistent/path.jsonl");
		expect(snapshot.messages).toHaveLength(0);
		expect(snapshot.status).toBe("idle");
	});

	it("returns idle status (not streaming)", () => {
		const sessionPath = writeSession(tmpDir, "test.jsonl", { messages: [] });
		const snapshot = readSessionFromDisk(sessionPath);
		expect(snapshot.status).toBe("idle");
	});
});

describe("getSessionFileSize", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns file size for existing file", () => {
		const sessionPath = writeSession(tmpDir, "test.jsonl", {
			messages: [{ role: "user", content: "hello", timestamp: 1000 }],
		});
		const size = getSessionFileSize(sessionPath);
		expect(size).toBeGreaterThan(0);
	});

	it("returns 0 for non-existent file", () => {
		const size = getSessionFileSize("/nonexistent/path.jsonl");
		expect(size).toBe(0);
	});
});

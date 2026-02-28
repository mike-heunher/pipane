/**
 * Tests for SessionMessageCache.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SessionMessageCache, type CacheEvent } from "./session-message-cache.js";
import { mkdtempSync, writeFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "pi-cache-test-"));
}

/**
 * Write a minimal JSONL session file with proper parentId chains.
 * First line is the session header, subsequent lines are message entries
 * linked by parentId.
 */
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

	// Session header
	lines.push(JSON.stringify({
		type: "session",
		cwd: opts.cwd ?? "/tmp/project",
		id: rootId,
		timestamp: new Date().toISOString(),
	}));

	// Model change entry if provided
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

	// Messages — chain parentId from root (or last entry)
	let prevId = rootId;
	// If we added model/thinking entries, find the last one
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

/**
 * Write raw JSONL lines to a session file. Used when we need precise control
 * over the parentId chain (e.g. for external-modification tests).
 */
function writeRawSession(dir: string, filename: string, entries: any[]): string {
	const filePath = path.join(dir, filename);
	writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return filePath;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SessionMessageCache", () => {
	let tmpDir: string;
	let cache: SessionMessageCache;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		cache = new SessionMessageCache();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("load", () => {
		it("loads messages from a JSONL file", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [
					{ role: "user", content: "hello", timestamp: 1000 },
					{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1001 },
				],
			});

			const cached = cache.load(sessionPath);
			expect(cached.messages).toHaveLength(2);
			expect(cached.messages[0].role).toBe("user");
			expect(cached.messages[1].role).toBe("assistant");
			expect(cached.fileSize).toBeGreaterThan(0);
			expect(cached.streaming).toBe(false);
		});

		it("returns cached data on second load (no re-read)", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			const first = cache.load(sessionPath);
			const second = cache.load(sessionPath);
			expect(first).toBe(second); // Same object reference
		});

		it("handles missing file gracefully", () => {
			const cached = cache.load("/nonexistent/path.jsonl");
			expect(cached.messages).toHaveLength(0);
			expect(cached.fileSize).toBe(0);
		});

		it("loads model and thinkingLevel from context", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
				thinkingLevel: "high",
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			const cached = cache.load(sessionPath);
			expect(cached.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });
			expect(cached.thinkingLevel).toBe("high");
		});
	});

	describe("refreshIfChanged", () => {
		it("returns false when file has not changed", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);
			const changed = cache.refreshIfChanged(sessionPath);
			expect(changed).toBe(false);
		});

		it("returns true and updates cache when file has changed", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);

			// Simulate external write (append a new message) with proper parentId chain
			writeRawSession(tmpDir, "test.jsonl", [
				{ type: "session", id: "root", cwd: "/tmp/project", timestamp: new Date().toISOString() },
				{ type: "message", id: "e1", parentId: "root", message: { role: "user", content: "hello", timestamp: 1000 }, timestamp: new Date(1000).toISOString() },
				{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "world" }], timestamp: 1001 }, timestamp: new Date(1001).toISOString() },
			]);

			const changed = cache.refreshIfChanged(sessionPath);
			expect(changed).toBe(true);

			const cached = cache.get(sessionPath)!;
			expect(cached.messages).toHaveLength(2);
		});

		it("emits session_messages event when file changes", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);

			const events: CacheEvent[] = [];
			cache.subscribe((e) => events.push(e));

			// Simulate external write with proper parentId chain
			writeRawSession(tmpDir, "test.jsonl", [
				{ type: "session", id: "root", cwd: "/tmp", timestamp: new Date().toISOString() },
				{ type: "message", id: "e1", parentId: "root", message: { role: "user", content: "hello" }, timestamp: new Date().toISOString() },
				{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, timestamp: new Date().toISOString() },
			]);

			cache.refreshIfChanged(sessionPath);

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("session_messages");
			expect(events[0].sessionPath).toBe(sessionPath);
			expect(events[0].messages).toHaveLength(2);
		});

		it("skips refresh when session is streaming", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);
			cache.setStreaming(sessionPath, true);

			// Simulate external write with proper parentId chain
			writeRawSession(tmpDir, "test.jsonl", [
				{ type: "session", id: "root", cwd: "/tmp", timestamp: new Date().toISOString() },
				{ type: "message", id: "e1", parentId: "root", message: { role: "user", content: "hello" }, timestamp: new Date().toISOString() },
				{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, timestamp: new Date().toISOString() },
			]);

			const changed = cache.refreshIfChanged(sessionPath);
			expect(changed).toBe(false);

			// Should still have 1 message (not re-read)
			const cached = cache.get(sessionPath)!;
			expect(cached.messages).toHaveLength(1);
		});

		it("returns false for uncached session", () => {
			const changed = cache.refreshIfChanged("/nonexistent/path.jsonl");
			expect(changed).toBe(false);
		});
	});

	describe("applyEvent", () => {
		it("appends message on message_end", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);

			cache.applyEvent(sessionPath, {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1001 },
			} as any);

			const cached = cache.get(sessionPath)!;
			expect(cached.messages).toHaveLength(2);
			expect(cached.messages[1].role).toBe("assistant");
		});

		it("sets streamMessage on message_start and clears on message_end", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);

			const streamMsg = { role: "assistant", content: [{ type: "text", text: "" }] };
			cache.applyEvent(sessionPath, {
				type: "message_start",
				message: streamMsg,
			} as any);

			expect(cache.get(sessionPath)!.streamMessage).toBe(streamMsg);

			cache.applyEvent(sessionPath, {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1001 },
			} as any);

			expect(cache.get(sessionPath)!.streamMessage).toBeNull();
		});

		it("updates streamMessage on message_update", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [],
			});

			cache.load(sessionPath);

			const msg1 = { role: "assistant", content: [{ type: "text", text: "a" }] };
			cache.applyEvent(sessionPath, { type: "message_start", message: msg1 } as any);

			const msg2 = { role: "assistant", content: [{ type: "text", text: "ab" }] };
			cache.applyEvent(sessionPath, { type: "message_update", message: msg2 } as any);

			expect(cache.get(sessionPath)!.streamMessage).toBe(msg2);
		});

		it("handles turn_end with toolResults (dedup)", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);

			// Add assistant message
			const toolCallId = "tool_abc";
			cache.applyEvent(sessionPath, {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: toolCallId, name: "bash", input: { command: "ls" } }],
					timestamp: 1001,
				},
			} as any);

			// Add tool result via message_end (before turn_end)
			const toolResult = {
				role: "tool",
				tool_use_id: toolCallId,
				content: [{ type: "text", text: "output" }],
				timestamp: 1002,
			};
			cache.applyEvent(sessionPath, {
				type: "message_end",
				message: toolResult,
			} as any);

			// turn_end also delivers the same tool result — should NOT duplicate
			cache.applyEvent(sessionPath, {
				type: "turn_end",
				message: { role: "assistant", content: [] },
				toolResults: [{ ...toolResult }],
			} as any);

			const cached = cache.get(sessionPath)!;
			const toolMsgs = cached.messages.filter((m: any) => m.role === "tool");
			expect(toolMsgs).toHaveLength(1);
		});

		it("agent_end clears streaming state and re-reads from disk", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});

			cache.load(sessionPath);
			cache.setStreaming(sessionPath, true);

			cache.applyEvent(sessionPath, { type: "agent_end" } as any);

			const cached = cache.get(sessionPath)!;
			expect(cached.streaming).toBe(false);
			expect(cached.streamMessage).toBeNull();
		});
	});

	describe("setStreaming", () => {
		it("marks session as streaming", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", { messages: [] });
			cache.load(sessionPath);

			cache.setStreaming(sessionPath, true);
			expect(cache.get(sessionPath)!.streaming).toBe(true);

			cache.setStreaming(sessionPath, false);
			expect(cache.get(sessionPath)!.streaming).toBe(false);
		});

		it("clears streamMessage when streaming ends", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", { messages: [] });
			cache.load(sessionPath);

			cache.applyEvent(sessionPath, {
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "" }] },
			} as any);
			expect(cache.get(sessionPath)!.streamMessage).not.toBeNull();

			cache.setStreaming(sessionPath, false);
			expect(cache.get(sessionPath)!.streamMessage).toBeNull();
		});
	});

	describe("evict", () => {
		it("removes session from cache", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", { messages: [] });
			cache.load(sessionPath);
			expect(cache.get(sessionPath)).toBeDefined();

			cache.evict(sessionPath);
			expect(cache.get(sessionPath)).toBeUndefined();
		});
	});

	describe("subscribe", () => {
		it("notifies on refresh changes", () => {
			const sessionPath = writeSession(tmpDir, "test.jsonl", {
				messages: [{ role: "user", content: "hello", timestamp: 1000 }],
			});
			cache.load(sessionPath);

			const events: CacheEvent[] = [];
			const unsub = cache.subscribe((e) => events.push(e));

			// Change the file
			writeRawSession(tmpDir, "test.jsonl", [
				{ type: "session", id: "root", cwd: "/tmp", timestamp: new Date().toISOString() },
				{ type: "message", id: "e1", parentId: "root", message: { role: "user", content: "hello" }, timestamp: new Date().toISOString() },
				{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "world" }] }, timestamp: new Date().toISOString() },
			]);

			cache.refreshIfChanged(sessionPath);
			expect(events).toHaveLength(1);

			unsub();

			// Change file again — should NOT emit (unsubscribed)
			writeRawSession(tmpDir, "test.jsonl", [
				{ type: "session", id: "root2", cwd: "/tmp", timestamp: new Date().toISOString() },
				{ type: "message", id: "e3", parentId: "root2", message: { role: "user", content: "more" }, timestamp: new Date().toISOString() },
			]);
			cache.refreshIfChanged(sessionPath);
			expect(events).toHaveLength(1); // still 1
		});
	});
});

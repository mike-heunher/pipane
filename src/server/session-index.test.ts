/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionIndex } from "./session-index.js";

function makeTmpAgentDir(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "pipane-session-index-"));
	mkdirSync(path.join(root, "sessions"), { recursive: true });
	return root;
}

function writeSessionJsonl(filePath: string, lines: any[]): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("SessionIndex", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = makeTmpAgentDir();
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("builds session list with single-pass extracted fields", async () => {
		const sessionPath = path.join(agentDir, "sessions", "--project--", "a.jsonl");
		writeSessionJsonl(sessionPath, [
			{ type: "session", id: "sess-a", cwd: "/tmp/project-a", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "session_info", id: "info-1", parentId: null, timestamp: "2026-01-01T10:00:01.000Z", name: "  My Session  " },
			{ type: "message", id: "m1", parentId: "info-1", timestamp: "2026-01-01T10:00:02.000Z", message: { role: "user", timestamp: 1700000000000, content: "hello" } },
			{ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T10:00:03.000Z", message: { role: "assistant", timestamp: 1700000001000, content: [{ type: "text", text: "hi" }] } },
		]);

		const index = new SessionIndex({ agentDir, extractorVersion: "test-v1" });
		const sessions = await index.listSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe("sess-a");
		expect(sessions[0].path).toBe(sessionPath);
		expect(sessions[0].cwd).toBe("/tmp/project-a");
		expect(sessions[0].name).toBe("My Session");
		expect(sessions[0].messageCount).toBe(2);
		expect(sessions[0].firstMessage).toBe("hello");
		expect(sessions[0].lastUserPromptTime).toBe(new Date(1700000000000).toISOString());

		const cachePath = path.join(agentDir, "cache", "pipane-session-index-v1.json");
		expect(statSync(cachePath).size).toBeGreaterThan(0);
	});

	it("reuses cached metadata when files are unchanged", async () => {
		const sessionPath = path.join(agentDir, "sessions", "--project--", "a.jsonl");
		writeSessionJsonl(sessionPath, [
			{ type: "session", id: "sess-a", cwd: "/tmp/project-a", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T10:00:02.000Z", message: { role: "user", timestamp: 1700000000000, content: "hello" } },
		]);

		const index = new SessionIndex({ agentDir, extractorVersion: "test-v1" });
		const first = await index.listSessions();
		expect(first[0].firstMessage).toBe("hello");

		const cachePath = path.join(agentDir, "cache", "pipane-session-index-v1.json");
		const cacheBefore = statSync(cachePath).mtimeMs;

		const second = await index.listSessions();
		expect(second[0].firstMessage).toBe("hello");

		const cacheAfter = statSync(cachePath).mtimeMs;
		expect(cacheAfter).toBe(cacheBefore);
	});

	it("reparses changed files and drops deleted files", async () => {
		const p1 = path.join(agentDir, "sessions", "--project--", "a.jsonl");
		const p2 = path.join(agentDir, "sessions", "--project--", "b.jsonl");

		writeSessionJsonl(p1, [
			{ type: "session", id: "a", cwd: "/tmp/a", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T10:00:02.000Z", message: { role: "user", timestamp: 1700000000000, content: "one" } },
		]);
		writeSessionJsonl(p2, [
			{ type: "session", id: "b", cwd: "/tmp/b", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "message", id: "m2", parentId: null, timestamp: "2026-01-01T10:00:03.000Z", message: { role: "user", timestamp: 1700000001000, content: "two" } },
		]);

		const index = new SessionIndex({ agentDir, extractorVersion: "test-v1" });
		const first = await index.listSessions();
		expect(first.map((s) => s.id).sort()).toEqual(["a", "b"]);

		writeSessionJsonl(p1, [
			{ type: "session", id: "a", cwd: "/tmp/a", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T10:00:02.000Z", message: { role: "user", timestamp: 1700000000000, content: "one" } },
			{ type: "message", id: "m3", parentId: "m1", timestamp: "2026-01-01T10:00:04.000Z", message: { role: "assistant", timestamp: 1700000002000, content: "reply" } },
		]);
		rmSync(p2);

		const second = await index.listSessions();
		expect(second).toHaveLength(1);
		expect(second[0].id).toBe("a");
		expect(second[0].messageCount).toBe(2);
	});

	it("applies cwd display formatter when provided", async () => {
		const sessionPath = path.join(agentDir, "sessions", "--project--", "a.jsonl");
		writeSessionJsonl(sessionPath, [
			{ type: "session", id: "sess-a", cwd: "/Users/me/dev/pipane", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T10:00:02.000Z", message: { role: "user", timestamp: 1700000000000, content: "hello" } },
		]);

		const index = new SessionIndex({
			agentDir,
			extractorVersion: "test-v1",
			cwdDisplayFormatter: (cwd) => cwd.replace(/^\/Users\/me/, "~"),
		});
		const sessions = await index.listSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0].cwd).toBe("/Users/me/dev/pipane");
		expect(sessions[0].cwdDisplay).toBe("~/dev/pipane");
	});

	it("invalidates by extractor version", async () => {
		const sessionPath = path.join(agentDir, "sessions", "--project--", "a.jsonl");
		writeSessionJsonl(sessionPath, [
			{ type: "session", id: "sess-a", cwd: "/tmp/project-a", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T10:00:02.000Z", message: { role: "user", timestamp: 1700000000000, content: "hello" } },
		]);

		const v1 = new SessionIndex({ agentDir, extractorVersion: "v1" });
		await v1.listSessions();

		const cachePath = path.join(agentDir, "cache", "pipane-session-index-v1.json");
		const cache1 = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cache1.extractorVersion).toBe("v1");

		const v2 = new SessionIndex({ agentDir, extractorVersion: "v2" });
		await v2.listSessions();
		const cache2 = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cache2.extractorVersion).toBe("v2");
	});

	it("keeps listing sessions when cache write fails", async () => {
		const sessionPath = path.join(agentDir, "sessions", "--project--", "a.jsonl");
		writeSessionJsonl(sessionPath, [
			{ type: "session", id: "sess-a", cwd: "/tmp/project-a", timestamp: "2026-01-01T10:00:00.000Z" },
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T10:00:02.000Z", message: { role: "user", timestamp: 1700000000000, content: "hello" } },
		]);

		const index = new SessionIndex({ agentDir, extractorVersion: "test-v1" });
		(index as any).writeCache = () => {
			throw new Error("simulated write failure");
		};

		const sessions = await index.listSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe("sess-a");
	});
});

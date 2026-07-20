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

	it("adds a worktree label for each session cwd", async () => {
		const firstPath = path.join(agentDir, "sessions", "--project--", "a.jsonl");
		const secondPath = path.join(agentDir, "sessions", "--project--", "b.jsonl");
		writeSessionJsonl(firstPath, [
			{ type: "session", id: "sess-a", cwd: "/tmp/project", timestamp: "2026-01-01T10:00:00.000Z" },
		]);
		writeSessionJsonl(secondPath, [
			{ type: "session", id: "sess-b", cwd: "/tmp/project--wt-feature", timestamp: "2026-01-01T11:00:00.000Z" },
		]);

		const index = new SessionIndex({
			agentDir,
			extractorVersion: "test-v1",
			worktreeNameResolver: (cwd) => cwd.endsWith("--wt-feature") ? "project--wt-feature" : "root",
		});
		const sessions = await index.listSessions();

		expect(sessions.find((session) => session.id === "sess-a")?.worktreeName).toBe("root");
		expect(sessions.find((session) => session.id === "sess-b")?.worktreeName).toBe("project--wt-feature");
	});

	it("detects an existing worktree from completed file-tool activity end to end", async () => {
		const repo = path.join(agentDir, "checkouts", "project");
		const worktreeName = "project--wt-feature";
		const worktree = path.join(agentDir, "checkouts", worktreeName);
		const worktreeGitDir = path.join(repo, ".git", "worktrees", worktreeName);
		mkdirSync(path.join(repo, "src"), { recursive: true });
		mkdirSync(path.join(worktree, "src"), { recursive: true });
		mkdirSync(worktreeGitDir, { recursive: true });
		writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
		writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

		const sessionPath = path.join(agentDir, "sessions", "--project--", "worktree.jsonl");
		writeSessionJsonl(sessionPath, [
			{ type: "session", id: "sess-worktree", cwd: repo, timestamp: "2026-01-01T10:00:00.000Z" },
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2026-01-01T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "edit-1",
						name: "edit",
						arguments: { path: path.join(worktree, "src", "feature.ts"), edits: [] },
					}],
				},
			},
			{
				type: "message",
				id: "result-1",
				parentId: "assistant-1",
				timestamp: "2026-01-01T10:00:02.000Z",
				message: { role: "toolResult", toolCallId: "edit-1", content: [], isError: false },
			},
		]);

		const index = new SessionIndex({ agentDir, extractorVersion: "worktree-e2e-v1" });
		expect((await index.listSessions())[0].worktreeName).toBe(worktreeName);

		// Worktree state is intentionally not cached across listings. Removing the
		// checkout updates the label even though the session JSONL is unchanged.
		rmSync(worktree, { recursive: true, force: true });
		expect((await index.listSessions())[0].worktreeName).toBe("root");
	});

	it("passes successful file-tool activity to the worktree resolver and cache", async () => {
		const sessionPath = path.join(agentDir, "sessions", "--project--", "activity.jsonl");
		writeSessionJsonl(sessionPath, [
			{ type: "session", id: "sess-activity", cwd: "/tmp/project", timestamp: "2026-01-01T10:00:00.000Z" },
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2026-01-01T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: JSON.stringify({ path: "/tmp/project--wt-feature/src/feature.ts" }),
					}],
				},
			},
			{
				type: "message",
				id: "result-1",
				parentId: "assistant-1",
				timestamp: "2026-01-01T10:00:02.000Z",
				message: { role: "toolResult", toolCallId: "read-1", content: [], isError: false },
			},
			{
				type: "message",
				id: "assistant-2",
				parentId: "result-1",
				timestamp: "2026-01-01T10:00:03.000Z",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "failed-write",
						name: "write",
						arguments: { path: "src/failed.ts", content: "nope" },
					}],
				},
			},
			{
				type: "message",
				id: "result-2",
				parentId: "assistant-2",
				timestamp: "2026-01-01T10:00:04.000Z",
				message: { role: "toolResult", toolCallId: "failed-write", content: [], isError: true },
			},
			{
				type: "message",
				id: "assistant-3",
				parentId: "result-2",
				timestamp: "2026-01-01T10:00:05.000Z",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "parallel-1",
						name: "multi_tool_use.parallel",
						arguments: {
							tool_uses: [
								{ recipient_name: "functions.hypa_read", parameters: { path: "/tmp/project--wt-feature/src/second.ts" } },
								{ recipient_name: "functions.edit", parameters: { path: "src/main.ts", edits: [] } },
							],
						},
					}],
				},
			},
			{
				type: "message",
				id: "result-3",
				parentId: "assistant-3",
				timestamp: "2026-01-01T10:00:06.000Z",
				message: { role: "toolResult", toolCallId: "parallel-1", content: [], isError: false },
			},
		]);

		const observedPaths: string[][] = [];
		const index = new SessionIndex({
			agentDir,
			extractorVersion: "tool-activity-v1",
			worktreeNameResolver: (_cwd, recentToolPaths = []) => {
				observedPaths.push([...recentToolPaths]);
				return "activity-derived";
			},
		});

		expect((await index.listSessions())[0].worktreeName).toBe("activity-derived");
		expect((await index.listSessions())[0].worktreeName).toBe("activity-derived");
		expect(observedPaths).toEqual([
			[
				"/tmp/project--wt-feature/src/feature.ts",
				"/tmp/project--wt-feature/src/second.ts",
				"/tmp/project/src/main.ts",
			],
			[
				"/tmp/project--wt-feature/src/feature.ts",
				"/tmp/project--wt-feature/src/second.ts",
				"/tmp/project/src/main.ts",
			],
		]);
	});

	it("bounds cached file-tool history", async () => {
		const sessionPath = path.join(agentDir, "sessions", "--project--", "bounded.jsonl");
		const lines: any[] = [
			{ type: "session", id: "sess-bounded", cwd: "/tmp/project", timestamp: "2026-01-01T10:00:00.000Z" },
		];
		for (let i = 0; i < 70; i++) {
			lines.push({
				type: "message",
				id: `assistant-${i}`,
				parentId: null,
				timestamp: "2026-01-01T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: `read-${i}`, name: "read", arguments: { path: `/tmp/project/src/${i}.ts` } }],
				},
			});
			lines.push({
				type: "message",
				id: `result-${i}`,
				parentId: `assistant-${i}`,
				timestamp: "2026-01-01T10:00:02.000Z",
				message: { role: "toolResult", toolCallId: `read-${i}`, content: [], isError: false },
			});
		}
		writeSessionJsonl(sessionPath, lines);

		let observedPaths: readonly string[] = [];
		const index = new SessionIndex({
			agentDir,
			extractorVersion: "bounded-tool-activity-v1",
			worktreeNameResolver: (_cwd, recentToolPaths = []) => {
				observedPaths = recentToolPaths;
				return "root";
			},
		});
		await index.listSessions();

		expect(observedPaths).toHaveLength(16);
		expect(observedPaths[0]).toBe("/tmp/project/src/54.ts");
		expect(observedPaths[15]).toBe("/tmp/project/src/69.ts");
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

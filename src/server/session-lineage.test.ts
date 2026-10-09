/** @vitest-environment node */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	PARENT_SESSION_ENV,
	readSessionLineage,
	SESSION_LINEAGE_ENTRY_TYPE,
} from "./session-lineage.js";
import registerSessionLineage, {
	buildSessionLineage,
	linkedWorktreeProject,
	PARENT_SESSION_ENV as EXTENSION_PARENT_SESSION_ENV,
	SESSION_LINEAGE_ENTRY_TYPE as EXTENSION_ENTRY_TYPE,
} from "../../extensions/session-lineage.js";

const tempDirs: string[] = [];

function makeRepoWithWorktree(): { repo: string; worktree: string } {
	const root = mkdtempSync(path.join(os.tmpdir(), "pipane-session-lineage-"));
	tempDirs.push(root);
	const repo = path.join(root, "project");
	const worktree = path.join(root, "project--wt-feature");
	const gitDir = path.join(repo, ".git", "worktrees", "project--wt-feature");
	mkdirSync(gitDir, { recursive: true });
	mkdirSync(path.join(worktree, "web"), { recursive: true });
	writeFileSync(path.join(gitDir, "commondir"), "../..\n", "utf8");
	writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");
	return { repo, worktree };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const freshEntries = [{ type: "model_change", id: "m", parentId: null }];
const conversationEntries = [...freshEntries, { type: "message", id: "u", parentId: "m", message: { role: "user", content: "hi" } }];

describe("session lineage extension", () => {
	it("shares its entry type and environment contract with the pipane server", () => {
		expect(EXTENSION_ENTRY_TYPE).toBe(SESSION_LINEAGE_ENTRY_TYPE);
		expect(EXTENSION_PARENT_SESSION_ENV).toBe(PARENT_SESSION_ENV);
	});

	it("resolves linked worktree locations to the main checkout", () => {
		const { repo, worktree } = makeRepoWithWorktree();
		expect(linkedWorktreeProject(worktree)).toEqual({ projectCwd: repo, worktreeName: "project--wt-feature" });
		expect(linkedWorktreeProject(path.join(worktree, "web"))).toEqual({
			projectCwd: path.join(repo, "web"),
			worktreeName: "project--wt-feature",
		});
		expect(linkedWorktreeProject(repo)).toBeUndefined();
	});

	it("records the launcher's parent and worktree project for a new session", () => {
		const { repo, worktree } = makeRepoWithWorktree();
		expect(buildSessionLineage({
			reason: "startup",
			cwd: worktree,
			sessionFile: "/sessions/child.jsonl",
			env: { [PARENT_SESSION_ENV]: "/sessions/parent.jsonl" },
			entries: freshEntries,
		})).toEqual({
			version: 1,
			parentSession: "/sessions/parent.jsonl",
			projectCwd: repo,
			worktreeName: "project--wt-feature",
		});
	});

	it("only applies the launcher's parent to the startup session", () => {
		const base = { cwd: os.tmpdir(), sessionFile: "/sessions/next.jsonl", env: { [PARENT_SESSION_ENV]: "/sessions/parent.jsonl" }, entries: freshEntries };
		expect(buildSessionLineage({ ...base, reason: "new" })).toBeUndefined();
		expect(buildSessionLineage({ ...base, reason: "fork" })).toBeUndefined();
		expect(buildSessionLineage({ ...base, env: { [PARENT_SESSION_ENV]: "relative.jsonl" }, reason: "startup" })).toBeUndefined();
		expect(buildSessionLineage({ ...base, env: { [PARENT_SESSION_ENV]: "/sessions/next.jsonl" }, reason: "startup" })).toBeUndefined();
	});

	it("never rewrites lineage or annotates existing conversations without a parent", () => {
		const { worktree } = makeRepoWithWorktree();
		const base = { reason: "startup", cwd: worktree, sessionFile: "/sessions/s.jsonl", env: {} };
		expect(buildSessionLineage({ ...base, entries: conversationEntries })).toBeUndefined();
		expect(buildSessionLineage({
			...base,
			env: { [PARENT_SESSION_ENV]: "/sessions/parent.jsonl" },
			entries: [...conversationEntries, { type: "custom", customType: SESSION_LINEAGE_ENTRY_TYPE, data: {} }],
		})).toBeUndefined();
		expect(buildSessionLineage({ ...base, sessionFile: undefined, entries: freshEntries })).toBeUndefined();
		// Resuming an existing conversation as delegated work does link it.
		expect(buildSessionLineage({
			...base,
			env: { [PARENT_SESSION_ENV]: "/sessions/parent.jsonl" },
			entries: conversationEntries,
		})?.parentSession).toBe("/sessions/parent.jsonl");
	});

	it("appends the marker from session_start and the server reads it back", () => {
		const { repo, worktree } = makeRepoWithWorktree();
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const appended: Array<{ type: string; data: unknown }> = [];
		registerSessionLineage({
			on: (event: string, handler: (event: any, ctx: any) => void) => handlers.set(event, handler),
			appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		} as any);

		const previous = process.env[PARENT_SESSION_ENV];
		process.env[PARENT_SESSION_ENV] = "/sessions/parent.jsonl";
		try {
			handlers.get("session_start")!({ type: "session_start", reason: "startup" }, {
				sessionManager: {
					getCwd: () => worktree,
					getSessionFile: () => "/sessions/child.jsonl",
					getEntries: () => freshEntries,
				},
			});
		} finally {
			if (previous === undefined) delete process.env[PARENT_SESSION_ENV];
			else process.env[PARENT_SESSION_ENV] = previous;
		}

		expect(appended).toHaveLength(1);
		expect(readSessionLineage([{ type: "custom", customType: appended[0].type, data: appended[0].data }])).toEqual({
			parentSession: "/sessions/parent.jsonl",
			projectCwd: repo,
			worktreeName: "project--wt-feature",
		});
	});
});

describe("readSessionLineage", () => {
	it("uses only the first marker and drops invalid fields", () => {
		expect(readSessionLineage([
			{ type: "custom", customType: "other", data: { parentSession: "/a.jsonl" } },
			{ type: "custom", customType: SESSION_LINEAGE_ENTRY_TYPE, data: { parentSession: "relative.jsonl", projectCwd: "/repo", worktreeName: "../x" } },
			{ type: "custom", customType: SESSION_LINEAGE_ENTRY_TYPE, data: { parentSession: "/later.jsonl" } },
		])).toEqual({ projectCwd: "/repo" });
		expect(readSessionLineage([{ type: "custom", customType: SESSION_LINEAGE_ENTRY_TYPE, data: "bad" }])).toBeUndefined();
		expect(readSessionLineage([{ type: "custom", customType: SESSION_LINEAGE_ENTRY_TYPE, data: { worktreeName: "x" } }])).toBeUndefined();
		expect(readSessionLineage([])).toBeUndefined();
	});
});

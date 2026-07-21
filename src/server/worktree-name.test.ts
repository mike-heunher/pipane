/** @vitest-environment node */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorktreeName } from "./worktree-name.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pipane-worktree-name-"));
	tempDirs.push(dir);
	return dir;
}

function makeRepoWithWorktree(name = "project--wt-fix-login"): {
	repo: string;
	worktree: string;
} {
	const root = makeTempDir();
	const repo = path.join(root, "project");
	const worktree = path.join(root, name);
	const gitDir = path.join(repo, ".git", "worktrees", name);
	mkdirSync(path.join(repo, "src"), { recursive: true });
	mkdirSync(path.join(worktree, "src"), { recursive: true });
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(path.join(gitDir, "commondir"), "../..\n", "utf8");
	writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");
	return { repo, worktree };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveWorktreeName", () => {
	it("labels a regular checkout and its subdirectories as root", () => {
		const repo = path.join(makeTempDir(), "project");
		const nested = path.join(repo, "src", "feature");
		mkdirSync(path.join(repo, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		expect(resolveWorktreeName(repo)).toBe("root");
		expect(resolveWorktreeName(nested)).toBe("root");
	});

	it("defaults to root until a linked worktree file is accessed", () => {
		const { worktree } = makeRepoWithWorktree();
		const cwd = path.join(worktree, "src");

		expect(resolveWorktreeName(cwd)).toBe("root");
		expect(resolveWorktreeName(cwd, [path.join(cwd, "feature.ts")]))
			.toBe("project--wt-fix-login");
	});

	it("prefers recent same-repository tool activity over the session cwd", () => {
		const { repo, worktree } = makeRepoWithWorktree("project--wt-feature");

		expect(resolveWorktreeName(repo, [path.join(worktree, "src", "feature.ts")]))
			.toBe("project--wt-feature");
	});

	it("uses the newest same-repository activity and ignores unrelated tool reads", () => {
		const { repo, worktree } = makeRepoWithWorktree("project--wt-feature");
		const unrelated = path.join(makeTempDir(), "skills", "worktree", "SKILL.md");
		mkdirSync(path.dirname(unrelated), { recursive: true });
		writeFileSync(unrelated, "skill", "utf8");

		expect(resolveWorktreeName(repo, [
			path.join(worktree, "src", "feature.ts"),
			unrelated,
		])).toBe("project--wt-feature");

		expect(resolveWorktreeName(repo, [
			path.join(worktree, "src", "feature.ts"),
			path.join(repo, "src", "main.ts"),
			unrelated,
		])).toBe("root");
	});

	it("falls back to root after the active worktree is removed", () => {
		const { repo, worktree } = makeRepoWithWorktree("project--wt-finished");
		const activityPath = path.join(worktree, "src", "finished.ts");
		rmSync(worktree, { recursive: true, force: true });

		expect(resolveWorktreeName(repo, [activityPath])).toBe("root");
	});

	it("does not use activity from a different repository", () => {
		const first = makeRepoWithWorktree("project--wt-first");
		const second = makeRepoWithWorktree("project--wt-second");

		expect(resolveWorktreeName(first.repo, [path.join(second.worktree, "src", "other.ts")]))
			.toBe("root");
	});

	it("does not mistake a separate git directory for a linked worktree", () => {
		const root = makeTempDir();
		const repo = path.join(root, "project");
		const gitDir = path.join(root, "git-data", "project.git");
		mkdirSync(repo, { recursive: true });
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(path.join(repo, ".git"), `gitdir: ${gitDir}\n`, "utf8");

		expect(resolveWorktreeName(repo)).toBe("root");
	});

	it("labels non-Git and empty cwd values as root", () => {
		const dir = makeTempDir();

		expect(resolveWorktreeName(dir)).toBe("root");
		expect(resolveWorktreeName("")).toBe("root");
	});
});

/** @vitest-environment node */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionCheckoutResolver, resolveWorktreeName } from "./worktree-name.js";

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

	it("labels a session launched inside a linked worktree with that worktree", () => {
		const { repo, worktree } = makeRepoWithWorktree();
		const cwd = path.join(worktree, "src");

		expect(resolveWorktreeName(cwd)).toBe("project--wt-fix-login");
		expect(resolveWorktreeName(cwd, [path.join(cwd, "feature.ts")]))
			.toBe("project--wt-fix-login");
		// Newer same-repository activity in the main checkout still wins.
		expect(resolveWorktreeName(cwd, [path.join(repo, "src", "main.ts")])).toBe("root");
	});

	it("maps a linked worktree cwd to the same location in its main checkout project", () => {
		const { repo, worktree } = makeRepoWithWorktree();
		const resolveCheckout = createSessionCheckoutResolver();

		expect(resolveCheckout(worktree).projectCwd).toBe(repo);
		expect(resolveCheckout(path.join(worktree, "src")).projectCwd).toBe(path.join(repo, "src"));
		expect(resolveCheckout(repo).projectCwd).toBeUndefined();
		// The checkout used for file resolution remains activity-derived.
		expect(resolveCheckout(worktree)).toMatchObject({ activeRoot: undefined, activeWorktreeRoot: undefined });
	});

	it("uses the recorded project after a launched-in worktree is removed", () => {
		const { repo, worktree } = makeRepoWithWorktree("project--wt-finished");
		const other = makeRepoWithWorktree("project--wt-other");
		rmSync(worktree, { recursive: true, force: true });
		const resolveCheckout = createSessionCheckoutResolver();
		const hints = { projectCwd: repo, worktreeName: "project--wt-finished" };

		expect(resolveCheckout(worktree, [], hints)).toMatchObject({
			projectCwd: repo,
			worktreeName: "project--wt-finished",
		});
		// The recorded project supplies repository identity for activity filtering.
		expect(resolveCheckout(worktree, [path.join(other.worktree, "src", "x.ts")], hints).worktreeName)
			.toBe("project--wt-finished");
		expect(resolveCheckout(worktree, [path.join(repo, "src", "main.ts")], hints).worktreeName).toBe("root");
		// Newer activity inside the removed worktree outranks older main-checkout activity.
		expect(resolveCheckout(worktree, [
			path.join(repo, "src", "main.ts"),
			path.join(worktree, "src", "feature.ts"),
		], hints).worktreeName).toBe("project--wt-finished");
		// A removed sibling sharing the name prefix is not the recorded worktree.
		expect(resolveCheckout(worktree, [
			path.join(repo, "src", "main.ts"),
			path.join(`${worktree}-sibling`, "x.ts"),
		], hints).worktreeName).toBe("root");
		// Hints never override a cwd that still resolves.
		expect(resolveCheckout(repo, [], hints)).toMatchObject({ projectCwd: undefined, worktreeName: "root" });
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

	it("returns canonical active and known worktree roots for file resolution", () => {
		const { repo, worktree } = makeRepoWithWorktree("project--wt-preview");
		const resolveCheckout = createSessionCheckoutResolver();

		expect(resolveCheckout(repo, [
			path.join(worktree, "docs", "plan.md"),
			path.join(repo, "src", "main.ts"),
		])).toEqual({
			cwdRoot: repo,
			activeRoot: repo,
			activeWorktreeRoot: undefined,
			knownWorktreeRoots: [worktree],
			projectCwd: undefined,
			worktreeName: "root",
		});
		expect(resolveCheckout(repo, [path.join(worktree, "docs", "plan.md")]))
			.toMatchObject({
				activeRoot: worktree,
				activeWorktreeRoot: worktree,
				knownWorktreeRoots: [worktree],
			});
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

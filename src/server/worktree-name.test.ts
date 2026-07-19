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

	it("uses the linked worktree directory name", () => {
		const root = makeTempDir();
		const worktree = path.join(root, "project--wt-fix-login");
		const nested = path.join(worktree, "src");
		const gitDir = path.join(root, "project", ".git", "worktrees", "project--wt-fix-login");
		mkdirSync(nested, { recursive: true });
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(path.join(gitDir, "commondir"), "../..\n", "utf8");
		writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");

		expect(resolveWorktreeName(nested)).toBe("project--wt-fix-login");
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

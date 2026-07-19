import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Return a short label for the Git checkout containing cwd.
 *
 * A linked worktree has a .git file whose target contains a `commondir`
 * pointer. Regular checkouts (and non-Git directories) are labelled `root`.
 */
export function resolveWorktreeName(cwd: string): string {
	if (!cwd) return "root";

	let dir = path.resolve(cwd);
	while (true) {
		const gitPath = path.join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isDirectory()) return "root";
				if (!stat.isFile()) return "root";

				const marker = readFileSync(gitPath, "utf8").trim();
				if (!marker.startsWith("gitdir: ")) return "root";

				const gitDir = path.resolve(dir, marker.slice("gitdir: ".length).trim());
				if (!existsSync(path.join(gitDir, "commondir"))) return "root";

				return path.basename(dir) || "root";
			} catch {
				return "root";
			}
		}

		const parent = path.dirname(dir);
		if (parent === dir) return "root";
		dir = parent;
	}
}

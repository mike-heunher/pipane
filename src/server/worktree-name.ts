import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

interface GitCheckout {
	root: string;
	commonGitDir: string;
	linked: boolean;
}

export type WorktreeNameResolver = (
	cwd: string,
	recentToolPaths?: readonly string[],
) => string;

/**
 * Filesystem-only Git checkout lookup. One instance is shared across all
 * sessions in a single listing, then discarded so worktree changes are visible
 * on the next request.
 */
class GitCheckoutLookup {
	private readonly cache = new Map<string, GitCheckout | null>();

	resolve(location: string): GitCheckout | null {
		if (!location) return null;

		let dir = path.resolve(location);
		const visited: string[] = [];
		while (true) {
			if (this.cache.has(dir)) {
				return this.remember(visited, this.cache.get(dir) ?? null);
			}
			visited.push(dir);

			const gitPath = path.join(dir, ".git");
			if (existsSync(gitPath)) {
				return this.remember(visited, this.readCheckout(dir, gitPath));
			}

			const parent = path.dirname(dir);
			if (parent === dir) return this.remember(visited, null);
			dir = parent;
		}
	}

	private readCheckout(root: string, gitPath: string): GitCheckout | null {
		try {
			const stat = statSync(gitPath);
			if (stat.isDirectory()) {
				return {
					root,
					commonGitDir: canonicalPath(gitPath),
					linked: false,
				};
			}
			if (!stat.isFile()) return null;

			const marker = readFileSync(gitPath, "utf8").trim();
			if (!marker.startsWith("gitdir: ")) return null;

			const gitDir = path.resolve(root, marker.slice("gitdir: ".length).trim());
			if (!existsSync(gitDir)) return null;

			const commonDirMarker = path.join(gitDir, "commondir");
			if (!existsSync(commonDirMarker)) {
				// A separate Git directory or submodule checkout uses a .git file too,
				// but unlike a linked worktree it has no commondir pointer.
				return {
					root,
					commonGitDir: canonicalPath(gitDir),
					linked: false,
				};
			}

			const commonDir = path.resolve(
				gitDir,
				readFileSync(commonDirMarker, "utf8").trim(),
			);
			if (!existsSync(commonDir)) return null;
			return {
				root,
				commonGitDir: canonicalPath(commonDir),
				linked: true,
			};
		} catch {
			return null;
		}
	}

	private remember(visited: readonly string[], checkout: GitCheckout | null): GitCheckout | null {
		for (const location of visited) this.cache.set(location, checkout);
		return checkout;
	}
}

function canonicalPath(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

function checkoutName(checkout: GitCheckout | null): string {
	return checkout?.linked ? path.basename(checkout.root) || "root" : "root";
}

/**
 * Create a resolver with a request-scoped filesystem cache. This avoids Git
 * subprocesses and ensures shared cwd/path ancestors are only inspected once
 * while listing many sessions.
 */
export function createWorktreeNameResolver(): WorktreeNameResolver {
	const lookup = new GitCheckoutLookup();
	return (cwd, recentToolPaths = []) => {
		const cwdCheckout = lookup.resolve(cwd);

		// Tool paths are stored oldest-to-newest. The newest successful project
		// file operation is stronger evidence than Pi's immutable session cwd.
		for (let i = recentToolPaths.length - 1; i >= 0; i--) {
			const activityCheckout = lookup.resolve(recentToolPaths[i]);
			if (!activityCheckout) continue;
			if (!cwdCheckout || activityCheckout.commonGitDir === cwdCheckout.commonGitDir) {
				return checkoutName(activityCheckout);
			}
		}

		return checkoutName(cwdCheckout);
	};
}

/**
 * Return a short label for the Git checkout a session is actively using.
 *
 * Pi cannot change its process cwd persistently, so recent successful
 * read/write/edit paths override the recorded cwd when they belong to the same
 * repository. Linked worktrees are recognized by their commondir pointer.
 * Removed worktrees naturally stop matching because their .git metadata is no
 * longer present.
 */
export function resolveWorktreeName(
	cwd: string,
	recentToolPaths: readonly string[] = [],
): string {
	return createWorktreeNameResolver()(cwd, recentToolPaths);
}

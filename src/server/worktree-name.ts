import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

interface GitCheckout {
	root: string;
	commonGitDir: string;
	linked: boolean;
}

export interface SessionCheckoutResolution {
	/** Canonical root containing the immutable session CWD, when it is a Git checkout. */
	cwdRoot?: string;
	/** Canonical checkout root selected by the newest same-repository tool activity. */
	activeRoot?: string;
	/** Active root only when it is a linked worktree. */
	activeWorktreeRoot?: string;
	/** Every linked worktree evidenced on the active conversation, newest first. */
	knownWorktreeRoots: string[];
	/**
	 * Main-checkout equivalent of a session CWD launched inside a linked
	 * worktree, so its conversations belong to the repository's project.
	 */
	projectCwd?: string;
	/** Sidebar label for the checkout the conversation is using. */
	worktreeName: string;
}

/** Repository facts recorded when a session started, used after its worktree is removed. */
export interface SessionCheckoutHints {
	projectCwd?: string;
	worktreeName?: string;
}

export type SessionCheckoutResolver = (
	cwd: string,
	recentToolPaths?: readonly string[],
	hints?: SessionCheckoutHints,
) => SessionCheckoutResolution;

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
					root: canonicalPath(root),
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
					root: canonicalPath(root),
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
				root: canonicalPath(root),
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

/** Map a CWD inside a linked worktree to the same relative location in its main checkout. */
function mainCheckoutCwd(checkout: GitCheckout, cwd: string): string | undefined {
	if (path.basename(checkout.commonGitDir) !== ".git") return undefined;
	const mainRoot = path.dirname(checkout.commonGitDir);
	const relative = path.relative(checkout.root, canonicalPath(cwd));
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative ? path.join(mainRoot, relative) : mainRoot;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, path.resolve(candidate));
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function canonicalPath(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

/**
 * Resolve the current and previously evidenced linked checkouts with one
 * filesystem-only lookup cache. When the CWD is a Git checkout, activity from
 * unrelated repositories is excluded by canonical common-Git-directory identity.
 */
export function createSessionCheckoutResolver(): SessionCheckoutResolver {
	const lookup = new GitCheckoutLookup();
	return (cwd, recentToolPaths = [], hints = {}) => {
		const cwdCheckout = lookup.resolve(cwd);
		// A removed worktree no longer resolves, so the project recorded at
		// session start stands in as the repository identity.
		const recordedProjectCwd = !cwdCheckout && hints.projectCwd ? hints.projectCwd : undefined;
		const identity = cwdCheckout ?? (recordedProjectCwd ? lookup.resolve(recordedProjectCwd) : null);
		const removedCwd = recordedProjectCwd ? path.resolve(cwd) : undefined;
		let activeCheckout: GitCheckout | null = null;
		let activityLabel: string | undefined;
		const knownWorktreeRoots: string[] = [];

		for (const activityPath of recentToolPaths) {
			const activityCheckout = lookup.resolve(activityPath);
			if (!activityCheckout) {
				// Activity inside the removed worktree itself still counts as using it.
				if (removedCwd && hints.worktreeName && isWithin(removedCwd, activityPath)) {
					activityLabel = hints.worktreeName;
				}
				continue;
			}
			if (identity && activityCheckout.commonGitDir !== identity.commonGitDir) continue;
			activeCheckout = activityCheckout;
			activityLabel = activityCheckout.linked ? path.basename(activityCheckout.root) || "root" : "root";
			if (!activityCheckout.linked) continue;
			const prior = knownWorktreeRoots.indexOf(activityCheckout.root);
			if (prior >= 0) knownWorktreeRoots.splice(prior, 1);
			knownWorktreeRoots.unshift(activityCheckout.root);
		}

		// Newer same-repository activity decides the label. Without it, a session
		// launched inside a linked worktree is working in that worktree.
		let worktreeName = "root";
		if (activityLabel) {
			worktreeName = activityLabel;
		} else if (cwdCheckout?.linked) {
			worktreeName = path.basename(cwdCheckout.root) || "root";
		} else if (recordedProjectCwd && hints.worktreeName) {
			worktreeName = hints.worktreeName;
		}

		return {
			cwdRoot: cwdCheckout?.root,
			activeRoot: activeCheckout?.root,
			activeWorktreeRoot: activeCheckout?.linked ? activeCheckout.root : undefined,
			knownWorktreeRoots,
			projectCwd: cwdCheckout?.linked ? mainCheckoutCwd(cwdCheckout, cwd) : recordedProjectCwd,
			worktreeName,
		};
	};
}

/**
 * Create a resolver with a request-scoped filesystem cache. This avoids Git
 * subprocesses and ensures shared cwd/path ancestors are only inspected once
 * while listing many sessions.
 */
export function createWorktreeNameResolver(): WorktreeNameResolver {
	const resolveCheckout = createSessionCheckoutResolver();
	return (cwd, recentToolPaths = []) => resolveCheckout(cwd, recentToolPaths).worktreeName;
}

/**
 * Return a short label for the Git checkout a session is actively using.
 *
 * Pi cannot change its process cwd persistently, so recent successful
 * read/write/edit paths in the same repository identify the active checkout.
 * Without such activity, a cwd inside a linked worktree selects that worktree;
 * any other cwd is root. Linked worktrees are recognized by their commondir
 * pointer. Removed worktrees naturally stop matching because their .git
 * metadata is no longer present.
 */
export function resolveWorktreeName(
	cwd: string,
	recentToolPaths: readonly string[] = [],
): string {
	return createWorktreeNameResolver()(cwd, recentToolPaths);
}

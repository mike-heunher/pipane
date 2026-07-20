import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { getAgentDir, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
	createWorktreeNameResolver,
	type WorktreeNameResolver,
} from "./worktree-name.js";

export interface SessionListItem {
	id: string;
	path: string;
	cwd: string;
	cwdDisplay?: string;
	worktreeName?: string;
	name?: string;
	created: string;
	modified: string;
	lastUserPromptTime?: string;
	messageCount: number;
	firstMessage: string;
}

interface CachedSessionEntry {
	fileMtimeMs: number;
	fileSize: number;
	meta: SessionListItem;
	recentToolPaths?: string[];
}

interface ExtractedSessionMeta {
	meta: SessionListItem;
	recentToolPaths: string[];
}

interface SessionIndexCacheFile {
	cacheFormatVersion: 1;
	extractorVersion: string;
	generatedAt: string;
	entries: Record<string, CachedSessionEntry>;
}

const CACHE_FORMAT_VERSION = 1 as const;
const DEFAULT_EXTRACTOR_VERSION = "3";
const MAX_RECENT_TOOL_PATHS = 16;
const PATH_ACTIVITY_TOOLS = new Set([
	"edit",
	"hypa_find",
	"hypa_grep",
	"hypa_ls",
	"hypa_read",
	"read",
	"write",
]);

export class SessionIndex {
	private readonly agentDir: string;
	private readonly extractorVersion: string;
	private readonly cacheFilePath: string;
	private readonly cwdDisplayFormatter?: (cwd: string) => string;
	private readonly worktreeNameResolver?: WorktreeNameResolver;
	private inMemoryCache: SessionIndexCacheFile | null | undefined;

	constructor(opts?: {
		agentDir?: string;
		extractorVersion?: string;
		cwdDisplayFormatter?: (cwd: string) => string;
		worktreeNameResolver?: WorktreeNameResolver;
	}) {
		this.agentDir = opts?.agentDir ?? getAgentDir();
		this.extractorVersion = opts?.extractorVersion ?? DEFAULT_EXTRACTOR_VERSION;
		this.cacheFilePath = path.join(this.agentDir, "cache", "pipane-session-index-v1.json");
		this.cwdDisplayFormatter = opts?.cwdDisplayFormatter;
		this.worktreeNameResolver = opts?.worktreeNameResolver;
	}

	async listSessions(): Promise<SessionListItem[]> {
		const files = this.listSessionFiles();
		const existing = this.getCache();
		const canReuse = existing?.extractorVersion === this.extractorVersion;
		const previousEntries = canReuse ? existing!.entries : {};

		const nextEntries: Record<string, CachedSessionEntry> = {};
		const sessions: SessionListItem[] = [];
		let mutated = !canReuse;

		for (const sessionPath of files) {
			let stat;
			try {
				stat = statSync(sessionPath);
			} catch {
				mutated = true;
				continue;
			}

			const cached = previousEntries[sessionPath];
			if (cached && cached.fileMtimeMs === stat.mtimeMs && cached.fileSize === stat.size) {
				nextEntries[sessionPath] = cached;
				sessions.push(cached.meta);
				continue;
			}

			const extracted = this.extractSessionMeta(sessionPath, stat.mtimeMs);
			if (!extracted) {
				mutated = true;
				continue;
			}

			nextEntries[sessionPath] = {
				fileMtimeMs: stat.mtimeMs,
				fileSize: stat.size,
				meta: extracted.meta,
				recentToolPaths: extracted.recentToolPaths,
			};
			sessions.push(extracted.meta);
			mutated = true;
		}

		if (!mutated) {
			const prevKeys = Object.keys(previousEntries);
			if (prevKeys.length !== Object.keys(nextEntries).length) {
				mutated = true;
			} else {
				for (const key of prevKeys) {
					if (!nextEntries[key]) {
						mutated = true;
						break;
					}
				}
			}
		}

		sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

		if (mutated) {
			try {
				this.writeCache({
					cacheFormatVersion: CACHE_FORMAT_VERSION,
					extractorVersion: this.extractorVersion,
					generatedAt: new Date().toISOString(),
					entries: nextEntries,
				});
			} catch {
				// Cache writes are best-effort. Listing sessions must still succeed
				// on read-only agent dirs or transient filesystem errors.
			}
		}

		// A default resolver is scoped to one listing: its filesystem lookups are
		// shared by every session, but discarded before the next request so newly
		// created or removed worktrees are reflected immediately.
		const worktreeNameResolver = this.worktreeNameResolver ?? createWorktreeNameResolver();
		return sessions.map((session) => {
			let worktreeName = "root";
			try {
				worktreeName = worktreeNameResolver(
					session.cwd,
					nextEntries[session.path]?.recentToolPaths ?? [],
				) || "root";
			} catch {
				worktreeName = "root";
			}
			return { ...session, worktreeName };
		});
	}

	async invalidateAll(): Promise<void> {
		this.inMemoryCache = null;
		try {
			unlinkSync(this.cacheFilePath);
		} catch {
			// ignore
		}
	}

	private listSessionFiles(): string[] {
		const sessionsDir = path.join(this.agentDir, "sessions");
		if (!existsSync(sessionsDir)) return [];

		const files: string[] = [];
		const stack = [sessionsDir];
		while (stack.length > 0) {
			const current = stack.pop()!;
			let entries;
			try {
				entries = readdirSync(current, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) stack.push(full);
				else if (entry.isFile() && full.endsWith(".jsonl")) files.push(full);
			}
		}
		return files;
	}

	private extractSessionMeta(sessionPath: string, statMtimeMs: number): ExtractedSessionMeta | null {
		try {
			const content = readFileSync(sessionPath, "utf8");
			const entries = parseSessionEntries(content) as Array<any>;
			if (entries.length === 0) return null;

			const header = entries[0];
			if (header?.type !== "session" || typeof header.id !== "string") return null;
			const cwd = typeof header.cwd === "string" ? header.cwd : "";

			let name: string | undefined;
			let messageCount = 0;
			let firstMessage = "";
			let lastActivityTime: number | undefined;
			let lastUserPromptTimeMs = 0;
			const pendingToolPaths = new Map<string, string[]>();
			const recentToolPaths: string[] = [];

			for (const entry of entries) {
				if (entry?.type === "session_info" && typeof entry.name === "string") {
					const trimmed = entry.name.trim();
					if (trimmed) name = trimmed;
				}

				if (entry?.type !== "message") continue;
				messageCount++;

				const msg = entry.message;
				if (!msg || typeof msg.role !== "string" || !Object.prototype.hasOwnProperty.call(msg, "content")) continue;

				if (msg.role === "assistant") {
					this.rememberPendingToolPaths(msg.content, cwd, pendingToolPaths);
				} else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
					const completedPaths = pendingToolPaths.get(msg.toolCallId);
					pendingToolPaths.delete(msg.toolCallId);
					if (msg.isError !== true && completedPaths) {
						recentToolPaths.push(...completedPaths);
						if (recentToolPaths.length > MAX_RECENT_TOOL_PATHS) {
							recentToolPaths.splice(0, recentToolPaths.length - MAX_RECENT_TOOL_PATHS);
						}
					}
				}

				if (msg.role !== "user" && msg.role !== "assistant") continue;

				const messageTs = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
				const entryTs = typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : NaN;
				const ts = Number.isFinite(messageTs) ? messageTs : (!Number.isNaN(entryTs) ? entryTs : undefined);
				if (typeof ts === "number") {
					lastActivityTime = Math.max(lastActivityTime ?? 0, ts);
				}

				if (msg.role === "user") {
					if (typeof ts === "number") {
						lastUserPromptTimeMs = Math.max(lastUserPromptTimeMs, ts);
					}
					if (!firstMessage) {
						const text = this.extractTextContent(msg.content);
						if (text) firstMessage = text;
					}
				}
			}

			const createdMs = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
			const created = !Number.isNaN(createdMs) ? new Date(createdMs) : new Date(statMtimeMs);

			const modified = (() => {
				if (typeof lastActivityTime === "number" && lastActivityTime > 0) return new Date(lastActivityTime);
				if (!Number.isNaN(createdMs)) return new Date(createdMs);
				return new Date(statMtimeMs);
			})();

			return {
				meta: {
					id: header.id,
					path: sessionPath,
					cwd,
					cwdDisplay: cwd && this.cwdDisplayFormatter ? this.cwdDisplayFormatter(cwd) : cwd,
					name,
					created: created.toISOString(),
					modified: modified.toISOString(),
					lastUserPromptTime: lastUserPromptTimeMs > 0 ? new Date(lastUserPromptTimeMs).toISOString() : undefined,
					messageCount,
					firstMessage: firstMessage || "(no messages)",
				},
				recentToolPaths,
			};
		} catch {
			return null;
		}
	}

	private rememberPendingToolPaths(
		content: unknown,
		cwd: string,
		pendingToolPaths: Map<string, string[]>,
	): void {
		if (!Array.isArray(content)) return;
		for (const chunk of content) {
			if (chunk?.type !== "toolCall" || typeof chunk.id !== "string") continue;
			pendingToolPaths.set(
				chunk.id,
				this.extractToolPaths(chunk.name, chunk.arguments, cwd),
			);
		}
	}

	private extractToolPaths(toolName: unknown, rawArguments: unknown, cwd: string): string[] {
		if (typeof toolName !== "string") return [];
		const args = this.parseToolArguments(rawArguments);
		if (!args) return [];

		if (Array.isArray(args.tool_uses)) {
			return args.tool_uses.flatMap((toolUse: any) => this.extractToolPaths(
				toolUse?.recipient_name,
				toolUse?.parameters,
				cwd,
			));
		}

		const shortName = toolName.toLowerCase().split(".").pop() ?? "";
		if (!PATH_ACTIVITY_TOOLS.has(shortName)) return [];
		const candidate = typeof args.path === "string"
			? args.path
			: typeof args.file_path === "string"
				? args.file_path
				: "";
		if (!candidate || candidate.includes("\0")) return [];
		if (!path.isAbsolute(candidate) && !cwd) return [];
		return [path.resolve(cwd || path.parse(candidate).root, candidate)];
	}

	private parseToolArguments(rawArguments: unknown): Record<string, any> | null {
		if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
			return rawArguments as Record<string, any>;
		}
		if (typeof rawArguments !== "string") return null;
		try {
			const parsed = JSON.parse(rawArguments);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? parsed as Record<string, any>
				: null;
		} catch {
			return null;
		}
	}

	private extractTextContent(content: any): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((c: any) => c?.type === "text")
			.map((c: any) => String(c.text ?? ""))
			.join(" ")
			.trim();
	}

	private getCache(): SessionIndexCacheFile | null {
		if (this.inMemoryCache !== undefined) return this.inMemoryCache;
		this.inMemoryCache = this.readCacheFromDisk();
		return this.inMemoryCache;
	}

	private readCacheFromDisk(): SessionIndexCacheFile | null {
		try {
			if (!existsSync(this.cacheFilePath)) return null;
			const parsed = JSON.parse(readFileSync(this.cacheFilePath, "utf8"));
			if (parsed?.cacheFormatVersion !== CACHE_FORMAT_VERSION) return null;
			if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") return null;
			return parsed as SessionIndexCacheFile;
		} catch {
			return null;
		}
	}

	private writeCache(cache: SessionIndexCacheFile): void {
		const dir = path.dirname(this.cacheFilePath);
		mkdirSync(dir, { recursive: true });
		const tmp = `${this.cacheFilePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(cache), "utf8");
		renameSync(tmp, this.cacheFilePath);
		this.inMemoryCache = cache;
	}
}

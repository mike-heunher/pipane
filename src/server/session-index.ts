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
import { getAgentDir, parseSessionEntries } from "@mariozechner/pi-coding-agent";

export interface SessionListItem {
	id: string;
	path: string;
	cwd: string;
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
}

interface SessionIndexCacheFile {
	cacheFormatVersion: 1;
	extractorVersion: string;
	generatedAt: string;
	entries: Record<string, CachedSessionEntry>;
}

const CACHE_FORMAT_VERSION = 1 as const;
const DEFAULT_EXTRACTOR_VERSION = "1";

export class SessionIndex {
	private readonly agentDir: string;
	private readonly extractorVersion: string;
	private readonly cacheFilePath: string;
	private inMemoryCache: SessionIndexCacheFile | null | undefined;

	constructor(opts?: { agentDir?: string; extractorVersion?: string }) {
		this.agentDir = opts?.agentDir ?? getAgentDir();
		this.extractorVersion = opts?.extractorVersion ?? DEFAULT_EXTRACTOR_VERSION;
		this.cacheFilePath = path.join(this.agentDir, "cache", "pi-web-session-index-v1.json");
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

			const meta = this.extractSessionMeta(sessionPath, stat.mtimeMs);
			if (!meta) {
				mutated = true;
				continue;
			}

			nextEntries[sessionPath] = {
				fileMtimeMs: stat.mtimeMs,
				fileSize: stat.size,
				meta,
			};
			sessions.push(meta);
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
			this.writeCache({
				cacheFormatVersion: CACHE_FORMAT_VERSION,
				extractorVersion: this.extractorVersion,
				generatedAt: new Date().toISOString(),
				entries: nextEntries,
			});
		}

		return sessions;
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

	private extractSessionMeta(sessionPath: string, statMtimeMs: number): SessionListItem | null {
		try {
			const content = readFileSync(sessionPath, "utf8");
			const entries = parseSessionEntries(content) as Array<any>;
			if (entries.length === 0) return null;

			const header = entries[0];
			if (header?.type !== "session" || typeof header.id !== "string") return null;

			let name: string | undefined;
			let messageCount = 0;
			let firstMessage = "";
			let lastActivityTime: number | undefined;
			let lastUserPromptTimeMs = 0;

			for (const entry of entries) {
				if (entry?.type === "session_info" && typeof entry.name === "string") {
					const trimmed = entry.name.trim();
					if (trimmed) name = trimmed;
				}

				if (entry?.type !== "message") continue;
				messageCount++;

				const msg = entry.message;
				if (!msg || typeof msg.role !== "string" || !Object.prototype.hasOwnProperty.call(msg, "content")) continue;
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
				id: header.id,
				path: sessionPath,
				cwd: typeof header.cwd === "string" ? header.cwd : "",
				name,
				created: created.toISOString(),
				modified: modified.toISOString(),
				lastUserPromptTime: lastUserPromptTimeMs > 0 ? new Date(lastUserPromptTimeMs).toISOString() : undefined,
				messageCount,
				firstMessage: firstMessage || "(no messages)",
			};
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

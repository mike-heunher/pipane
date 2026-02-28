/**
 * Server-side message cache for sessions.
 *
 * Acts as a read-through cache backed by JSONL files on disk.
 * When a session is loaded, messages are read from disk and cached.
 * During streaming, events update the cache in-place. External changes
 * (from other pi clients) are detected by the file watcher and trigger
 * a re-read from disk.
 *
 * The cache is the single source of truth that the server pushes to
 * the client. The client never reads JSONL directly.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
	parseSessionEntries,
	buildSessionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

export interface CachedSession {
	messages: AgentMessage[];
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/** File size at last read — cheap change detection */
	fileSize: number;
	/** Whether a pi process is actively streaming into this cache */
	streaming: boolean;
	/** The current streamMessage (partial, not yet in messages[]) */
	streamMessage: AgentMessage | null;
}

export type CacheEventType = "session_messages";

export interface CacheEvent {
	type: CacheEventType;
	sessionPath: string;
	messages: AgentMessage[];
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
}

export type CacheEventListener = (event: CacheEvent) => void;

export class SessionMessageCache {
	private cache = new Map<string, CachedSession>();
	private listeners = new Set<CacheEventListener>();

	// ── Event subscription ──────────────────────────────────────────────

	subscribe(fn: CacheEventListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(event: CacheEvent) {
		for (const fn of this.listeners) fn(event);
	}

	// ── Load / get ──────────────────────────────────────────────────────

	/**
	 * Load a session from disk into the cache (or return cache hit).
	 * Always reads from disk if not cached yet.
	 */
	load(sessionPath: string): CachedSession {
		const existing = this.cache.get(sessionPath);
		if (existing) return existing;
		return this.readFromDisk(sessionPath);
	}

	/**
	 * Get the cached state without triggering a disk read.
	 * Returns undefined if not cached.
	 */
	get(sessionPath: string): CachedSession | undefined {
		return this.cache.get(sessionPath);
	}

	// ── Refresh from disk ───────────────────────────────────────────────

	/**
	 * Re-read from disk if the file size changed.
	 * Skips if a pi process is actively streaming (our own writes).
	 * Returns true if messages were updated, and emits session_messages.
	 */
	refreshIfChanged(sessionPath: string): boolean {
		const cached = this.cache.get(sessionPath);

		// If not cached, no subscriber cares — skip
		if (!cached) return false;

		// Don't re-read while we're streaming into this session
		// (the cache is being updated by applyEvent, and the JSONL writes
		// are our own pi process's output)
		if (cached.streaming) return false;

		// Check file size for cheap change detection
		try {
			if (!existsSync(sessionPath)) return false;
			const stat = statSync(sessionPath);
			if (stat.size === cached.fileSize) return false;
		} catch {
			return false;
		}

		// File changed — re-read
		const updated = this.readFromDisk(sessionPath);

		this.emit({
			type: "session_messages",
			sessionPath,
			messages: updated.messages,
			model: updated.model,
			thinkingLevel: updated.thinkingLevel,
		});

		return true;
	}

	// ── Streaming state ─────────────────────────────────────────────────

	/**
	 * Mark a session as streaming (pi process attached) or not.
	 */
	setStreaming(sessionPath: string, streaming: boolean): void {
		const cached = this.cache.get(sessionPath);
		if (cached) {
			cached.streaming = streaming;
			if (!streaming) {
				cached.streamMessage = null;
			}
		}
	}

	/**
	 * Apply a streaming event to the cached state.
	 * This mirrors the updateState logic from the client but runs server-side.
	 */
	applyEvent(sessionPath: string, event: AgentEvent): void {
		let cached = this.cache.get(sessionPath);
		if (!cached) {
			// Lazy-load if someone starts streaming into an uncached session
			cached = this.readFromDisk(sessionPath);
		}

		switch (event.type) {
			case "message_start":
				cached.streamMessage = (event as any).message;
				break;

			case "message_update":
				cached.streamMessage = (event as any).message;
				break;

			case "message_end": {
				cached.streamMessage = null;
				const msg = (event as any).message as AgentMessage;
				if (msg) {
					cached.messages = [...cached.messages, msg];
				}
				break;
			}

			case "turn_end": {
				const toolResults = (event as any).toolResults as AgentMessage[] | undefined;
				if (toolResults) {
					for (const tr of toolResults) {
						// Dedup: check if tool result already present
						const isDuplicate = cached.messages.some(
							(m: any) => m.role === "tool" && m.tool_use_id && m.tool_use_id === (tr as any).tool_use_id,
						);
						if (!isDuplicate) {
							cached.messages = [...cached.messages, tr];
						}
					}
				}
				break;
			}

			case "agent_end":
				cached.streaming = false;
				cached.streamMessage = null;
				// Re-read from disk to get final authoritative state
				// (the JSONL now has the complete turn)
				this.readFromDisk(sessionPath);
				break;
		}
	}

	// ── Eviction ────────────────────────────────────────────────────────

	/**
	 * Evict a session from the cache.
	 */
	evict(sessionPath: string): void {
		this.cache.delete(sessionPath);
	}

	/**
	 * Get all cached session paths (for debug).
	 */
	get cachedPaths(): string[] {
		return Array.from(this.cache.keys());
	}

	// ── Internal ────────────────────────────────────────────────────────

	private readFromDisk(sessionPath: string): CachedSession {
		let messages: AgentMessage[] = [];
		let model: { provider: string; modelId: string } | undefined;
		let thinkingLevel: string | undefined;
		let fileSize = 0;

		try {
			if (existsSync(sessionPath)) {
				const stat = statSync(sessionPath);
				fileSize = stat.size;
				const content = readFileSync(sessionPath, "utf8");
				const entries = parseSessionEntries(content);
				const context = buildSessionContext(entries as any);
				messages = context.messages ?? [];
				model = context.model;
				thinkingLevel = context.thinkingLevel;
			}
		} catch (err) {
			console.error(`[cache] Failed to read session ${sessionPath}:`, err);
		}

		const existing = this.cache.get(sessionPath);
		const cached: CachedSession = {
			messages,
			model,
			thinkingLevel,
			fileSize,
			streaming: existing?.streaming ?? false,
			streamMessage: existing?.streaming ? (existing.streamMessage ?? null) : null,
		};
		this.cache.set(sessionPath, cached);
		return cached;
	}
}

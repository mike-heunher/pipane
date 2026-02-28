/**
 * Compiled session state — single source of truth per session.
 *
 * Merges JSONL on disk + live streaming events into one canonical state.
 * All mutations go through this module. Every mutation bumps `version`.
 *
 * The WsHandler diffs against each client's last-seen version and picks
 * the cheapest update op to send.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
	parseSessionEntries,
	buildSessionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

// ── Exported types ─────────────────────────────────────────────────────────

export interface CompiledState {
	version: number;
	messages: AgentMessage[];
	streamMessage: AgentMessage | null;
	status: "idle" | "streaming";
	pendingToolCalls: string[];
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	steeringQueue: string[];
	error?: string;
}

/**
 * Wire-protocol update ops sent to clients.
 */
export type SessionUpdateOp =
	| { op: "snapshot"; state: CompiledState }
	| { op: "stream_delta"; streamMessage: AgentMessage | null; pendingToolCalls?: string[] }
	| { op: "append_messages"; messages: AgentMessage[]; newVersion: number }
	| { op: "patch"; changes: Partial<CompiledState>; newVersion: number };

// ── Internal per-session data ──────────────────────────────────────────────

interface SessionData {
	state: CompiledState;
	/** File size at last disk read — cheap change detection */
	fileSize: number;
	/** Whether a pi process is actively streaming */
	streaming: boolean;
}

export type CompiledSessionEventType = "state_changed";

export interface CompiledSessionEvent {
	type: CompiledSessionEventType;
	sessionPath: string;
	/** Snapshot of state BEFORE the change (for diff computation) */
	prevVersion: number;
	prevMessageCount: number;
}

export type CompiledSessionListener = (event: CompiledSessionEvent) => void;

// ── Main class ─────────────────────────────────────────────────────────────

export class CompiledSessionStore {
	private sessions = new Map<string, SessionData>();
	private listeners = new Set<CompiledSessionListener>();

	// ── Event subscription ──────────────────────────────────────────────

	subscribe(fn: CompiledSessionListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(event: CompiledSessionEvent) {
		for (const fn of this.listeners) fn(event);
	}

	// ── Load / get ──────────────────────────────────────────────────────

	/**
	 * Load a session from disk into the store (or return existing).
	 */
	load(sessionPath: string): CompiledState {
		const existing = this.sessions.get(sessionPath);
		if (existing) return existing.state;
		return this.readFromDisk(sessionPath).state;
	}

	/**
	 * Get the current state without triggering a disk read.
	 */
	get(sessionPath: string): CompiledState | undefined {
		return this.sessions.get(sessionPath)?.state;
	}

	// ── Mutations ───────────────────────────────────────────────────────

	/**
	 * Apply a streaming event from a pi process.
	 * Bumps version and emits state_changed.
	 */
	applyEvent(sessionPath: string, event: AgentEvent): void {
		let data = this.sessions.get(sessionPath);
		if (!data) {
			data = this.readFromDisk(sessionPath);
		}

		const prevVersion = data.state.version;
		const prevMessageCount = data.state.messages.length;

		switch (event.type) {
			case "agent_start":
				data.state.status = "streaming";
				data.state.error = undefined;
				data.state.streamMessage = null;
				data.state.version++;
				break;

			case "agent_end":
				data.state.status = "idle";
				data.state.streamMessage = null;
				data.state.pendingToolCalls = [];
				data.streaming = false;
				data.state.version++;
				// Re-read from disk to get final authoritative state
				this.readFromDisk(sessionPath);
				return; // readFromDisk already emits

			case "message_start":
				data.state.streamMessage = (event as any).message;
				data.state.version++;
				break;

			case "message_update":
				data.state.streamMessage = (event as any).message;
				data.state.version++;
				break;

			case "message_end": {
				data.state.streamMessage = null;
				const msg = (event as any).message as AgentMessage;
				if (msg) {
					data.state.messages = [...data.state.messages, msg];
				}
				data.state.version++;
				break;
			}

			case "turn_end": {
				// Extract error if present. Tool results already come via message_end.
				if ((event as any).message?.role === "assistant" && (event as any).message?.errorMessage) {
					data.state.error = (event as any).message.errorMessage;
					data.state.version++;
				}
				break;
			}

			case "tool_execution_start": {
				const toolCallId = (event as any).toolCallId as string;
				if (toolCallId && !data.state.pendingToolCalls.includes(toolCallId)) {
					data.state.pendingToolCalls = [...data.state.pendingToolCalls, toolCallId];
					data.state.version++;
				}
				break;
			}

			case "tool_execution_end": {
				const toolCallId = (event as any).toolCallId as string;
				if (toolCallId) {
					data.state.pendingToolCalls = data.state.pendingToolCalls.filter(id => id !== toolCallId);
					data.state.version++;
				}
				break;
			}

			default:
				return; // Unknown event — no state change
		}

		this.emit({
			type: "state_changed",
			sessionPath,
			prevVersion,
			prevMessageCount,
		});
	}

	/**
	 * Mark a session as streaming (pi process attached).
	 */
	setStreaming(sessionPath: string, streaming: boolean): void {
		let data = this.sessions.get(sessionPath);
		if (!data) {
			data = this.readFromDisk(sessionPath);
		}
		if (data.streaming === streaming) return;
		const prevVersion = data.state.version;
		const prevMessageCount = data.state.messages.length;
		data.streaming = streaming;
		data.state.status = streaming ? "streaming" : "idle";
		if (!streaming) {
			data.state.streamMessage = null;
			data.state.pendingToolCalls = [];
		}
		data.state.version++;
		this.emit({ type: "state_changed", sessionPath, prevVersion, prevMessageCount });
	}

	/**
	 * Update the steering queue for a session.
	 */
	setSteeringQueue(sessionPath: string, queue: string[]): void {
		let data = this.sessions.get(sessionPath);
		if (!data) {
			data = this.readFromDisk(sessionPath);
		}
		const prevVersion = data.state.version;
		const prevMessageCount = data.state.messages.length;
		data.state.steeringQueue = [...queue];
		data.state.version++;
		this.emit({ type: "state_changed", sessionPath, prevVersion, prevMessageCount });
	}

	/**
	 * Re-read from disk if the file size changed.
	 * Skips if actively streaming (our own writes).
	 */
	refreshIfChanged(sessionPath: string): boolean {
		const data = this.sessions.get(sessionPath);
		if (!data) return false;
		if (data.streaming) return false;

		try {
			if (!existsSync(sessionPath)) return false;
			const stat = statSync(sessionPath);
			if (stat.size === data.fileSize) return false;
		} catch {
			return false;
		}

		this.readFromDisk(sessionPath);
		return true;
	}

	// ── Eviction ────────────────────────────────────────────────────────

	evict(sessionPath: string): void {
		this.sessions.delete(sessionPath);
	}

	// ── Diff / op selection ─────────────────────────────────────────────

	/**
	 * Compute the cheapest update op to bring a client from (prevVersion, prevMessageCount)
	 * to the current state.
	 *
	 * If prevVersion === current version, returns null (no update needed).
	 */
	computeUpdateOp(
		sessionPath: string,
		clientVersion: number,
		clientMessageCount: number,
	): SessionUpdateOp | null {
		const data = this.sessions.get(sessionPath);
		if (!data) return null;

		const state = data.state;
		if (state.version === clientVersion) return null;

		// If client is way behind or message count shrank (compaction, fork, etc.), send snapshot
		if (clientVersion === 0 || state.messages.length < clientMessageCount) {
			return { op: "snapshot", state };
		}

		// Check if only streamMessage/pendingToolCalls changed (high-frequency streaming)
		const messagesChanged = state.messages.length !== clientMessageCount;
		// Heuristic: if messages grew AND nothing else interesting changed, use append
		if (messagesChanged && state.messages.length > clientMessageCount) {
			const newMessages = state.messages.slice(clientMessageCount);
			return { op: "append_messages", messages: newMessages, newVersion: state.version };
		}

		if (!messagesChanged) {
			// Messages didn't change.
			if (state.streamMessage !== null || state.pendingToolCalls.length > 0) {
				return {
					op: "stream_delta",
					streamMessage: state.streamMessage,
					pendingToolCalls: state.pendingToolCalls.length > 0 ? state.pendingToolCalls : [],
				};
			}
			return {
				op: "patch",
				changes: {
					streamMessage: state.streamMessage,
					status: state.status,
					pendingToolCalls: state.pendingToolCalls,
					steeringQueue: state.steeringQueue,
					error: state.error,
					model: state.model,
					thinkingLevel: state.thinkingLevel,
				},
				newVersion: state.version,
			};
		}

		// Fallback: full snapshot
		return { op: "snapshot", state };
	}

	// ── Internal ────────────────────────────────────────────────────────

	private readFromDisk(sessionPath: string): SessionData {
		let messages: AgentMessage[] = [];
		let model: { provider: string; modelId: string } | null = null;
		let thinkingLevel: string = "off";
		let fileSize = 0;

		try {
			if (existsSync(sessionPath)) {
				const stat = statSync(sessionPath);
				fileSize = stat.size;
				const content = readFileSync(sessionPath, "utf8");
				const entries = parseSessionEntries(content);
				const context = buildSessionContext(entries as any);
				messages = context.messages ?? [];
				model = context.model ?? null;
				thinkingLevel = context.thinkingLevel ?? "off";
			}
		} catch (err) {
			console.error(`[compiled] Failed to read session ${sessionPath}:`, err);
		}

		const existing = this.sessions.get(sessionPath);
		const data: SessionData = {
			state: {
				version: (existing?.state.version ?? 0) + 1,
				messages,
				streamMessage: existing?.streaming ? (existing.state.streamMessage ?? null) : null,
				status: existing?.streaming ? "streaming" : "idle",
				pendingToolCalls: existing?.streaming ? (existing.state.pendingToolCalls ?? []) : [],
				model,
				thinkingLevel,
				steeringQueue: existing?.state.steeringQueue ?? [],
				error: existing?.state.error,
			},
			fileSize,
			streaming: existing?.streaming ?? false,
		};

		this.sessions.set(sessionPath, data);

		// Emit for disk reads (unless this is the initial load with no listeners yet)
		if (existing) {
			this.emit({
				type: "state_changed",
				sessionPath,
				prevVersion: existing.state.version,
				prevMessageCount: existing.state.messages.length,
			});
		}

		return data;
	}
}

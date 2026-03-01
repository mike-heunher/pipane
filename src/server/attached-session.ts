/**
 * Attached session state — only exists while a pi process is running a turn.
 *
 * This is the in-memory state for sessions that have a pi process attached.
 * It accumulates streaming events (message_start, message_update, message_end,
 * tool_execution_start/end) into a canonical state.
 *
 * When the turn ends (agent_end), this object is discarded and the final
 * authoritative state is read from the JSONL file on disk.
 *
 * Detached sessions have NO in-memory state — they are read from disk on demand.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
	parseSessionEntries,
	buildSessionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionSnapshot {
	messages: AgentMessage[];
	streamMessage: AgentMessage | null;
	status: "idle" | "streaming";
	pendingToolCalls: string[];
	/** Partial tool results from tool_execution_update events, keyed by toolCallId */
	partialToolResults: Record<string, any>;
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	steeringQueue: string[];
	error?: string;
}

/**
 * Wire-protocol update ops sent to clients.
 * Only two ops: snapshot (full state) and stream_delta (high-frequency streaming).
 */
export type SessionUpdateOp =
	| { op: "snapshot"; state: SessionSnapshot }
	| { op: "stream_delta"; streamMessage: AgentMessage | null; pendingToolCalls: string[]; partialToolResults: Record<string, any> };

// ── Attached session ───────────────────────────────────────────────────────

export class AttachedSession {
	messages: AgentMessage[];
	streamMessage: AgentMessage | null = null;
	pendingToolCalls: string[] = [];
	/** Partial tool results from tool_execution_update, keyed by toolCallId */
	partialToolResults: Record<string, any> = {};
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	steeringQueue: string[] = [];
	error?: string;

	/** Monotonically increasing version for change detection */
	private _version = 1;
	/** Whether the stream message changed since last push */
	private _streamDirty = false;

	constructor(init: {
		messages: AgentMessage[];
		model: { provider: string; modelId: string } | null;
		thinkingLevel: string;
	}) {
		this.messages = init.messages;
		this.model = init.model;
		this.thinkingLevel = init.thinkingLevel;
	}

	get version(): number { return this._version; }

	/**
	 * Apply a streaming event from the pi process.
	 * Returns true if state changed.
	 */
	applyEvent(event: AgentEvent): boolean {
		switch (event.type) {
			case "agent_start":
				this.error = undefined;
				this.streamMessage = null;
				this._version++;
				return true;

			case "message_start":
				this.streamMessage = (event as any).message;
				this._streamDirty = true;
				this._version++;
				return true;

			case "message_update":
				this.streamMessage = (event as any).message;
				this._streamDirty = true;
				this._version++;
				return true;

			case "message_end": {
				this.streamMessage = null;
				const msg = (event as any).message as AgentMessage;
				if (msg) {
					this.messages = [...this.messages, msg];
				}
				this._version++;
				return true;
			}

			case "turn_end": {
				if ((event as any).message?.role === "assistant" && (event as any).message?.errorMessage) {
					this.error = (event as any).message.errorMessage;
					this._version++;
					return true;
				}
				return false;
			}

			case "tool_execution_start": {
				const toolCallId = (event as any).toolCallId as string;
				if (toolCallId && !this.pendingToolCalls.includes(toolCallId)) {
					this.pendingToolCalls = [...this.pendingToolCalls, toolCallId];
					this._streamDirty = true;
					this._version++;
					return true;
				}
				return false;
			}

			case "tool_execution_update": {
				const toolCallId = (event as any).toolCallId as string;
				const partialResult = (event as any).partialResult;
				if (toolCallId && partialResult) {
					this.partialToolResults = { ...this.partialToolResults, [toolCallId]: partialResult };
					this._streamDirty = true;
					this._version++;
					return true;
				}
				return false;
			}

			case "tool_execution_end": {
				const toolCallId = (event as any).toolCallId as string;
				if (toolCallId) {
					this.pendingToolCalls = this.pendingToolCalls.filter(id => id !== toolCallId);
					// Clear partial result for this tool
					if (toolCallId in this.partialToolResults) {
						const { [toolCallId]: _, ...rest } = this.partialToolResults;
						this.partialToolResults = rest;
					}
					this._streamDirty = true;
					this._version++;
					return true;
				}
				return false;
			}

			default:
				return false;
		}
	}

	/**
	 * Build a full snapshot of the current state.
	 */
	toSnapshot(): SessionSnapshot {
		return {
			messages: this.messages,
			streamMessage: this.streamMessage,
			status: "streaming",
			pendingToolCalls: this.pendingToolCalls,
			partialToolResults: this.partialToolResults,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			steeringQueue: this.steeringQueue,
			error: this.error,
		};
	}

	/**
	 * Compute the cheapest update op to send to a client.
	 *
	 * If only streamMessage/pendingToolCalls changed (the high-frequency case
	 * during streaming), returns a lightweight stream_delta.
	 * Otherwise returns a full snapshot.
	 *
	 * Returns null if nothing changed since the client's last known version.
	 */
	computeUpdateOp(clientVersion: number, clientMessageCount: number): SessionUpdateOp | null {
		if (this._version === clientVersion) return null;

		// If client has never seen this session, or messages changed, send snapshot
		if (clientVersion === 0
			|| this.messages.length !== clientMessageCount
			|| this.messages.length < clientMessageCount) {
			this._streamDirty = false;
			return { op: "snapshot", state: this.toSnapshot() };
		}

		// Messages didn't change — only stream state changed
		if (this._streamDirty) {
			this._streamDirty = false;
			return {
				op: "stream_delta",
				streamMessage: this.streamMessage,
				pendingToolCalls: this.pendingToolCalls,
				partialToolResults: this.partialToolResults,
			};
		}

		// Something else changed (error, steering queue, etc.) — send snapshot
		return { op: "snapshot", state: this.toSnapshot() };
	}
}

// ── Disk reader ────────────────────────────────────────────────────────────

/**
 * Read a session from disk and return a snapshot.
 * Used for detached sessions (no pi process running).
 */
export function readSessionFromDisk(sessionPath: string): SessionSnapshot {
	let messages: AgentMessage[] = [];
	let model: { provider: string; modelId: string } | null = null;
	let thinkingLevel = "off";

	try {
		if (existsSync(sessionPath)) {
			const content = readFileSync(sessionPath, "utf8");
			const entries = parseSessionEntries(content);
			const context = buildSessionContext(entries as any);
			messages = context.messages ?? [];
			model = context.model ?? null;
			thinkingLevel = context.thinkingLevel ?? "off";
		}
	} catch (err) {
		console.error(`[session] Failed to read session ${sessionPath}:`, err);
	}

	return {
		messages,
		streamMessage: null,
		status: "idle",
		pendingToolCalls: [],
		partialToolResults: {},
		model,
		thinkingLevel,
		steeringQueue: [],
	};
}

/**
 * Get the file size of a session file. Returns 0 if the file doesn't exist.
 */
export function getSessionFileSize(sessionPath: string): number {
	try {
		if (existsSync(sessionPath)) {
			return statSync(sessionPath).size;
		}
	} catch {
		// ignore
	}
	return 0;
}

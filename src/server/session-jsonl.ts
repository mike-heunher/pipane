/**
 * Server-side session state manager that produces a canonical JSON representation.
 *
 * Replaces the old AttachedSession. Instead of maintaining complex state fields
 * (messages, streamMessage, pendingToolCalls, partialToolResults), this class
 * maintains a single JSON string that represents the complete session state.
 *
 * The JSON is a serialized SessionState object that the client can directly
 * use for rendering — no client-side state management needed.
 *
 * Changes are delivered to clients via the hash-verified diff protocol
 * from jsonl-sync.ts.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
	parseSessionEntries,
	buildSessionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { createHash } from "node:crypto";
import { computeSyncOp, type SyncOp } from "../shared/jsonl-sync.js";

/** Synchronous SHA-256 hash (server-only, uses node:crypto). */
function computeHashSync(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The canonical session state that gets serialized to JSON and sent to clients.
 * The client parses this and feeds it directly to the rendering layer.
 *
 * `messages` is a flat array that includes EVERYTHING:
 * - Committed messages (from JSONL)
 * - The in-flight stream message (appended at the end while streaming)
 * - Partial tool results (injected as synthetic toolResult entries)
 *
 * The client just renders this array. No splitting, no fixups.
 */
export interface SessionState {
	/** Flat message array — the complete view of the conversation, including in-flight data */
	messages: AgentMessage[];
	/** Is the agent currently running? (controls stop button + cursor animation) */
	isStreaming: boolean;
	/** Set of tool call IDs currently executing */
	pendingToolCalls: string[];
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	steeringQueue: string[];
	error?: string;
}

// ── SessionJsonl ───────────────────────────────────────────────────────────

export class SessionJsonl {
	// ── Internal state (used to build the JSON) ────────────────────────────
	private _messages: AgentMessage[];
	private _streamMessage: AgentMessage | null = null;
	private _pendingToolCalls: string[] = [];
	private _partialToolResults: Record<string, any> = {};
	private _model: { provider: string; modelId: string } | null;
	private _thinkingLevel: string;
	private _steeringQueue: string[] = [];
	private _error?: string;

	// ── Serialized state + hash ────────────────────────────────────────────
	private _json: string;
	private _hash: string;

	/** Monotonically increasing version for change detection */
	private _version = 1;

	constructor(init: {
		messages: AgentMessage[];
		model: { provider: string; modelId: string } | null;
		thinkingLevel: string;
	}) {
		this._messages = init.messages;
		this._model = init.model;
		this._thinkingLevel = init.thinkingLevel;

		// Build initial JSON
		this._json = this.buildJson();
		this._hash = computeHashSync(this._json);
	}

	get version(): number { return this._version; }
	get json(): string { return this._json; }
	get hash(): string { return this._hash; }

	// Expose for ws-handler steering queue management
	get steeringQueue(): string[] { return this._steeringQueue; }
	set steeringQueue(q: string[]) {
		this._steeringQueue = q;
		this.rebuildJson();
	}

	// Expose model for ws-handler
	get model(): { provider: string; modelId: string } | null { return this._model; }

	// Expose messages for post-detach snapshot
	get messages(): AgentMessage[] { return this._messages; }

	/**
	 * Replace the internal messages array (e.g. after auto-compaction rewrites
	 * the session). Rebuilds the JSON and bumps the version.
	 */
	replaceMessages(messages: AgentMessage[]): void {
		this._messages = messages;
		this._streamMessage = null;
		this._pendingToolCalls = [];
		this._partialToolResults = {};
		this._version++;
		this.rebuildJson();
	}

	/**
	 * Apply a streaming event from the pi process.
	 * Returns true if state changed.
	 */
	applyEvent(event: AgentEvent): boolean {
		switch (event.type) {
			case "agent_start":
				this._error = undefined;
				this._streamMessage = null;
				this._version++;
				this.rebuildJson();
				return true;

			case "message_start":
				this._streamMessage = (event as any).message;
				this._version++;
				this.rebuildJson();
				return true;

			case "message_update":
				this._streamMessage = (event as any).message;
				this._version++;
				this.rebuildJson();
				return true;

			case "message_end": {
				this._streamMessage = null;
				const msg = (event as any).message as AgentMessage;
				if (msg) {
					this._messages = [...this._messages, msg];
				}
				this._version++;
				this.rebuildJson();
				return true;
			}

			case "turn_end": {
				if ((event as any).message?.role === "assistant" && (event as any).message?.errorMessage) {
					this._error = (event as any).message.errorMessage;
					this._version++;
					this.rebuildJson();
					return true;
				}
				return false;
			}

			case "tool_execution_start": {
				const toolCallId = (event as any).toolCallId as string;
				if (toolCallId && !this._pendingToolCalls.includes(toolCallId)) {
					this._pendingToolCalls = [...this._pendingToolCalls, toolCallId];
					this._version++;
					this.rebuildJson();
					return true;
				}
				return false;
			}

			case "tool_execution_update": {
				const toolCallId = (event as any).toolCallId as string;
				const partialResult = (event as any).partialResult;
				if (toolCallId && partialResult) {
					this._partialToolResults = { ...this._partialToolResults, [toolCallId]: partialResult };
					this._version++;
					this.rebuildJson();
					return true;
				}
				return false;
			}

			case "tool_execution_end": {
				const toolCallId = (event as any).toolCallId as string;
				if (toolCallId) {
					this._pendingToolCalls = this._pendingToolCalls.filter(id => id !== toolCallId);
					if (toolCallId in this._partialToolResults) {
						const { [toolCallId]: _, ...rest } = this._partialToolResults;
						this._partialToolResults = rest;
					}
					this._version++;
					this.rebuildJson();
					return true;
				}
				return false;
			}

			default:
				return false;
		}
	}

	/**
	 * Compute a SyncOp to send to a client.
	 *
	 * @param clientJson - The client's current JSON string (empty if first sync)
	 * @param clientHash - The client's current hash (empty if first sync)
	 * @param clientVersion - The client's last known version
	 * @returns SyncOp to send, or null if nothing changed
	 */
	computeSyncOp(clientJson: string, clientHash: string, clientVersion: number): SyncOp | null {
		if (this._version === clientVersion && clientHash === this._hash) return null;
		return computeSyncOp(clientJson, this._json, clientHash, this._hash);
	}

	/**
	 * Get the full session state (for reading, not for the wire protocol).
	 */
	toState(): SessionState {
		return this.buildState();
	}

	// ── Private ────────────────────────────────────────────────────────────

	/**
	 * Build the flat session state. Merges streamMessage and partialToolResults
	 * into the messages array so the client has a single thing to render.
	 */
	private buildState(): SessionState {
		const messages: AgentMessage[] = [...this._messages];

		// Inject partial tool results as synthetic toolResult messages
		// so the client's tool renderers can show in-progress output
		for (const [id, partialResult] of Object.entries(this._partialToolResults)) {
			messages.push({
				role: "toolResult",
				toolCallId: id,
				content: partialResult.content ?? [],
				isError: false,
				details: partialResult.details,
				timestamp: Date.now(),
			} as any);
		}

		// Append the in-flight stream message at the end
		if (this._streamMessage) {
			messages.push(this._streamMessage);
		}

		return {
			messages,
			isStreaming: true,
			pendingToolCalls: this._pendingToolCalls,
			model: this._model,
			thinkingLevel: this._thinkingLevel,
			steeringQueue: this._steeringQueue,
			error: this._error,
		};
	}

	private buildJson(): string {
		return JSON.stringify(this.buildState());
	}

	private rebuildJson(): void {
		const oldJson = this._json;
		this._json = this.buildJson();
		if (this._json !== oldJson) {
			this._hash = computeHashSync(this._json);
		}
	}
}

// ── Disk reader ────────────────────────────────────────────────────────────

/**
 * Read a session from disk and return a serialized SessionState JSON + hash.
 */
export function readSessionFromDisk(sessionPath: string): { json: string; hash: string; state: SessionState } {
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

	const state: SessionState = {
		messages,
		isStreaming: false,
		pendingToolCalls: [],
		model,
		thinkingLevel,
		steeringQueue: [],
	};
	const json = JSON.stringify(state);
	const hash = computeHashSync(json);
	return { json, hash, state };
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

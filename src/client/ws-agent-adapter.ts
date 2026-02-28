/**
 * WebSocket-backed Agent adapter.
 *
 * Architecture: sessions are either "detached" (messages read from JSONL via REST)
 * or "attached" (a pi process is running a turn, streaming events).
 *
 * - On session load/switch: fetch messages from REST (reads JSONL on server)
 * - On prompt: server acquires a pi process, attaches to session, runs one turn
 * - During turn: events stream via WebSocket, update state live
 * - On agent_end: server releases pi, session goes back to detached
 * - On file watcher notification: re-fetch from REST if detached
 *
 * Model and thinking level are client-side state until a message is sent,
 * at which point they are passed to the server along with the prompt.
 *
 * Virtual sessions (new, unsaved) have no JSONL file and don't persist
 * until the first message is sent.
 */

import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";

export type SessionStatus = "virtual" | "detached" | "attached";

type WsCommand =
	| { type: "prompt"; sessionPath: string; message: string; model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel; images?: ImageContent[] }
	| { type: "steer"; sessionPath: string; message: string }
	| { type: "abort"; sessionPath: string }
	| { type: "compact"; sessionPath: string; customInstructions?: string }
	| { type: "get_available_models" }
	| { type: "set_session_name"; sessionPath: string; name: string }
	| { type: "fork"; sessionPath: string; entryId: string }
	| { type: "install_pi" };

export interface PiInstallRequiredInfo {
	command: string;
	installable: boolean;
	installing: boolean;
	message: string;
}

export class WsAgentAdapter {
	private ws: WebSocket | null = null;
	private listeners = new Set<(e: AgentEvent) => void>();
	private sessionsChangedListeners = new Set<(file: string) => void>();
	private piInstallRequiredListeners = new Set<(info: PiInstallRequiredInfo) => void>();
	private pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();
	private requestId = 0;
	private _runningPromise: Promise<void> | undefined;
	private _resolveRunning: (() => void) | undefined;

	// Dummy fields that AgentInterface checks but we don't need
	streamFn: any = () => {};
	getApiKey: any = undefined;

	private _state: AgentState = {
		systemPrompt: "",
		model: undefined as any,
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	// ── Steering queue (per-session) ───────────────────────────────────────
	/** Per-session steering queues keyed by session path. */
	private _steeringQueues = new Map<string, string[]>();
	private _steeringQueueListeners = new Set<() => void>();
	/** Whether the agent is actually running a turn (separate from state.isStreaming which we keep false for the editor) */
	private _isReallyStreaming = false;

	// ── Disk-fetch event buffering ─────────────────────────────────────────
	/** True while fetchMessagesFromDisk is in-flight. Streaming events are buffered. */
	private _fetchingDisk = false;
	/** Buffered agent events received while the disk fetch was in-flight. */
	private _diskFetchBuffer: AgentEvent[] = [];

	// ── Session state ──────────────────────────────────────────────────────
	private _sessionId: string = "";
	private _sessionPath: string | undefined;
	private _sessionName: string | undefined;
	private _sessionStatus: SessionStatus = "virtual";

	// ── Optimistic sessions ────────────────────────────────────────────────
	/** Sessions that the client knows about before the JSONL scan catches up. */
	private _optimisticSessions = new Map<string, SessionInfoDTO>();

	/** Server-authoritative status of ALL sessions: "running" or "done" */
	private _globalSessionStatus = new Map<string, "running" | "done">();
	private _globalStatusListeners = new Set<() => void>();

	private _sessionListeners = new Set<() => void>();
	private _contentListeners = new Set<() => void>();
	private _statusListeners = new Set<() => void>();

	get state(): AgentState { return this._state; }
	get sessionId(): string { return this._sessionId; }
	get sessionFile(): string | undefined { return this._sessionPath; }
	get sessionName(): string | undefined { return this._sessionName; }
	get sessionStatus(): SessionStatus { return this._sessionStatus; }
	get isReallyStreaming(): boolean { return this._isReallyStreaming; }
	get steeringQueue(): readonly string[] {
		if (!this._sessionPath) return [];
		return this._steeringQueues.get(this._sessionPath) ?? [];
	}

	/** Get the global status of a session by path. Returns "running", "done", or undefined (idle). */
	getSessionStatus(sessionPath: string): "running" | "done" | undefined {
		return this._globalSessionStatus.get(sessionPath);
	}

	onGlobalStatusChange(fn: () => void): () => void {
		this._globalStatusListeners.add(fn);
		return () => this._globalStatusListeners.delete(fn);
	}
	private emitGlobalStatusChange() {
		for (const fn of this._globalStatusListeners) fn();
	}

	private setGlobalSessionStatus(sessionPath: string, status: "running" | "done") {
		this._globalSessionStatus.set(sessionPath, status);
		this.emitGlobalStatusChange();
	}

	/** Bulk-set session statuses from server (used on init and reconnect). */
	private setAllSessionStatuses(statuses: Record<string, "running" | "done">) {
		this._globalSessionStatus.clear();
		for (const [path, status] of Object.entries(statuses)) {
			this._globalSessionStatus.set(path, status);
		}
		this.emitGlobalStatusChange();
	}

	// ── Event subscriptions ────────────────────────────────────────────────

	onSteeringQueueChange(fn: () => void): () => void {
		this._steeringQueueListeners.add(fn);
		return () => this._steeringQueueListeners.delete(fn);
	}
	private emitSteeringQueueChange() {
		for (const fn of this._steeringQueueListeners) fn();
	}

	/**
	 * Optimistically enqueue a steering message for a session.
	 * The server remains authoritative and can overwrite via steering_queue_update.
	 */
	private enqueueSteering(sessionPath: string, message: string) {
		const queue = this._steeringQueues.get(sessionPath) ?? [];
		this._steeringQueues.set(sessionPath, [...queue, message]);
		this.emitSteeringQueueChange();
	}

	onSessionChange(fn: () => void): () => void {
		this._sessionListeners.add(fn);
		return () => this._sessionListeners.delete(fn);
	}
	private emitSessionChange() {
		for (const fn of this._sessionListeners) fn();
	}

	onContentChange(fn: () => void): () => void {
		this._contentListeners.add(fn);
		return () => this._contentListeners.delete(fn);
	}
	private emitContentChange() {
		for (const fn of this._contentListeners) fn();
	}

	onStatusChange(fn: () => void): () => void {
		this._statusListeners.add(fn);
		return () => this._statusListeners.delete(fn);
	}
	private emitStatusChange() {
		for (const fn of this._statusListeners) fn();
	}

	onSessionsChanged(fn: (file: string) => void): () => void {
		this.sessionsChangedListeners.add(fn);
		return () => this.sessionsChangedListeners.delete(fn);
	}

	onPiInstallRequired(fn: (info: PiInstallRequiredInfo) => void): () => void {
		this.piInstallRequiredListeners.add(fn);
		return () => this.piInstallRequiredListeners.delete(fn);
	}

	private emitPiInstallRequired(info: PiInstallRequiredInfo) {
		for (const fn of this.piInstallRequiredListeners) fn(info);
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	private emit(e: AgentEvent) {
		for (const fn of this.listeners) fn(e);
	}

	// ── Connection ─────────────────────────────────────────────────────────

	async connect(url: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.ws = new WebSocket(url);

			this.ws.onopen = () => {
				// Start in virtual state (no session loaded yet)
				this._sessionStatus = "virtual";
				resolve();
			};

			this.ws.onerror = () => reject(new Error("WebSocket error"));
			this.ws.onclose = () => { this.ws = null; };
			this.ws.onmessage = (ev) => this.handleMessage(ev.data);
		});

		// When the tab regains focus, sync state in case events were missed
		// or updates didn't render while backgrounded.
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				this.syncStateOnFocus();
			}
		});
	}

	/**
	 * Called when the tab regains visibility. Syncs session statuses from the
	 * server (in case we missed WS messages while backgrounded) and fixes up
	 * stale streaming state.
	 */
	private async syncStateOnFocus() {
		// Always refresh session statuses from server
		this.refreshSessionStatuses();

		if (this._sessionStatus === "detached" && this._state.isStreaming) {
			console.log("[ws-adapter] Tab regained focus: clearing stale streaming state");
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set();
			this._resolveRunning?.();
			this._runningPromise = undefined;
			this._resolveRunning = undefined;
			this.emitStatusChange();
			this.fetchMessagesFromDisk();
		}
	}

	/** Fetch current session statuses from the server. */
	private async refreshSessionStatuses() {
		try {
			const data = await this.send({ type: "get_session_statuses" });
			if (data?.statuses) {
				this.setAllSessionStatuses(data.statuses);
			}
		} catch (err) {
			console.error("Failed to refresh session statuses:", err);
		}
	}

	private handleMessage(raw: string) {
		let data: any;
		try { data = JSON.parse(raw); } catch { return; }

		// Response to a pending request
		if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			if (data.success) {
				pending.resolve(data.data);
			} else {
				pending.reject(new Error(data.error || "Unknown error"));
			}
			return;
		}

		if (data.type === "pi_install_required") {
			this.emitPiInstallRequired({
				command: data.command || "pi",
				installable: !!data.installable,
				installing: !!data.installing,
				message: data.message || "pi is not available",
			});
			return;
		}

		// Init message with session statuses from server
		if (data.type === "init") {
			if (data.sessionStatuses) {
				this.setAllSessionStatuses(data.sessionStatuses);
			}
			// Restore steering queues from server
			if (data.steeringQueues) {
				this._steeringQueues.clear();
				for (const [sp, q] of Object.entries(data.steeringQueues as Record<string, string[]>)) {
					if (q.length > 0) this._steeringQueues.set(sp, [...q]);
				}
				this.emitSteeringQueueChange();
			}
			return;
		}

		// Server-authoritative steering queue update
		if (data.type === "steering_queue_update") {
			const sp = data.sessionPath as string;
			if (sp) {
				if (data.queue && data.queue.length > 0) {
					this._steeringQueues.set(sp, [...data.queue]);
				} else {
					this._steeringQueues.delete(sp);
				}
				this.emitSteeringQueueChange();
			}
			return;
		}

		// Session attached/detached notifications — track globally for ALL sessions
		if (data.type === "session_attached") {
			if (data.sessionPath) {
				this.setGlobalSessionStatus(data.sessionPath, "running");

				// Create an optimistic session entry so the sidebar shows it instantly
				// instead of waiting for the filesystem scan (~2s).
				if (!this._optimisticSessions.has(data.sessionPath)) {
					const now = new Date().toISOString();
					const filename = path.basename(data.sessionPath, ".jsonl");
					const parts = filename.split("_");
					const id = parts.length > 1 ? parts.slice(1).join("_") : filename;
					this._optimisticSessions.set(data.sessionPath, {
						id,
						path: data.sessionPath,
						cwd: data.cwd || "",
						created: now,
						modified: now,
						lastUserPromptTime: now,
						messageCount: 1,
						firstMessage: data.firstMessage || "(new session)",
					});
					// Immediately notify sidebar to refresh
					for (const fn of this.sessionsChangedListeners) fn(data.sessionPath);
				}
			}
			if (data.sessionPath === this._sessionPath || this._sessionStatus === "virtual") {
				// For virtual sessions, adopt the server-assigned path
				if (this._sessionStatus === "virtual" && data.sessionPath) {
					this._sessionPath = data.sessionPath;
					const filename = path.basename(data.sessionPath, ".jsonl");
					const parts = filename.split("_");
					this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
				}
				this._sessionStatus = "attached";
				// Ensure isStreaming is true so the stop button is visible
				this._state.isStreaming = true;
				this._isReallyStreaming = true;
				this.emitStatusChange();
			}
			return;
		}

		if (data.type === "session_detached") {
			if (data.sessionPath) {
				this.setGlobalSessionStatus(data.sessionPath, "done");
			}
			if (data.sessionPath === this._sessionPath) {
				this._sessionStatus = "detached";
				// Definitively clear streaming state — the turn is over.
				// This is the authoritative signal, even if agent_end was missed
				// (e.g. tab was backgrounded, events filtered, or race condition).
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();
				this._resolveRunning?.();
				this._runningPromise = undefined;
				this._resolveRunning = undefined;
				this.emitStatusChange();
				// Re-fetch messages from JSONL to get final state
				this.fetchMessagesFromDisk();
			}
			return;
		}

		// Sessions directory change notification
		if (data.type === "sessions_changed") {
			const file = data.file as string;
			// If the changed file is the current session and we're detached, refresh
			if (this._sessionPath && file === this._sessionPath && this._sessionStatus === "detached") {
				this.fetchMessagesFromDisk();
			}
			// Notify sidebar
			for (const fn of this.sessionsChangedListeners) fn(file);
			return;
		}

		// Agent event — only process if it's for our current session
		if (data.sessionPath && data.sessionPath !== this._sessionPath) return;

		const event = data as AgentEvent;

		// Buffer streaming events while a disk fetch is in-flight to prevent
		// the race between JSONL loading and live WebSocket events which causes
		// duplicate messages. Events are replayed (with dedup) after the fetch.
		if (this._fetchingDisk) {
			this._diskFetchBuffer.push(event);
			return;
		}

		this.updateState(event);
		this.emit(event);
	}

	/**
	 * Check if a message is already present in the messages array.
	 * This prevents duplicates when switching to a running session (messages
	 * loaded from disk overlap with streaming events).
	 *
	 * For assistant messages: compares tool_use block IDs.
	 * For tool result messages: compares tool_use_id.
	 * Fallback: compares role + timestamp.
	 */
	private isMessageAlreadyPresent(msg: AgentMessage): boolean {
		const messages = this._state.messages;
		// Only check the last few messages for performance
		const start = Math.max(0, messages.length - 10);
		for (let i = start; i < messages.length; i++) {
			const existing = messages[i];
			if (existing.role !== msg.role) continue;

			// Compare tool_use IDs for assistant messages
			if (msg.role === "assistant" && Array.isArray(msg.content) && Array.isArray(existing.content)) {
				const msgToolIds = msg.content.filter((c: any) => c.type === "tool_use").map((c: any) => c.id);
				const existToolIds = existing.content.filter((c: any) => c.type === "tool_use").map((c: any) => c.id);
				if (msgToolIds.length > 0 && existToolIds.length > 0 && msgToolIds[0] === existToolIds[0]) {
					return true;
				}
			}

			// Compare tool_use_id for tool result messages
			if (msg.role === "tool" && (msg as any).tool_use_id && (msg as any).tool_use_id === (existing as any).tool_use_id) {
				return true;
			}

			// Fallback: compare timestamps (if both have them)
			if (msg.timestamp && existing.timestamp && msg.timestamp === existing.timestamp) {
				return true;
			}
		}
		return false;
	}

	private updateState(event: AgentEvent) {
		switch (event.type) {
			case "agent_start":
				this._isReallyStreaming = true;
				this._state.isStreaming = true;
				this._state.error = undefined;
				this._state.streamMessage = null;
				this._runningPromise = new Promise((resolve) => {
					this._resolveRunning = resolve;
				});
				this.emitStatusChange();
				break;

			case "agent_end":
				this._isReallyStreaming = false;
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();
				// Steering queue clearing is now handled server-side via steering_queue_update events
				this._resolveRunning?.();
				this._runningPromise = undefined;
				this._resolveRunning = undefined;
				this.emitStatusChange();
				break;

			case "message_start":
				this._state.streamMessage = event.message;
				break;

			case "message_update":
				this._state.streamMessage = event.message;
				break;

			case "message_end":
				this._state.streamMessage = null;
				if (!this.isMessageAlreadyPresent(event.message)) {
					this._state.messages = [...this._state.messages, event.message];
				}
				// Steering queue dequeuing is now handled server-side via steering_queue_update events
				break;

			case "turn_end":
				if (event.message.role === "assistant" && (event.message as any).errorMessage) {
					this._state.error = (event.message as any).errorMessage;
				}
				if (event.toolResults) {
					for (const tr of event.toolResults) {
						if (!this.isMessageAlreadyPresent(tr)) {
							this._state.messages = [...this._state.messages, tr];
						}
					}
				}
				break;

			case "tool_execution_start": {
				const s = new Set(this._state.pendingToolCalls);
				s.add(event.toolCallId);
				this._state.pendingToolCalls = s;
				break;
			}

			case "tool_execution_end": {
				const s = new Set(this._state.pendingToolCalls);
				s.delete(event.toolCallId);
				this._state.pendingToolCalls = s;
				break;
			}
		}
	}

	private send(command: WsCommand | any): Promise<any> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket not connected"));
		}

		const id = `req_${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (data) => { clearTimeout(timeout); resolve(data); },
				reject: (err) => { clearTimeout(timeout); reject(err); },
			});

			this.ws!.send(JSON.stringify({ ...command, id }));
		});
	}

	// ── Models ─────────────────────────────────────────────────────────────

	/** Fetch available models from the server (uses any idle pi process) */
	async fetchAvailableModels(): Promise<any[]> {
		const data = await this.send({ type: "get_available_models" });
		return data?.models ?? [];
	}

	async installPi(): Promise<void> {
		await this.send({ type: "install_pi" });
	}

	/** Load the default model from the pi process (respects user's settings) */
	async loadDefaultModel(): Promise<void> {
		if (this._state.model) return;
		const data = await this.send({ type: "get_default_model" });
		if (data?.model) {
			this._state.model = data.model;
		}
		if (data?.thinkingLevel) {
			this._state.thinkingLevel = data.thinkingLevel;
		}
	}

	// ── Fetch messages from JSONL (REST) ───────────────────────────────────

	async fetchMessagesFromDisk(options?: { restoreContext?: boolean }): Promise<void> {
		if (!this._sessionPath) return;
		const restoreContext = options?.restoreContext === true;

		this._fetchingDisk = true;
		this._diskFetchBuffer = [];

		try {
			const res = await fetch(`/api/sessions/messages?path=${encodeURIComponent(this._sessionPath)}`);
			if (!res.ok) return;

			const data = await res.json();
			this._state.messages = data.messages ?? [];

			// Restore model/thinking level from session context only when explicitly requested
			// (e.g. when switching sessions). Background refreshes should not clobber
			// a user-selected model/thinking level in the current UI state.
			if (restoreContext) {
				if (data.model) {
					// Find the matching model from available models
					const models = await this.fetchAvailableModels();
					const match = models.find(
						(m: any) => m.provider === data.model.provider && m.id === data.model.modelId,
					);
					if (match) {
						this._state.model = match;
					}
				}
				if (data.thinkingLevel) {
					this._state.thinkingLevel = data.thinkingLevel;
				}
			}

			// Replay any streaming events that arrived while the fetch was in-flight.
			// The JSONL is now the authoritative base; updateState's dedup will skip
			// messages already present from the JSONL.
			const buffered = this._diskFetchBuffer;
			this._diskFetchBuffer = [];
			this._fetchingDisk = false;

			for (const event of buffered) {
				this.updateState(event);
				this.emit(event);
			}

			this.emitContentChange();
		} catch (err) {
			console.error("Failed to fetch session messages:", err);
		} finally {
			this._fetchingDisk = false;
			this._diskFetchBuffer = [];
		}
	}

	// ── Agent interface methods ────────────────────────────────────────────

	/** CWD for the next new session (set when user picks a folder) */
	private _pendingCwd: string | undefined;

	/** Set the CWD for the next virtual session */
	setCwd(cwd: string) {
		this._pendingCwd = cwd;
	}

	get cwd(): string | undefined {
		return this._pendingCwd;
	}

	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
		let text: string;
		if (typeof input === "string") {
			text = input;
		} else if (Array.isArray(input)) {
			text = input.map((m) => this.extractText(m)).join("\n");
		} else {
			text = this.extractText(input);
		}

		// Handle client-side slash commands
		const handled = await this.handleSlashCommand(text);
		if (handled) return;

		// If the *current* session's agent is running, route as a steering message.
		// We check the global session status map (server-authoritative) rather than
		// the local _isReallyStreaming flag, because _isReallyStreaming tracks the
		// adapter's last-viewed session and isn't cleared on switchSession.
		// This prevents prompts for OTHER conversations from being queued as steers
		// just because some unrelated conversation happens to be running.
		const targetIsRunning = this._sessionPath
			? this._globalSessionStatus.get(this._sessionPath) === "running"
			: false;
		if (targetIsRunning && this._sessionPath) {
			// Optimistically reflect queued steering in the UI immediately.
			this.enqueueSteering(this._sessionPath, text);
			await this.send({
				type: "steer",
				sessionPath: this._sessionPath,
				message: text,
			});
			return;
		}

		const modelPayload = this._state.model ? { provider: this._state.model.provider, modelId: this._state.model.id } : undefined;

		if (this._sessionStatus === "virtual") {
			await this.send({
				type: "prompt",
				sessionPath: "__new__",
				cwd: this._pendingCwd,
				message: text,
				model: modelPayload,
				thinkingLevel: this._state.thinkingLevel,
				images,
			});
			this._pendingCwd = undefined;
			return;
		}

		if (!this._sessionPath) throw new Error("No session loaded");

		await this.send({
			type: "prompt",
			sessionPath: this._sessionPath,
			message: text,
			model: modelPayload,
			thinkingLevel: this._state.thinkingLevel,
			images,
		});
	}

	private extractText(msg: AgentMessage): string {
		if ("content" in msg) {
			if (typeof msg.content === "string") return msg.content;
			if (Array.isArray(msg.content)) {
				return msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			}
		}
		return "";
	}

	private showHelpMessage() {
		const helpText = [
			"**Available commands:**",
			"",
			"| Command | Description |",
			"|---------|-------------|",
			"| `/help` | Show this help |",
			"| `/new` | Start a new session |",
			"| `/fork` | Fork session from a previous message |",
			"| `/compact [instructions]` | Compact conversation history |",
			"",
			"**Keyboard shortcuts:**",
			"",
			"| Shortcut | Action |",
			"|----------|--------|",
			"| `Enter` | Send message (also works during streaming to steer) |",
			"| `Cmd+Enter` | Fork session and send message in the fork |",
			"| `Shift+Enter` | New line |",
			"| `Escape` | Abort current turn |",
		].join("\n");

		const helpMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: helpText }],
		} as AgentMessage;
		this._state.messages = [...this._state.messages, helpMessage];
		this.emitContentChange();
	}

	private async handleSlashCommand(text: string): Promise<boolean> {
		const trimmed = text.trim();
		if (!trimmed.startsWith("/")) return false;

		if (trimmed === "/help") {
			this.showHelpMessage();
			return true;
		}

		if (trimmed === "/new") {
			await this.newSession();
			return true;
		}

		if (trimmed === "/fork") {
			// Handled by the UI layer (main.ts) — emit a custom event
			window.dispatchEvent(new CustomEvent("pi-fork-request"));
			return true;
		}

		if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
			if (!this._sessionPath) return true;
			const customInstructions = trimmed.startsWith("/compact ") ? trimmed.slice(9).trim() : undefined;
			await this.send({ type: "compact", sessionPath: this._sessionPath, customInstructions });
			await this.fetchMessagesFromDisk();
			return true;
		}

		return false;
	}

	abort() {
		if (this._sessionPath) {
			this.send({ type: "abort", sessionPath: this._sessionPath }).catch(() => {});
		}
	}

	steer(m: AgentMessage) {
		const text = this.extractText(m);
		if (!text || !this._sessionPath) return;
		// Only steer if the current session is actually running (not some other session)
		const isRunning = this._globalSessionStatus.get(this._sessionPath) === "running";
		if (!isRunning) return;
		this.enqueueSteering(this._sessionPath, text);
		this.send({ type: "steer", sessionPath: this._sessionPath, message: text }).catch(console.error);
	}

	removeSteering(index: number) {
		if (!this._sessionPath) return;
		this.send({ type: "remove_steering", sessionPath: this._sessionPath, index }).catch(console.error);
	}

	followUp(_m: AgentMessage) {
		// TODO: implement follow-up for attached sessions
	}

	waitForIdle(): Promise<void> {
		return this._runningPromise ?? Promise.resolve();
	}

	setModel(m: Model<any>) {
		// Client-side only until a prompt is sent
		this._state.model = m;
		// Notify UI immediately so the selected model label updates.
		this.emitContentChange();
	}

	setThinkingLevel(l: ThinkingLevel) {
		// Client-side only until a prompt is sent
		this._state.thinkingLevel = l;
		// Notify UI immediately so the selector reflects the change.
		this.emitContentChange();
	}

	setSystemPrompt(v: string) { this._state.systemPrompt = v; }
	setTools(t: AgentTool<any>[]) { this._state.tools = t; }
	replaceMessages(ms: AgentMessage[]) { this._state.messages = ms.slice(); }
	appendMessage(m: AgentMessage) { this._state.messages = [...this._state.messages, m]; }
	clearMessages() { this._state.messages = []; }
	clearSteeringQueue() {
		if (this._sessionPath) this._steeringQueues.delete(this._sessionPath);
		this.emitSteeringQueueChange();
	}
	clearFollowUpQueue() {}
	clearAllQueues() {
		if (this._sessionPath) this._steeringQueues.delete(this._sessionPath);
		this.emitSteeringQueueChange();
	}
	hasQueuedMessages(): boolean { return this.steeringQueue.length > 0; }
	setSteeringMode(_mode: "all" | "one-at-a-time") {}
	getSteeringMode(): "all" | "one-at-a-time" { return "one-at-a-time"; }
	setFollowUpMode(_mode: "all" | "one-at-a-time") {}
	getFollowUpMode(): "all" | "one-at-a-time" { return "one-at-a-time"; }

	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._isReallyStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;
		this._steeringQueues.clear();
		this.emitSteeringQueueChange();
	}

	// ── Fork ───────────────────────────────────────────────────────────────

	/** Get user messages from the current session for the fork selector. */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		if (!this._sessionPath) return [];
		const res = await fetch(`/api/sessions/fork-messages?path=${encodeURIComponent(this._sessionPath)}`);
		if (!res.ok) throw new Error(`Failed to get fork messages: ${res.statusText}`);
		const data = await res.json();
		return data.messages ?? [];
	}

	/** Fork the current session from a specific entry. Returns the new session path. */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean; newSessionPath: string | null }> {
		if (!this._sessionPath) throw new Error("No session loaded");
		const data = await this.send({
			type: "fork",
			sessionPath: this._sessionPath,
			entryId,
		});
		return {
			text: data?.text ?? "",
			cancelled: data?.cancelled ?? false,
			newSessionPath: data?.newSessionPath ?? null,
		};
	}

	// ── Fork and prompt ────────────────────────────────────────────────────

	/**
	 * Fork the entire current session state into a new session and run a prompt there.
	 * Used for Cmd+Enter: creates a branch of the conversation with the new input.
	 */
	async forkAndPrompt(text: string, images?: ImageContent[]): Promise<void> {
		if (!this._sessionPath || this._sessionStatus === "virtual") {
			// No session to fork — just do a regular prompt
			await this.prompt(text, images);
			return;
		}

		const modelPayload = this._state.model ? { provider: this._state.model.provider, modelId: this._state.model.id } : undefined;

		const data = await this.send({
			type: "fork_prompt",
			sessionPath: this._sessionPath,
			message: text,
			model: modelPayload,
			thinkingLevel: this._state.thinkingLevel,
			images,
		});

		// Switch to the new forked session
		if (data?.newSessionPath) {
			this._sessionPath = data.newSessionPath;
			const filename = path.basename(data.newSessionPath, ".jsonl");
			const parts = filename.split("_");
			this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
			// The session_attached event from the server will set status to "attached"
			this.emitSessionChange();
		}
	}

	// ── Session management ─────────────────────────────────────────────────

	async listSessions(): Promise<SessionInfoDTO[]> {
		const res = await fetch("/api/sessions");
		if (!res.ok) throw new Error(`Failed to list sessions: ${res.statusText}`);
		const sessions: SessionInfoDTO[] = await res.json();

		// Merge optimistic sessions: add any that aren't yet in the real list
		const realPaths = new Set(sessions.map((s) => s.path));
		for (const [optPath, optSession] of this._optimisticSessions) {
			if (realPaths.has(optPath)) {
				// Real session caught up — remove the optimistic entry
				this._optimisticSessions.delete(optPath);
			} else {
				// Still not on disk — include the optimistic entry
				sessions.push(optSession);
			}
		}

		return sessions;
	}

	/** Get current optimistic sessions (sessions known before the JSONL scan catches up). */
	get optimisticSessions(): SessionInfoDTO[] {
		return Array.from(this._optimisticSessions.values());
	}

	async deleteSession(sessionPath: string): Promise<void> {
		const res = await fetch("/api/sessions", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: sessionPath }),
		});
		if (!res.ok) throw new Error(`Failed to delete session: ${res.statusText}`);
	}

	/** Switch to an existing session (load messages from JSONL) */
	async switchSession(sessionPath: string): Promise<void> {
		this._sessionPath = sessionPath;
		// Extract session ID from filename
		const filename = path.basename(sessionPath, ".jsonl");
		const parts = filename.split("_");
		this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
		this._sessionStatus = "detached";

		// Clear current state — including isStreaming since a detached session is never streaming
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;

		// Load messages from JSONL and restore persisted model/thinking context
		await this.fetchMessagesFromDisk({ restoreContext: true });

		// If the session is currently running on the server, restore streaming state
		// so the stop button is visible, and mark as "attached" to prevent file-watcher
		// re-fetches from racing with streaming events.
		if (this._globalSessionStatus.get(sessionPath) === "running") {
			this._sessionStatus = "attached";
			this._state.isStreaming = true;
			this._isReallyStreaming = true;
		}

		this.emitSessionChange();
		this.emitStatusChange();
	}

	/** Create a new virtual session (no JSONL file until first message) */
	async newSession(cwd?: string): Promise<void> {
		this._sessionId = crypto.randomUUID();
		this._sessionPath = undefined;
		this._sessionName = undefined;
		this._sessionStatus = "virtual";
		this._pendingCwd = cwd;

		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;

		this.emitSessionChange();
		this.emitStatusChange();
	}
}

// path utilities for browser
const path = {
	basename(p: string, ext?: string): string {
		const base = p.split("/").pop() || p;
		if (ext && base.endsWith(ext)) return base.slice(0, -ext.length);
		return base;
	},
};

export interface SessionInfoDTO {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	/** ISO timestamp of the most recent user input prompt, if any. */
	lastUserPromptTime?: string;
	messageCount: number;
	firstMessage: string;
}

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
	| { type: "set_session_name"; sessionPath: string; name: string };

export class WsAgentAdapter {
	private ws: WebSocket | null = null;
	private listeners = new Set<(e: AgentEvent) => void>();
	private sessionsChangedListeners = new Set<(file: string) => void>();
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

	// ── Steering queue ─────────────────────────────────────────────────────
	private _steeringQueue: string[] = [];
	private _steeringQueueListeners = new Set<() => void>();
	/** Whether the agent is actually running a turn (separate from state.isStreaming which we keep false for the editor) */
	private _isReallyStreaming = false;

	// ── Session state ──────────────────────────────────────────────────────
	private _sessionId: string = "";
	private _sessionPath: string | undefined;
	private _sessionName: string | undefined;
	private _sessionStatus: SessionStatus = "virtual";

	/** Tracks status of ALL sessions: "running" while attached, "done" briefly after detach */
	private _globalSessionStatus = new Map<string, "running" | "done">();
	private _globalStatusListeners = new Set<() => void>();
	private _doneTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private _sessionListeners = new Set<() => void>();
	private _contentListeners = new Set<() => void>();
	private _statusListeners = new Set<() => void>();

	get state(): AgentState { return this._state; }
	get sessionId(): string { return this._sessionId; }
	get sessionFile(): string | undefined { return this._sessionPath; }
	get sessionName(): string | undefined { return this._sessionName; }
	get sessionStatus(): SessionStatus { return this._sessionStatus; }
	get isReallyStreaming(): boolean { return this._isReallyStreaming; }
	get steeringQueue(): readonly string[] { return this._steeringQueue; }

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

	private setGlobalSessionStatus(sessionPath: string, status: "running" | "done" | null) {
		// Clear any existing done timer
		const existingTimer = this._doneTimers.get(sessionPath);
		if (existingTimer) {
			clearTimeout(existingTimer);
			this._doneTimers.delete(sessionPath);
		}

		if (status === null) {
			this._globalSessionStatus.delete(sessionPath);
		} else {
			this._globalSessionStatus.set(sessionPath, status);
		}

		if (status === "done") {
			// Auto-clear "done" after 10 seconds
			const timer = setTimeout(() => {
				this._doneTimers.delete(sessionPath);
				this._globalSessionStatus.delete(sessionPath);
				this.emitGlobalStatusChange();
			}, 10000);
			this._doneTimers.set(sessionPath, timer);
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
	 * Called when the tab regains visibility. If the session is detached but
	 * isStreaming is still true, it means we missed or didn't process agent_end
	 * properly while backgrounded. Fix it up and re-fetch messages.
	 */
	private syncStateOnFocus() {
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

		// Init message with attached sessions
		if (data.type === "init") {
			// Mark all initially attached sessions as running
			if (Array.isArray(data.attachedSessions)) {
				for (const sp of data.attachedSessions) {
					this.setGlobalSessionStatus(sp, "running");
				}
			}
			return;
		}

		// Session attached/detached notifications — track globally for ALL sessions
		if (data.type === "session_attached") {
			if (data.sessionPath) {
				this.setGlobalSessionStatus(data.sessionPath, "running");
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

		// Auto-title notification — update session name and trigger sidebar refresh
		if (data.type === "session_auto_titled") {
			if (data.sessionPath === this._sessionPath) {
				this._sessionName = data.title;
			}
			// Trigger sidebar refresh
			for (const fn of this.sessionsChangedListeners) fn(data.sessionPath);
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
		this.updateState(event);
		this.emit(event);
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
				this._steeringQueue = [];
				this.emitSteeringQueueChange();
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
				this._state.messages = [...this._state.messages, event.message];
				// When a user message appears during streaming, it was a steering message being delivered
				if (event.message.role === "user" && this._steeringQueue.length > 0) {
					const text = typeof event.message.content === "string"
						? event.message.content
						: event.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
					const idx = this._steeringQueue.indexOf(text);
					if (idx !== -1) {
						this._steeringQueue.splice(idx, 1);
						this.emitSteeringQueueChange();
					}
				}
				break;

			case "turn_end":
				if (event.message.role === "assistant" && (event.message as any).errorMessage) {
					this._state.error = (event.message as any).errorMessage;
				}
				if (event.toolResults) {
					for (const tr of event.toolResults) {
						this._state.messages = [...this._state.messages, tr];
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

	async fetchMessagesFromDisk(): Promise<void> {
		if (!this._sessionPath) return;

		try {
			const res = await fetch(`/api/sessions/messages?path=${encodeURIComponent(this._sessionPath)}`);
			if (!res.ok) return;

			const data = await res.json();
			this._state.messages = data.messages ?? [];

			// Restore model/thinking level from session context
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

			this.emitContentChange();
		} catch (err) {
			console.error("Failed to fetch session messages:", err);
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

		// If agent is currently running, route as a steering message
		if (this._isReallyStreaming && this._sessionPath) {
			this._steeringQueue.push(text);
			this.emitSteeringQueueChange();
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

	private async handleSlashCommand(text: string): Promise<boolean> {
		const trimmed = text.trim();
		if (!trimmed.startsWith("/")) return false;

		if (trimmed === "/new") {
			await this.newSession();
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
		if (!text || !this._isReallyStreaming || !this._sessionPath) return;
		this._steeringQueue.push(text);
		this.emitSteeringQueueChange();
		this.send({ type: "steer", sessionPath: this._sessionPath, message: text }).catch(console.error);
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
	}

	setThinkingLevel(l: ThinkingLevel) {
		// Client-side only until a prompt is sent
		this._state.thinkingLevel = l;
	}

	setSystemPrompt(v: string) { this._state.systemPrompt = v; }
	setTools(t: AgentTool<any>[]) { this._state.tools = t; }
	replaceMessages(ms: AgentMessage[]) { this._state.messages = ms.slice(); }
	appendMessage(m: AgentMessage) { this._state.messages = [...this._state.messages, m]; }
	clearMessages() { this._state.messages = []; }
	clearSteeringQueue() { this._steeringQueue = []; this.emitSteeringQueueChange(); }
	clearFollowUpQueue() {}
	clearAllQueues() { this._steeringQueue = []; this.emitSteeringQueueChange(); }
	hasQueuedMessages(): boolean { return this._steeringQueue.length > 0; }
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
		this._steeringQueue = [];
		this.emitSteeringQueueChange();
	}

	// ── Session management ─────────────────────────────────────────────────

	async listSessions(): Promise<SessionInfoDTO[]> {
		const res = await fetch("/api/sessions");
		if (!res.ok) throw new Error(`Failed to list sessions: ${res.statusText}`);
		return res.json();
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

		// Load messages from JSONL
		await this.fetchMessagesFromDisk();

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
	messageCount: number;
	firstMessage: string;
}

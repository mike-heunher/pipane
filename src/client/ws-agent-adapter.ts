/**
 * WebSocket-backed Agent adapter.
 *
 * Architecture: the server is the single source of truth for ALL state.
 * The server maintains a flat messages array that includes everything:
 * committed messages, the in-flight stream message, and partial tool results.
 *
 * State arrives via `session_sync` (full snapshot or SHA-256-verified delta).
 * The client just renders the messages array. No splitting, no fixups.
 *
 * The only client-side state is model/thinkingLevel selection (until sent
 * with the next prompt) and UI concerns like the steering queue.
 */

import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getLoadTraceId, traceSpanStart, tracedFetch } from "./load-trace.js";
import { applySyncOp, type SyncOp } from "../shared/jsonl-sync.js";

export type SessionStatus = "virtual" | "detached" | "attached";

type WsCommand =
	| { type: "prompt"; sessionPath: string; message: string; model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel; images?: ImageContent[] }
	| { type: "steer"; sessionPath: string; message: string }
	| { type: "abort"; sessionPath: string }
	| { type: "compact"; sessionPath: string; customInstructions?: string }
	| { type: "get_available_models" }
	| { type: "get_commands" }
	| { type: "reload_processes" }
	| { type: "set_session_name"; sessionPath: string; name: string }
	| { type: "fork"; sessionPath: string; entryId: string }
	| { type: "subscribe_session"; sessionPath: string }
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
	private pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; endSpan?: () => void }>();
	private requestId = 0;
	private _runningPromise: Promise<void> | undefined;
	private _resolveRunning: (() => void) | undefined;

	// ── Auto-reconnect state ───────────────────────────────────────────────
	private _wsUrl: string | undefined;
	private _reconnecting = false;
	private _reconnectAttempt = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _connectionListeners = new Set<(connected: boolean) => void>();

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

	/**
	 * Pending tool call IDs — kept as a simple set for query by tool renderers.
	 * Populated from the server's session_sync state.
	 */
	private _pendingToolCallIds = new Set<string>();

	// ── Steering queue (per-session) ───────────────────────────────────────
	/** Per-session steering queues keyed by session path. */
	private _steeringQueues = new Map<string, string[]>();
	private _steeringQueueListeners = new Set<() => void>();
	/**
	 * When true, the next session_messages push will restore model/thinkingLevel
	 * from the server. Set on switchSession(); cleared after the first push.
	 * Outside of session switches, model/thinkingLevel are client-local.
	 */
	private _restoreModelFromServer = false;
	/**
	 * One-shot override selected in the UI, applies only to the next prompt
	 * in the currently active conversation. Cleared immediately after sending.
	 */
	private _nextPromptModelOverride: Model<any> | undefined;

	/** Cached available models for model matching */
	private _availableModels: any[] | null = null;

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

	/**
	 * Monotonically increasing nonce, bumped on every session change.
	 * Used to detect stale async responses from prompt/fork commands
	 * that resolve after the user navigated to a different session.
	 */
	private _sessionNonce = 0;

	/**
	 * True while a `__new__` prompt is in flight (between sending the prompt
	 * and receiving the response). Used by the `session_attached` handler to
	 * distinguish a valid virtual→attached transition from a stale message.
	 */
	private _pendingNewPrompt = false;

	/** Current synced JSON string from server */
	private _syncJson = "";
	/** Current synced hash */
	private _syncHash = "";

	// ── session_sync coalescing (latest-wins per frame) ───────────────────
	/** Latest session_sync payload waiting to be applied. */
	private _pendingSessionSync: any | null = null;
	/** True when a frame callback has been scheduled to flush session_sync. */
	private _sessionSyncFlushScheduled = false;
	/** True while applySessionSync is running to prevent concurrent flushes. */
	private _sessionSyncFlushInProgress = false;

	private _sessionListeners = new Set<() => void>();
	private _contentListeners = new Set<() => void>();
	private _statusListeners = new Set<() => void>();

	get state(): AgentState { return this._state; }
	get sessionId(): string { return this._sessionId; }
	get sessionFile(): string | undefined { return this._sessionPath; }
	get sessionName(): string | undefined { return this._sessionName; }
	get sessionStatus(): SessionStatus { return this._sessionStatus; }
	get isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
	get isReconnecting(): boolean { return this._reconnecting; }

	onConnectionChange(fn: (connected: boolean) => void): () => void {
		this._connectionListeners.add(fn);
		return () => this._connectionListeners.delete(fn);
	}
	private emitConnectionChange(connected: boolean) {
		for (const fn of this._connectionListeners) fn(connected);
	}

	/** Get pending tool call IDs */
	get pendingToolCallIds(): ReadonlySet<string> {
		return this._pendingToolCallIds;
	}

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
		this._wsUrl = url;
		await this.connectWs(url, false);

		// When the tab regains focus, sync state in case events were missed
		// or updates didn't render while backgrounded.
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				this.syncStateOnFocus();
			}
		});
	}

	/**
	 * Internal WebSocket connect. On initial connect, rejects on error.
	 * On reconnect, resolves silently (caller handles retry).
	 */
	private connectWs(url: string, isReconnect: boolean): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(url);

			ws.onopen = () => {
				this.ws = ws;
				this._reconnecting = false;
				this._reconnectAttempt = 0;
				if (!isReconnect) {
					this._sessionStatus = "virtual";
				}
				console.log(`[ws-adapter] WebSocket ${isReconnect ? "re" : ""}connected`);
				this.emitConnectionChange(true);

				if (isReconnect) {
					// Re-sync state after reconnect
					this.onReconnected();
				}
				resolve();
			};

			ws.onerror = () => {
				if (!isReconnect) reject(new Error("WebSocket error"));
				// On reconnect, onerror is followed by onclose which handles retry
			};

			ws.onclose = () => {
				const wasConnected = this.ws === ws;
				if (this.ws === ws) {
					this.ws = null;
				}

				// Reject all pending requests — they'll never get a response
				for (const [id, pending] of this.pendingRequests) {
					pending.endSpan?.();
					pending.reject(new Error("WebSocket disconnected"));
				}
				this.pendingRequests.clear();

				if (wasConnected) {
					console.log("[ws-adapter] WebSocket disconnected, will reconnect...");
					this.emitConnectionChange(false);
				}

				// Schedule reconnect (both for initial connect failure during
				// reconnect attempts and for unexpected disconnects)
				if (isReconnect || wasConnected) {
					this.scheduleReconnect();
				}
			};

			ws.onmessage = (ev) => this.handleMessage(ev.data);
		});
	}

	private scheduleReconnect() {
		if (this._reconnectTimer) return; // already scheduled
		this._reconnecting = true;
		this._reconnectAttempt++;

		// Exponential backoff: 500ms, 1s, 2s, 4s, ... capped at 10s
		const delay = Math.min(500 * Math.pow(2, this._reconnectAttempt - 1), 10000);
		console.log(`[ws-adapter] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})...`);

		this._reconnectTimer = setTimeout(async () => {
			this._reconnectTimer = undefined;
			if (!this._wsUrl) return;
			try {
				await this.connectWs(this._wsUrl, true);
			} catch {
				// connectWs only rejects on initial connect, not reconnect
				// onclose handler will schedule next retry
			}
		}, delay);
	}

	/**
	 * Called after a successful reconnect. Re-subscribes to the current
	 * session and refreshes session statuses so the UI is up-to-date.
	 */
	private async onReconnected() {
		// Re-subscribe to the current session to get fresh state
		if (this._sessionPath && this._sessionStatus !== "virtual") {
			this._syncJson = "";
			this._syncHash = "";
			this.subscribeToSession(this._sessionPath);
		}
		this.refreshSessionStatuses();
	}

	/**
	 * Called when the tab regains visibility. Syncs session statuses and
	 * re-subscribes to the current session to get authoritative state
	 * from the server (in case WS messages were missed while backgrounded).
	 */
	private async syncStateOnFocus() {
		this.refreshSessionStatuses();

		// Re-subscribe to get fresh messages from the server
		if (this._sessionPath && this._sessionStatus !== "virtual") {
			this.subscribeToSession(this._sessionPath);
		}

		if (this._sessionStatus === "detached" && this._state.isStreaming) {
			// Session is detached (server says turn is done) but we still
			// think we're streaming — clear the stale state.
			console.log("[ws-adapter] Tab regained focus: clearing stale streaming state");
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set();
			this._resolveRunning?.();
			this._runningPromise = undefined;
			this._resolveRunning = undefined;
			this.emitStatusChange();
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

	/** Tell the server we want to receive messages for this session. */
	private async subscribeToSession(sessionPath: string | undefined) {
		try {
			await this.send({ type: "subscribe_session", sessionPath: sessionPath ?? "" });
		} catch (err) {
			console.error("Failed to subscribe to session:", err);
		}
	}

	private handleMessage(raw: string) {
		let data: any;
		try { data = JSON.parse(raw); } catch { return; }

		// Response to a pending request
		if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			pending.endSpan?.();
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

		// Session status updates for all sessions (sidebar badges)
		if (data.type === "session_status_change") {
			if (data.sessionPath && data.status) {
				this.setGlobalSessionStatus(data.sessionPath, data.status);
			}
			return;
		}

		// Hash-verified session sync from server (authoritative)
		if (data.type === "session_sync") {
			const sp = data.sessionPath as string;
			if (sp !== this._sessionPath) return;
			this.enqueueSessionSync(data);
			return;
		}

		// Backward compatibility: old steering queue event
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

		// Backward compatibility: old full snapshot event
		if (data.type === "session_messages") {
			const sp = data.sessionPath as string;
			if (sp === this._sessionPath) {
				this._state.messages = data.messages ?? [];
				if (this._restoreModelFromServer) {
					if (data.model) {
						this._state.model = this.findModelMatch(data.model) ?? this._state.model;
					}
					if (data.thinkingLevel) {
						this._state.thinkingLevel = data.thinkingLevel;
					}
					this._restoreModelFromServer = false;
				}
				this.emitContentChange();
			}
			return;
		}

		// Session attached/detached notifications — track globally for ALL sessions
		if (data.type === "session_attached") {
			if (data.sessionPath) {
				this.setGlobalSessionStatus(data.sessionPath, "running");
			}
			// Only adopt this session if:
			// - It matches the session we're currently viewing, OR
			// - We're in virtual state AND we have a pending __new__ prompt.
			//   Without this second check, a stale session_attached from a
			//   previous prompt could hijack a new virtual session the user
			//   just created while the old turn was still running.
			const shouldAdopt = data.sessionPath === this._sessionPath
				|| (this._sessionStatus === "virtual" && this._pendingNewPrompt);
			if (shouldAdopt) {
				if (this._sessionStatus === "virtual" && data.sessionPath) {
					this._sessionPath = data.sessionPath;
					const filename = path.basename(data.sessionPath, ".jsonl");
					const parts = filename.split("_");
					this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
				}
				this._sessionStatus = "attached";
				this._state.isStreaming = true;
				if (data.sessionPath) {
					this.subscribeToSession(data.sessionPath);
				}
				this.emitStatusChange();
			}
			if (data.sessionPath) {
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
				}
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
				this._pendingToolCallIds.clear();
				this._resolveRunning?.();
				this._runningPromise = undefined;
				this._resolveRunning = undefined;
				this.emitStatusChange();
				// Server pushes final session_sync automatically after detach —
				// no need to fetch from disk.
			}
			return;
		}

		// Sessions directory change notification
		if (data.type === "sessions_changed") {
			const file = data.file as string;
			for (const fn of this.sessionsChangedListeners) fn(file);
			return;
		}

		// Side-channel raw event from server (used by UI hooks like canvas/jsonl)
		if (data.type === "agent_event") {
			if (data.sessionPath && data.sessionPath !== this._sessionPath) return;
			const event = data.event as AgentEvent;
			this.emit(event);
			return;
		}

		// Legacy: raw agent event stream
		if (data.sessionPath && data.sessionPath !== this._sessionPath) return;
		const event = data as AgentEvent;
		this.updateState(event);
		this.emit(event);
	}

	/**
	 * Coalesce high-frequency session_sync updates.
	 * Latest update wins within a frame; no artificial delay beyond RAF.
	 *
	 * Important: once we have queued a full sync, never overwrite it with deltas.
	 * A full sync is required to establish the base hash after reconnect/re-subscribe.
	 */
	private enqueueSessionSync(syncMsg: any) {
		const pending = this._pendingSessionSync;
		if (!pending) {
			this._pendingSessionSync = syncMsg;
		} else if (syncMsg.op === "full") {
			// New full sync supersedes anything pending.
			this._pendingSessionSync = syncMsg;
		} else if (pending.op !== "full") {
			// Delta can replace older delta (latest-wins).
			this._pendingSessionSync = syncMsg;
		}
		// else: keep pending full, ignore incoming delta
		if (this._sessionSyncFlushScheduled || this._sessionSyncFlushInProgress) return;
		this._sessionSyncFlushScheduled = true;

		requestAnimationFrame(() => {
			this._sessionSyncFlushScheduled = false;
			this.flushSessionSyncQueue();
		});
	}

	private clearSessionSyncQueue() {
		this._pendingSessionSync = null;
		this._sessionSyncFlushScheduled = false;
	}

	private async flushSessionSyncQueue() {
		if (this._sessionSyncFlushInProgress) return;
		this._sessionSyncFlushInProgress = true;
		try {
			while (this._pendingSessionSync) {
				const next = this._pendingSessionSync;
				this._pendingSessionSync = null;
				await this.applySessionSync(next);
			}
		} finally {
			this._sessionSyncFlushInProgress = false;
			// If something arrived while we were finalizing, schedule another frame.
			if (this._pendingSessionSync && !this._sessionSyncFlushScheduled) {
				this._sessionSyncFlushScheduled = true;
				requestAnimationFrame(() => {
					this._sessionSyncFlushScheduled = false;
					this.flushSessionSyncQueue();
				});
			}
		}
	}

	private async applySessionSync(syncMsg: any) {
		const syncOp: SyncOp = {
			op: syncMsg.op,
			...(syncMsg.op === "full"
				? { data: syncMsg.data, hash: syncMsg.hash }
				: { patches: syncMsg.patches, hash: syncMsg.hash, baseHash: syncMsg.baseHash }),
		};

		// After reconnect/re-subscribe, we must receive a full sync first.
		// Ignore early deltas until a base hash exists.
		if (syncOp.op === "delta" && !this._syncHash) {
			console.warn("[ws-adapter] Ignoring delta while awaiting full sync");
			return;
		}

		const result = await applySyncOp(this._syncJson, this._syncHash, syncOp);
		if (!result) {
			// Hash verification failed — request a full sync by re-subscribing
			console.error("[ws-adapter] Sync verification failed, re-subscribing");
			if (this._sessionPath) {
				this._syncJson = "";
				this._syncHash = "";
				this.subscribeToSession(this._sessionPath);
			}
			return;
		}

		this._syncJson = result.data;
		this._syncHash = result.hash;

		// Parse the synced state and apply it
		let state: any;
		try {
			state = JSON.parse(result.data);
		} catch {
			console.error("[ws-adapter] Failed to parse synced state");
			return;
		}

		// The server sends a flat messages array with everything merged in.
		// Just use it directly — no splitting, no fixups.
		this._state.messages = state.messages ?? [];
		this._state.isStreaming = state.isStreaming ?? false;
		if (this._sessionStatus !== "virtual") {
			this._sessionStatus = this._state.isStreaming ? "attached" : "detached";
		}
		this._pendingToolCallIds = new Set(state.pendingToolCalls ?? []);
		this._state.pendingToolCalls = this._pendingToolCallIds;

		// Keep streamMessage null — we don't use the two-zone split anymore.
		// Everything is in the flat messages array.
		this._state.streamMessage = null;

		if (this._restoreModelFromServer) {
			if (state.model) {
				this._state.model = this.findModelMatch(state.model) ?? this._state.model;
			}
			if (state.thinkingLevel) {
				this._state.thinkingLevel = state.thinkingLevel;
			}
			this._restoreModelFromServer = false;
		}
		if (Array.isArray(state.steeringQueue) && this._sessionPath) {
			if (state.steeringQueue.length > 0) this._steeringQueues.set(this._sessionPath, [...state.steeringQueue]);
			else this._steeringQueues.delete(this._sessionPath);
			this.emitSteeringQueueChange();
		}
		if (state.error) {
			this._state.error = state.error;
		} else {
			this._state.error = undefined;
		}

		this.emitContentChange();
		this.emitStatusChange();
	}

	/**
	 * Legacy event handler — only used for backward-compat agent_event side-channel.
	 * The primary state path is session_sync, which delivers the full flat state.
	 * This only handles agent_start/agent_end for streaming status and running promise.
	 */
	private updateState(event: AgentEvent) {
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._state.error = undefined;
				this._runningPromise = new Promise((resolve) => {
					this._resolveRunning = resolve;
				});
				this.emitStatusChange();
				break;

			case "agent_end":
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();
				this._pendingToolCallIds.clear();
				this._resolveRunning?.();
				this._runningPromise = undefined;
				this._resolveRunning = undefined;
				this.emitStatusChange();
				break;

			case "turn_end":
				if (event.message.role === "assistant" && (event.message as any).errorMessage) {
					this._state.error = (event.message as any).errorMessage;
				}
				break;
		}
	}

	private send(command: WsCommand | any): Promise<any> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket not connected"));
		}

		const id = `req_${++this.requestId}`;
		const endSpan = traceSpanStart(`frontend_ws_command ${command.type}`);
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				endSpan();
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (data) => { clearTimeout(timeout); resolve(data); },
				reject: (err) => { clearTimeout(timeout); reject(err); },
				endSpan,
			});

			this.ws!.send(JSON.stringify({
				...command,
				id,
				__trace: {
					traceId: getLoadTraceId(),
				},
			}));
		});
	}

	// ── Models ─────────────────────────────────────────────────────────────

	/** Fetch available models from the server (uses any idle pi process) */
	async fetchAvailableModels(): Promise<any[]> {
		const data = await this.send({ type: "get_available_models" });
		const models = data?.models ?? [];
		this._availableModels = models;
		return models;
	}

	/** Find a matching model from the available models cache */
	private findModelMatch(serverModel: { provider: string; modelId: string }): any | undefined {
		if (!this._availableModels) return undefined;
		return this._availableModels.find(
			(m: any) => m.provider === serverModel.provider && m.id === serverModel.modelId,
		);
	}

	/**
	 * Determine whether a model supports adjustable thinking.
	 *
	 * We prefer explicit provider metadata (`reasoning: true|false`).
	 * For known model families where metadata can be missing, infer support.
	 */
	private modelSupportsThinking(model: any): boolean {
		if (!model) return false;
		if (typeof model.reasoning === "boolean") return model.reasoning;

		const provider = String(model.provider ?? "").toLowerCase();
		const id = String(model.id ?? "").toLowerCase();

		if (provider === "openai-codex") return true;
		if (provider === "openai" && id.startsWith("gpt-5")) return true;

		return false;
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
		// We check the global session status map (server-authoritative) to determine
		// if the specific session we're viewing is running. This prevents prompts
		// for other conversations from being queued as steers.
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

		const effectiveModel = this._nextPromptModelOverride ?? this._state.model;
		if (!effectiveModel) {
			throw new Error(`BUG: effective model is undefined when sending prompt. sessionStatus=${this._sessionStatus}, sessionPath=${this._sessionPath}`);
		}
		const modelPayload = { provider: effectiveModel.provider, modelId: effectiveModel.id };

		if (this._sessionStatus === "virtual") {
			// Consume one-shot override exactly once (for this prompt only).
			this._nextPromptModelOverride = undefined;
			// Capture session nonce before the await. The prompt RPC blocks
			// until the pi process finishes the entire turn (after agent_end),
			// so the user may navigate away (e.g. create a new session) during
			// the await. If the nonce changed, the response is stale — ignore it.
			const nonce = this._sessionNonce;
			this._pendingNewPrompt = true;
			try {
				const res = await this.send({
					type: "prompt",
					sessionPath: "__new__",
					cwd: this._pendingCwd,
					message: text,
					model: modelPayload,
					thinkingLevel: this._state.thinkingLevel,
					images,
				});
				if (this._sessionNonce !== nonce) {
					// User navigated away during the prompt — discard stale response
					console.log("[ws-adapter] Discarding stale prompt response (session changed during await)");
					return;
				}
				const newSessionPath = res?.newSessionPath;
				if (newSessionPath && !this._sessionPath) {
					this._sessionPath = newSessionPath;
					const filename = path.basename(newSessionPath, ".jsonl");
					const parts = filename.split("_");
					this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
					this._sessionStatus = "attached";
					this.subscribeToSession(newSessionPath);
					this.emitSessionChange();
					this.emitStatusChange();
				}
			} finally {
				this._pendingNewPrompt = false;
			}
			return;
		}

		if (!this._sessionPath) throw new Error("No session loaded");

		// Consume one-shot override exactly once (for this prompt only).
		this._nextPromptModelOverride = undefined;

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

	/** Fetch available slash commands from the server (extensions, prompts, skills) */
	async fetchCommands(): Promise<Array<{ name: string; description?: string; source: string; location?: string }>> {
		try {
			const data = await this.send({ type: "get_commands" });
			return data?.commands ?? [];
		} catch {
			return [];
		}
	}

	private async showHelpMessage() {
		const lines: string[] = [
			"**Built-in commands:**",
			"",
			"| Command | Description |",
			"|---------|-------------|",
			"| `/help` | Show this help |",
			"| `/new` | Start a new session |",
			"| `/fork` | Fork session from a previous message |",
			"| `/compact [instructions]` | Compact conversation history |",
			"| `/name <name>` | Set session display name |",
			"| `/reload` | Restart all pooled pi RPC processes |",
		];

		// Fetch extension commands, prompt templates, and skills from pi
		const commands = await this.fetchCommands();

		const extensionCmds = commands.filter(c => c.source === "extension");
		const promptCmds = commands.filter(c => c.source === "prompt");
		const skillCmds = commands.filter(c => c.source === "skill");

		if (extensionCmds.length > 0) {
			lines.push("", "**Extension commands:**", "", "| Command | Description |", "|---------|-------------|");
			for (const cmd of extensionCmds) {
				lines.push(`| \`/${cmd.name}\` | ${cmd.description || ""} |`);
			}
		}

		if (promptCmds.length > 0) {
			lines.push("", "**Prompt templates:**", "", "| Command | Description |", "|---------|-------------|");
			for (const cmd of promptCmds) {
				const loc = cmd.location ? ` *(${cmd.location})*` : "";
				lines.push(`| \`/${cmd.name}\` | ${cmd.description || ""}${loc} |`);
			}
		}

		if (skillCmds.length > 0) {
			lines.push("", "**Skills:**", "", "| Command | Description |", "|---------|-------------|");
			for (const cmd of skillCmds) {
				const loc = cmd.location ? ` *(${cmd.location})*` : "";
				lines.push(`| \`/${cmd.name}\` | ${cmd.description || ""}${loc} |`);
			}
		}

		lines.push(
			"",
			"**Keyboard shortcuts:**",
			"",
			"| Shortcut | Action |",
			"|----------|--------|",
			"| `Enter` | Send message (also works during streaming to steer) |",
			"| `Cmd+Enter` | Fork session and send message in the fork |",
			"| `Shift+Enter` | New line |",
			"| `Escape` | Abort current turn |",
		);

		const helpText = lines.join("\n");

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
			await this.showHelpMessage();
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
			// Show a loading indicator while compaction runs (LLM summarization can take a while)
			this._state.isStreaming = true;
			this._state.messages = [...this._state.messages, {
				role: "compactionSummary",
				summary: "",
				tokensBefore: 0,
				timestamp: Date.now(),
				_compacting: true,
			} as any];
			this.emitStatusChange();
			this.emitContentChange();
			try {
				await this.send({ type: "compact", sessionPath: this._sessionPath, customInstructions });
			} finally {
				this._state.isStreaming = false;
				this.emitStatusChange();
			}
			// Re-subscribe to get fresh messages after compaction
			await this.subscribeToSession(this._sessionPath);
			return true;
		}

		if (trimmed.startsWith("/name ")) {
			const name = trimmed.slice(6).trim();
			if (!name) return true;
			if (!this._sessionPath) {
				this._state.messages = [...this._state.messages, {
					role: "assistant",
					content: [{ type: "text", text: "Cannot set name: no active session. Send a message first." }],
				} as AgentMessage];
				this.emitContentChange();
				return true;
			}
			try {
				await this.send({ type: "set_session_name", sessionPath: this._sessionPath, name });
				this._sessionName = name;
				this._state.messages = [...this._state.messages, {
					role: "assistant",
					content: [{ type: "text", text: `Session renamed to **${name}**` }],
				} as AgentMessage];
				this.emitContentChange();
				this.emitSessionChange();
			} catch (err: any) {
				this._state.messages = [...this._state.messages, {
					role: "assistant",
					content: [{ type: "text", text: `Failed to rename session: ${err?.message || "unknown error"}` }],
				} as AgentMessage];
				this.emitContentChange();
			}
			return true;
		}

		if (trimmed === "/reload") {
			try {
				const data = await this.send({ type: "reload_processes" }) as { killed?: number; draining?: number };
				const killed = data?.killed ?? 0;
				const draining = data?.draining ?? 0;
				this._state.messages = [...this._state.messages, {
					role: "assistant",
					content: [{ type: "text", text: `Reload requested: killed ${killed} idle process(es), draining ${draining} running process(es).` }],
				} as AgentMessage];
				this.emitContentChange();
			} catch (err: any) {
				this._state.messages = [...this._state.messages, {
					role: "assistant",
					content: [{ type: "text", text: `Failed to reload pi processes: ${err?.message || "unknown error"}` }],
				} as AgentMessage];
				this.emitContentChange();
			}
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

	setModel(m: Model<any>) {
		// One-shot override: applies only to the next prompt in the current session.
		this._nextPromptModelOverride = m;
		// Reflect selection in the UI immediately.
		this._state.model = m;
		// Whenever the user selects a model, reset thinking to a consistent default.
		// Use "medium" for reasoning-capable models, otherwise force "off".
		this._state.thinkingLevel = this.modelSupportsThinking(m) ? "medium" : "off";
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


	// ── Fork ───────────────────────────────────────────────────────────────

	/** Get user messages from the current session for the fork selector. */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		if (!this._sessionPath) return [];
		const res = await tracedFetch(`/api/sessions/fork-messages?path=${encodeURIComponent(this._sessionPath)}`, {}, "frontend_fetch_fork_messages");
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

		if (!this._state.model) {
			throw new Error(`BUG: _state.model is undefined when sending fork_prompt. sessionPath=${this._sessionPath}`);
		}
		const modelPayload = { provider: this._state.model.provider, modelId: this._state.model.id };

		const nonce = this._sessionNonce;
		const data = await this.send({
			type: "fork_prompt",
			sessionPath: this._sessionPath,
			message: text,
			model: modelPayload,
			thinkingLevel: this._state.thinkingLevel,
			images,
		});

		// Switch to the new forked session (only if user hasn't navigated away)
		if (this._sessionNonce !== nonce) {
			console.log("[ws-adapter] Discarding stale fork_prompt response (session changed during await)");
			return;
		}
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
		const res = await tracedFetch("/api/sessions", {}, "frontend_fetch_sessions");
		if (!res.ok) throw new Error(`Failed to list sessions: ${res.statusText}`);
		const sessions: SessionInfoDTO[] = await res.json();

		// Merge optimistic sessions: add any that aren't yet in the real list.
		// When a real session exists but has an empty cwd (JSONL header not yet
		// flushed), keep using the optimistic entry so the session doesn't
		// briefly jump to "(unknown)" in the sidebar.
		const realPaths = new Set(sessions.map((s) => s.path));
		for (const [optPath, optSession] of this._optimisticSessions) {
			if (realPaths.has(optPath)) {
				const real = sessions.find((s) => s.path === optPath);
				if (real && !real.cwd && optSession.cwd) {
					// Real session has no cwd yet — use optimistic cwd
					real.cwd = optSession.cwd;
					// Keep the optimistic entry for next time
				} else {
					// Real session has a proper cwd — optimistic no longer needed
					this._optimisticSessions.delete(optPath);
				}
			} else {
				// Still not on disk — include the optimistic entry
				sessions.push(optSession);
			}
		}

		// Include the current virtual session so it shows in the sidebar
		// in the correct cwd group before any message is sent.
		const virtual = this.virtualSessionInfo;
		if (virtual && !realPaths.has(virtual.path)) {
			sessions.push(virtual);
		}

		return sessions;
	}

	/** Get current optimistic sessions (sessions known before the JSONL scan catches up). */
	get optimisticSessions(): SessionInfoDTO[] {
		return Array.from(this._optimisticSessions.values());
	}

	async deleteSession(sessionPath: string): Promise<void> {
		const res = await tracedFetch("/api/sessions", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: sessionPath }),
		});
		if (!res.ok) throw new Error(`Failed to delete session: ${res.statusText}`);
	}

	/** Switch to an existing session (load messages from server cache) */
	async switchSession(sessionPath: string): Promise<void> {
		this._sessionNonce++;
		this._pendingNewPrompt = false;
		this._sessionPath = sessionPath;
		// Extract session ID from filename
		const filename = path.basename(sessionPath, ".jsonl");
		const parts = filename.split("_");
		this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
		this._sessionStatus = "detached";
		this._restoreModelFromServer = true;

		// Clear current state — including isStreaming since a detached session is never streaming
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._pendingToolCallIds.clear();
		this._syncJson = "";
		this._syncHash = "";
		this.clearSessionSyncQueue();
		this._state.error = undefined;

		// Subscribe to this session on the server — it will push session_sync
		// with the full state.
		await this.subscribeToSession(sessionPath);

		// If the session is currently running on the server, restore streaming state
		// so the stop button is visible, and mark as "attached" to prevent file-watcher
		// re-fetches from racing with streaming events.
		if (this._globalSessionStatus.get(sessionPath) === "running") {
			this._sessionStatus = "attached";
			this._state.isStreaming = true;
		}

		this.emitSessionChange();
		this.emitStatusChange();
	}

	/** Create a new virtual session (no JSONL file until first message) */
	async newSession(cwd?: string): Promise<void> {
		this._sessionNonce++;
		this._pendingNewPrompt = false;
		this._sessionId = typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: Array.from(crypto.getRandomValues(new Uint8Array(16)))
				.map(b => b.toString(16).padStart(2, "0")).join("")
				.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
		this._sessionPath = undefined;
		this._sessionName = undefined;
		this._sessionStatus = "virtual";
		this._pendingCwd = cwd;

		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._pendingToolCallIds.clear();
		this._syncJson = "";
		this._syncHash = "";
		this.clearSessionSyncQueue();
		this._state.error = undefined;

		// Unsubscribe from any previous session
		this.subscribeToSession(undefined);

		this.emitSessionChange();
		this.emitStatusChange();
	}

	/**
	 * Get a SessionInfoDTO for the current virtual session (if any).
	 * This allows the sidebar to show new sessions before any message is sent.
	 */
	get virtualSessionInfo(): SessionInfoDTO | undefined {
		if (this._sessionStatus !== "virtual" || !this._pendingCwd) return undefined;
		const now = new Date().toISOString();
		return {
			id: this._sessionId,
			path: `__virtual__${this._sessionId}`,
			cwd: this._pendingCwd,
			created: now,
			modified: now,
			lastUserPromptTime: now,
			messageCount: 0,
			firstMessage: "(new session)",
		};
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
	cwdDisplay?: string;
	name?: string;
	created: string;
	modified: string;
	/** ISO timestamp of the most recent user input prompt, if any. */
	lastUserPromptTime?: string;
	messageCount: number;
	firstMessage: string;
}

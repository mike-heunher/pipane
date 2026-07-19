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

import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { getLoadTraceId, traceSpanStart, tracedFetch } from "./load-trace.js";
import { applySyncOps, type SyncOp } from "../shared/jsonl-sync.js";
import {
	clampThinkingLevel,
	modelsMatch,
	toCompactModelRef,
	type ThinkingLevelValue,
} from "../shared/thinking-levels.js";

export type SessionStatus = "virtual" | "detached" | "attached";

export interface AdapterState {
	systemPrompt: string;
	model: any;
	thinkingLevel: ThinkingLevelValue;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

type SessionSyncChanges = {
	content: boolean;
	status: boolean;
	steering: boolean;
};

type WsCommand =
	| { type: "prompt"; sessionPath: string; message: string; model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevelValue; controlRevision?: number; images?: ImageContent[] }
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

	private _state: AdapterState = {
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
	/** Complete extension status snapshot for the current session. */
	private _extensionStatuses = new Map<string, string>();
	private _extensionStatusListeners = new Set<() => void>();
	/** Monotonic client-local revision for model/thinking edits. */
	private _controlRevision = 0;
	/**
	 * An unsent or not-yet-synced local control edit. While present, ordinary
	 * session snapshots may update messages but cannot overwrite the controls.
	 */
	private _pendingControl: {
		revision: number;
		sessionNonce: number;
		phase: "local" | "sent" | "acknowledged";
		model?: any;
		thinkingLevel?: ThinkingLevelValue;
	} | undefined;
	/** Last server-confirmed controls for rolling back a failed sent revision. */
	private _lastAuthoritativeControl: {
		sessionNonce: number;
		model: any;
		thinkingLevel: ThinkingLevelValue;
	} | undefined;

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
	/** Coordinate rapid sends while a session's first turn is still attaching. */
	private _startingPrompts = new Map<string, {
		ready: Promise<string | undefined>;
		resolveReady: (sessionPath: string | undefined) => void;
		finished: Promise<void>;
		resolveFinished: () => void;
	}>();

	/** Current synced JSON string from server */
	private _syncJson = "";
	/** Current synced hash */
	private _syncHash = "";

	// ── session_sync frame queue ──────────────────────────────────────────
	/** Ordered operations waiting to be applied; deltas are hash-dependent. */
	private _pendingSessionSyncs: any[] = [];
	/** True when a frame callback has been scheduled to flush session_sync. */
	private _sessionSyncFlushScheduled = false;
	/** True while applySessionSync is running to prevent concurrent flushes. */
	private _sessionSyncFlushInProgress = false;

	private _sessionListeners = new Set<() => void>();
	private _contentListeners = new Set<() => void>();
	private _statusListeners = new Set<() => void>();

	get state(): AdapterState { return this._state; }
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

	get extensionStatuses(): ReadonlyMap<string, string> {
		return this._extensionStatuses;
	}

	onExtensionStatusChange(fn: () => void): () => void {
		this._extensionStatusListeners.add(fn);
		return () => this._extensionStatusListeners.delete(fn);
	}

	private replaceExtensionStatuses(statuses: unknown): void {
		const next = new Map<string, string>();
		if (statuses && typeof statuses === "object" && !Array.isArray(statuses)) {
			for (const [key, value] of Object.entries(statuses)) {
				if (typeof value === "string") next.set(key, value);
			}
		}
		if (next.size === this._extensionStatuses.size
			&& [...next].every(([key, value]) => this._extensionStatuses.get(key) === value)) return;
		this._extensionStatuses = next;
		for (const fn of this._extensionStatusListeners) fn();
	}

	private clearExtensionStatuses(): void {
		this.replaceExtensionStatuses({});
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
		if (status === "running") {
			this._startingPrompts.get(sessionPath)?.resolveReady(sessionPath);
		}
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

	private toErrorMessage(err: unknown): string {
		if (err instanceof Error) return err.message;
		if (typeof err === "string") return err;
		try {
			return JSON.stringify(err);
		} catch {
			return String(err);
		}
	}

	/** Surface an error in the chat UI so failures are visible to the user. */
	reportError(err: unknown, prefix = "Request failed"): void {
		const message = this.toErrorMessage(err);
		this._state.error = message;
		this._state.messages = [...this._state.messages, {
			role: "assistant",
			content: [{ type: "text", text: `⚠️ ${prefix}: ${message}` }],
			timestamp: Date.now(),
		} as AgentMessage];
		this.emitStatusChange();
		this.emitContentChange();
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

				// A sent edit may have failed before its acknowledgement; allow the
				// reconnect snapshot to restore truth. Keep genuinely unsent edits.
				if (this._pendingControl?.phase === "sent") {
					this.rollbackSentControl(this._pendingControl.revision);
				} else if (this._pendingControl?.phase === "acknowledged") {
					this._pendingControl = undefined;
				}

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
				const message = data.error || "Unknown error";
				this._state.error = message;
				this.emitStatusChange();
				pending.reject(new Error(message));
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

		// Complete extension status snapshot for the active session.
		if (data.type === "extension_status") {
			if (data.sessionPath !== this._sessionPath) return;
			this.replaceExtensionStatuses(data.statuses);
			return;
		}

		// Hash-verified session sync from server (authoritative)
		if (data.type === "session_sync") {
			const sp = data.sessionPath as string;
			if (sp !== this._sessionPath) return;
			this.enqueueSessionSync({
				...data,
				__sessionPath: sp,
				__sessionNonce: this._sessionNonce,
			});
			return;
		}

		// Effective model/thinking after pi has applied and clamped a request.
		if (data.type === "control_state") {
			if (data.sessionPath !== this._sessionPath) return;
			const applied = this.applyAuthoritativeControlState(
				data.model,
				data.thinkingLevel,
				data.controlRevision,
			);
			if (applied) this.emitContentChange();
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
				this.applyAuthoritativeControlState(data.model, data.thinkingLevel);
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
					this._startingPrompts.get(`virtual:${this._sessionNonce}`)?.resolveReady(data.sessionPath);
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
	 * Queue hash-dependent sync operations for the next frame. A newer full
	 * snapshot supersedes queued history, but every delta after that full must be
	 * retained and applied in order because its baseHash depends on the prior op.
	 */
	private enqueueSessionSync(syncMsg: any) {
		if (syncMsg.op === "full") {
			this._pendingSessionSyncs = [syncMsg];
		} else {
			this._pendingSessionSyncs.push(syncMsg);
		}
		if (this._sessionSyncFlushScheduled || this._sessionSyncFlushInProgress) return;
		this._sessionSyncFlushScheduled = true;

		requestAnimationFrame(() => {
			this._sessionSyncFlushScheduled = false;
			this.flushSessionSyncQueue();
		});
	}

	private clearSessionSyncQueue() {
		this._pendingSessionSyncs = [];
		this._sessionSyncFlushScheduled = false;
	}

	private async flushSessionSyncQueue() {
		if (this._sessionSyncFlushInProgress) return;
		this._sessionSyncFlushInProgress = true;
		// Process at most one frame-sized batch. Messages received while hashing
		// remain queued for the next animation frame, preserving progressive
		// streaming instead of starving rendering until a long turn finishes.
		const batch = this._pendingSessionSyncs.splice(0);
		try {
			const changes = await this.applySessionSyncBatch(batch);
			if (changes) this.emitSessionSyncChanges(changes);
		} finally {
			this._sessionSyncFlushInProgress = false;
			if (this._pendingSessionSyncs.length > 0 && !this._sessionSyncFlushScheduled) {
				this._sessionSyncFlushScheduled = true;
				requestAnimationFrame(() => {
					this._sessionSyncFlushScheduled = false;
					this.flushSessionSyncQueue();
				});
			}
		}
	}

	/** Single-operation wrapper retained for focused tests and recovery paths. */
	private async applySessionSync(syncMsg: any) {
		const changes = await this.applySessionSyncBatch([syncMsg]);
		if (changes) this.emitSessionSyncChanges(changes);
	}

	private emitSessionSyncChanges(changes: SessionSyncChanges) {
		if (changes.steering) this.emitSteeringQueueChange();
		if (changes.content) this.emitContentChange();
		if (changes.status) this.emitStatusChange();
	}

	private async applySessionSyncBatch(syncMessages: any[]): Promise<SessionSyncChanges | undefined> {
		const syncSessionPath = this._sessionPath;
		const syncSessionNonce = this._sessionNonce;
		if (!syncSessionPath || syncMessages.length === 0) return;
		if (syncMessages.some((message) =>
			message.__sessionPath !== syncSessionPath || message.__sessionNonce !== syncSessionNonce
		)) return;

		const syncOps: SyncOp[] = syncMessages.map((syncMsg) => ({
			op: syncMsg.op,
			...(syncMsg.op === "full"
				? { data: syncMsg.data, hash: syncMsg.hash }
				: { patches: syncMsg.patches, hash: syncMsg.hash, baseHash: syncMsg.baseHash }),
		}) as SyncOp);

		// After reconnect/re-subscribe, we must receive a full sync first.
		// Ignore early deltas until a base hash exists.
		if (syncOps[0]?.op === "delta" && !this._syncHash) {
			console.warn("[ws-adapter] Ignoring delta while awaiting full sync");
			return;
		}

		const result = await applySyncOps(this._syncJson, this._syncHash, syncOps);
		// Hashing is asynchronous. Never let an old session commit into a newer one.
		if (syncSessionPath !== this._sessionPath || syncSessionNonce !== this._sessionNonce) return;
		if (!result) {
			// Hash verification failed — request a full sync by re-subscribing.
			console.error("[ws-adapter] Sync verification failed, re-subscribing");
			this._syncJson = "";
			this._syncHash = "";
			this.subscribeToSession(syncSessionPath);
			return;
		}

		this._syncJson = result.data;
		this._syncHash = result.hash;

		// Parse only the final state in the batch. Intermediate hash-chain states
		// were never observable between animation frames.
		let state: any;
		try {
			state = JSON.parse(result.data);
		} catch {
			console.error("[ws-adapter] Failed to parse synced state");
			return;
		}

		const previousStreaming = this._state.isStreaming;
		const previousSessionStatus = this._sessionStatus;
		const previousError = this._state.error;
		const previousSteering = [...(this._steeringQueues.get(syncSessionPath) ?? [])];

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

		this.applyAuthoritativeControlState(state.model, state.thinkingLevel);
		if (Array.isArray(state.steeringQueue)) {
			if (state.steeringQueue.length > 0) this._steeringQueues.set(syncSessionPath, [...state.steeringQueue]);
			else this._steeringQueues.delete(syncSessionPath);
		}
		this._state.error = state.error || undefined;

		const nextSteering = this._steeringQueues.get(syncSessionPath) ?? [];
		return {
			content: true,
			status: previousStreaming !== this._state.isStreaming
				|| previousSessionStatus !== this._sessionStatus
				|| previousError !== this._state.error,
			steering: previousSteering.length !== nextSteering.length
				|| previousSteering.some((value, index) => value !== nextSteering[index]),
		};
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
			const timeoutMs = command.type === "prompt" || command.type === "fork_prompt" ? 90000 : 30000;
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				endSpan();
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, timeoutMs);

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

	/** Fetch and cache the full model catalog used to resolve session model refs. */
	async fetchAvailableModels(): Promise<any[]> {
		const data = await this.send({ type: "get_available_models" });
		const models = data?.models ?? [];
		this._availableModels = models;

		// Enrich a compact fallback model once metadata becomes available.
		const current = this.resolveModel(this._state.model);
		if (current) this._state.model = current;
		return models;
	}

	/** Resolve both full runtime models and compact persisted session refs. */
	private resolveModel(serverModel: any): any | undefined {
		if (!serverModel) return undefined;
		const cached = this._availableModels?.find((model: any) => modelsMatch(model, serverModel));
		if (cached) return cached;

		const ref = toCompactModelRef(serverModel);
		if (!ref) return undefined;
		// Never retain an unrelated previous session's model when metadata is
		// unavailable. A shallow full-model shape is still correct for prompting.
		return { ...serverModel, provider: ref.provider, id: ref.modelId };
	}

	private markControlPending(): number {
		const revision = ++this._controlRevision;
		this._pendingControl = {
			revision,
			sessionNonce: this._sessionNonce,
			phase: "local",
		};
		return revision;
	}

	private markControlSent(revision: number): void {
		if (this._pendingControl?.revision === revision
			&& this._pendingControl.sessionNonce === this._sessionNonce) {
			this._pendingControl.phase = "sent";
		}
	}

	private rollbackSentControl(revision: number): void {
		const pending = this._pendingControl;
		if (!pending || pending.revision !== revision || pending.phase !== "sent") return;
		this._pendingControl = undefined;
		const previous = this._lastAuthoritativeControl;
		if (previous?.sessionNonce === this._sessionNonce) {
			this._state.model = previous.model;
			this._state.thinkingLevel = previous.thinkingLevel as any;
			this.emitContentChange();
		}
	}

	private rememberAuthoritativeControl(model: any, thinkingLevel: ThinkingLevelValue): void {
		this._lastAuthoritativeControl = {
			sessionNonce: this._sessionNonce,
			model,
			thinkingLevel,
		};
	}

	/**
	 * Apply controls from a snapshot or a direct, revisioned acknowledgement.
	 * Snapshots cannot overwrite an unsent local edit. After an acknowledgement,
	 * the barrier remains until its matching snapshot arrives, protecting against
	 * an older full sync already queued for asynchronous hash verification.
	 */
	private applyAuthoritativeControlState(
		serverModel: any,
		thinkingLevel: string | undefined,
		controlRevision?: number,
	): boolean {
		const resolvedModel = this.resolveModel(serverModel);
		const resolvedThinking = thinkingLevel as ThinkingLevelValue | undefined;
		const pending = this._pendingControl;

		if (controlRevision !== undefined) {
			if (pending) {
				if (pending.sessionNonce !== this._sessionNonce || pending.revision !== controlRevision) {
					return false;
				}
				pending.phase = "acknowledged";
				pending.model = resolvedModel;
				pending.thinkingLevel = resolvedThinking;
			}
			if (resolvedModel) this._state.model = resolvedModel;
			if (resolvedThinking) this._state.thinkingLevel = resolvedThinking as any;
			if (resolvedModel && resolvedThinking) {
				this.rememberAuthoritativeControl(resolvedModel, resolvedThinking);
			}
			return !!resolvedModel || !!resolvedThinking;
		}

		if (pending) {
			const matchesAcknowledged = pending.phase === "acknowledged"
				&& !!pending.model
				&& modelsMatch(serverModel, pending.model)
				&& resolvedThinking === pending.thinkingLevel;
			if (!matchesAcknowledged) return false;
			this._pendingControl = undefined;
		}

		if (resolvedModel) this._state.model = resolvedModel;
		if (resolvedThinking) this._state.thinkingLevel = resolvedThinking as any;
		if (resolvedModel && resolvedThinking) {
			this.rememberAuthoritativeControl(resolvedModel, resolvedThinking);
		}
		return !!resolvedModel || !!resolvedThinking;
	}

	async installPi(): Promise<void> {
		await this.send({ type: "install_pi" });
	}

	/** Load the default model from the pi process (respects user's settings) */
	async loadDefaultModel(): Promise<void> {
		if (this._state.model) return;
		const data = await this.send({ type: "get_default_model" });
		this.applyAuthoritativeControlState(data?.model, data?.thinkingLevel);
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

	private createStartingPrompt(key: string) {
		let resolveReady!: (sessionPath: string | undefined) => void;
		let resolveFinished!: () => void;
		const entry = {
			ready: new Promise<string | undefined>((resolve) => { resolveReady = resolve; }),
			resolveReady: (sessionPath: string | undefined) => resolveReady(sessionPath),
			finished: new Promise<void>((resolve) => { resolveFinished = resolve; }),
			resolveFinished: () => resolveFinished(),
		};
		this._startingPrompts.set(key, entry);
		return entry;
	}

	private finishStartingPrompt(key: string, entry: ReturnType<WsAgentAdapter["createStartingPrompt"]>, attachedPath?: string): void {
		entry.resolveReady(attachedPath);
		entry.resolveFinished();
		if (this._startingPrompts.get(key) === entry) this._startingPrompts.delete(key);
	}

	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
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

		const promptStartKey = this._sessionStatus === "virtual"
			? `virtual:${this._sessionNonce}`
			: this._sessionPath;
		const existingStart = promptStartKey ? this._startingPrompts.get(promptStartKey) : undefined;
		if (existingStart) {
			const attachedPath = await existingStart.ready;
			if (attachedPath && this._globalSessionStatus.get(attachedPath) === "running") {
				this.enqueueSteering(attachedPath, text);
				await this.send({ type: "steer", sessionPath: attachedPath, message: text });
				return;
			}
			await existingStart.finished;
			if (!attachedPath) throw new Error("The session failed to start before the queued prompt could be sent");
			return this.prompt(input, images);
		}

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

		const effectiveModel = this._state.model;
		if (!effectiveModel) {
			throw new Error(`BUG: effective model is undefined when sending prompt. sessionStatus=${this._sessionStatus}, sessionPath=${this._sessionPath}`);
		}
		const modelPayload = toCompactModelRef(effectiveModel);
		if (!modelPayload) throw new Error("BUG: active model has no provider/model ID");
		const thinkingLevel = this._state.thinkingLevel as ThinkingLevelValue;
		const controlRevision = this._pendingControl?.revision ?? this._controlRevision;
		this.markControlSent(controlRevision);
		const startingKey = promptStartKey ?? `virtual:${this._sessionNonce}`;
		const startingEntry = this.createStartingPrompt(startingKey);

		if (this._sessionStatus === "virtual") {
			// Capture the session nonce before the await. Pipane keeps this request
			// open until the accepted turn settles, so the user may navigate away
			// while it is running. Ignore the eventual response after navigation.
			const nonce = this._sessionNonce;
			this._pendingNewPrompt = true;
			try {
				const res = await this.send({
					type: "prompt",
					sessionPath: "__new__",
					cwd: this._pendingCwd,
					message: text,
					model: modelPayload,
					thinkingLevel,
					controlRevision,
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
			} catch (err) {
				this.rollbackSentControl(controlRevision);
				throw err;
			} finally {
				this._pendingNewPrompt = false;
				const attachedPath = this._sessionNonce === nonce ? this._sessionPath : undefined;
				this.finishStartingPrompt(startingKey, startingEntry, attachedPath);
			}
			return;
		}

		if (!this._sessionPath) throw new Error("No session loaded");

		try {
			await this.send({
				type: "prompt",
				sessionPath: this._sessionPath,
				message: text,
				model: modelPayload,
				thinkingLevel,
				controlRevision,
				images,
			});
		} catch (err) {
			this.rollbackSentControl(controlRevision);
			throw err;
		} finally {
			this.finishStartingPrompt(startingKey, startingEntry, this._sessionPath);
		}
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
		const resolved = this.resolveModel(m) ?? m;
		const sameModel = modelsMatch(this._state.model, resolved);
		const nextThinking = clampThinkingLevel(resolved, this._state.thinkingLevel);
		if (sameModel && nextThinking === this._state.thinkingLevel) return;

		this._state.model = resolved;
		// Preserve the user's level when supported; otherwise preview the exact
		// upward-then-downward clamp that pi will apply.
		this._state.thinkingLevel = nextThinking as any;
		this.markControlPending();
		this.emitContentChange();
	}

	setThinkingLevel(level: ThinkingLevelValue) {
		const nextLevel = clampThinkingLevel(this._state.model, level);
		if (nextLevel === this._state.thinkingLevel) return;
		this._state.thinkingLevel = nextLevel as any;
		this.markControlPending();
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
		const modelPayload = toCompactModelRef(this._state.model);
		if (!modelPayload) throw new Error("BUG: active model has no provider/model ID");
		const controlRevision = this._pendingControl?.revision ?? this._controlRevision;
		this.markControlSent(controlRevision);

		const nonce = this._sessionNonce;
		let data: any;
		try {
			data = await this.send({
				type: "fork_prompt",
				sessionPath: this._sessionPath,
				message: text,
				model: modelPayload,
				thinkingLevel: this._state.thinkingLevel as ThinkingLevelValue,
				controlRevision,
				images,
			});
		} catch (err) {
			this.rollbackSentControl(controlRevision);
			throw err;
		}

		// Switch to the new forked session (only if user hasn't navigated away)
		if (this._sessionNonce !== nonce) {
			console.log("[ws-adapter] Discarding stale fork_prompt response (session changed during await)");
			return;
		}
		if (data?.newSessionPath) {
			// Re-enter through normal restoration so the fork's authoritative,
			// potentially clamped controls are loaded from its final snapshot.
			await this.switchSession(data.newSessionPath);
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
		const nonce = ++this._sessionNonce;
		this._pendingNewPrompt = false;
		this._pendingControl = undefined;
		this._lastAuthoritativeControl = undefined;
		this._sessionPath = sessionPath;
		this.clearExtensionStatuses();
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
		this._pendingToolCallIds.clear();
		this._syncJson = "";
		this._syncHash = "";
		this.clearSessionSyncQueue();
		this._state.error = undefined;

		// Subscribe to this session on the server — it will push session_sync
		// with the full state.
		await this.subscribeToSession(sessionPath);
		if (nonce !== this._sessionNonce || sessionPath !== this._sessionPath) return;

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
		this._pendingControl = undefined;
		this._sessionId = typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: Array.from(crypto.getRandomValues(new Uint8Array(16)))
				.map(b => b.toString(16).padStart(2, "0")).join("")
				.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
		this._sessionPath = undefined;
		this._sessionName = undefined;
		this.clearExtensionStatuses();
		this._sessionStatus = "virtual";
		this._pendingCwd = cwd;
		if (this._state.model) {
			this.rememberAuthoritativeControl(
				this._state.model,
				this._state.thinkingLevel as ThinkingLevelValue,
			);
		} else {
			this._lastAuthoritativeControl = undefined;
		}

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

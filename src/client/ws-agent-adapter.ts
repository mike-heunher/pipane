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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { applySyncOps, type SyncOp } from "../shared/jsonl-sync.js";
import { isBackendProtocolFrame } from "../shared/backend-protocol.js";
import { COMPACT_CLIENT_TIMEOUT_MS } from "../shared/rpc-timeouts.js";
import type { ToolCallTimings } from "../shared/tool-runtime.js";
import type { UpdateTarget } from "../shared/updates.js";
import {
	assertNever,
	decodeServerMessage,
	decodeSessionStateJson,
	encodeClientCommand,
	type ClientCommandPayload,
	type ClientCommandType,
	type CommandResponseData,
	type ProtocolDecodeError,
	type SessionStats,
	type SessionSyncMessage,
	type SlashCommandInfo,
} from "../shared/ws-protocol.js";
import {
	clampThinkingLevel,
	modelsMatch,
	toCompactModelRef,
	type ThinkingLevelValue,
} from "../shared/thinking-levels.js";
import type {
	BackendClient,
	BackendClientState,
	PiInstallRequiredInfo,
	SessionInfoDTO,
	SessionStatus,
} from "./backend-client.js";
import { HttpBackendApi, type BackendApi } from "./backend-api.js";
import type { ConnectionDiagnostics, FrameTransport } from "./frame-transport.js";
import { PIPANE_SLASH_COMMANDS } from "./slash-commands.js";
import {
	WebSocketFrameTransport,
	type WebSocketLike,
} from "./websocket-frame-transport.js";

export type {
	BackendClientState as AdapterState,
	PiInstallRequiredInfo,
	SessionInfoDTO,
	SessionStatus,
} from "./backend-client.js";
export type AdapterSocket = WebSocketLike;

const PROVIDER_USAGE_STATUS_KEY = "provider-usage";

function usageProviderForModel(model: any): string | undefined {
	const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
	if (provider.includes("codex")) return "codex";
	if (provider.includes("anthropic")) return "anthropic";
	return undefined;
}

type SessionSyncChanges = {
	content: boolean;
	status: boolean;
	steering: boolean;
};

type ScopedSessionSync = SessionSyncMessage & {
	__sessionPath: string;
	__sessionNonce: number;
};

interface PendingRequest {
	command: ClientCommandType;
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

interface CompactionQueuedPrompt {
	text: string;
	images?: ImageContent[];
	model: NonNullable<ReturnType<typeof toCompactModelRef>>;
	thinkingLevel: ThinkingLevelValue;
	controlRevision: number;
}

export interface WsAgentAdapterOptions {
	/** Carrier override for WebRTC and deterministic transport tests. */
	transport?: FrameTransport;
	/** Existing WebSocket for legacy deterministic tests. */
	socket?: AdapterSocket;
	createWebSocket?: (url: string) => AdapterSocket;
	/** Semantic request client; fetch remains as a compatibility shortcut for tests. */
	api?: BackendApi;
	fetch?: typeof globalThis.fetch;
	requestFrame?: (callback: FrameRequestCallback) => number;
}

export class WsAgentAdapter implements BackendClient {
	private readonly transport: FrameTransport;
	private readonly api: BackendApi;
	private readonly requestFrame: (callback: FrameRequestCallback) => number;
	private sessionsChangedListeners = new Set<(file: string) => void>();
	private piInstallRequiredListeners = new Set<(info: PiInstallRequiredInfo) => void>();
	private pendingRequests = new Map<string, PendingRequest>();
	private requestId = 0;
	private _connectionListeners = new Set<(connected: boolean) => void>();

	private _state: BackendClientState = {
		model: undefined as any,
		thinkingLevel: "off",
		messages: [],
		isStreaming: false,
		error: undefined,
	};

	/**
	 * Pending tool call IDs — kept as a simple set for query by tool renderers.
	 * Populated from the server's session_sync state.
	 */
	private _pendingToolCallIds = new Set<string>();
	private _toolCallTimings: ToolCallTimings = {};

	// ── Steering queue (per-session) ───────────────────────────────────────
	/** Per-session steering queues keyed by session path. */
	private _steeringQueues = new Map<string, string[]>();
	/** Prompts accepted locally while manual compaction owns the Pi process. */
	private _compactionQueues = new Map<string, CompactionQueuedPrompt[]>();
	private _compactingSessions = new Set<string>();
	private _steeringQueueListeners = new Set<() => void>();
	/** Complete extension status snapshot for the current session. */
	private _extensionStatuses = new Map<string, string>();
	/** Latest account-wide subscription usage, retained across conversations. */
	private _providerUsageStatuses = new Map<string, string>();
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
	/** Inactive workspace hosts retain status events without streaming full session snapshots. */
	private _sessionSubscriptionActive = true;
	/** Browser-only command output retained across a following authoritative sync. */
	private _localAssistantMessages: AgentMessage[] = [];

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
	/** Last applied authoritative session revision. */
	private _syncRevision: number | undefined;
	/** Scope currently waiting for a recovery/initial full snapshot. */
	private _awaitingFullSync: { sessionPath: string; sessionNonce: number } | undefined;

	// ── session_sync frame queue ──────────────────────────────────────────
	/** Ordered operations waiting to be applied; deltas are hash-dependent. */
	private _pendingSessionSyncs: ScopedSessionSync[] = [];
	/** True when a frame callback has been scheduled to flush session_sync. */
	private _sessionSyncFlushScheduled = false;
	/** True while applySessionSync is running to prevent concurrent flushes. */
	private _sessionSyncFlushInProgress = false;

	private _sessionListeners = new Set<() => void>();
	private _contentListeners = new Set<() => void>();
	private _statusListeners = new Set<() => void>();

	constructor(options: WsAgentAdapterOptions = {}) {
		this.transport = options.transport ?? new WebSocketFrameTransport({
			socket: options.socket,
			createWebSocket: options.createWebSocket,
		});
		this.api = options.api ?? new HttpBackendApi({ fetch: options.fetch });
		this.requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
		this.transport.onFrame((frame) => this.handleMessage(frame));
		this.transport.onConnectionChange((event) => this.handleTransportConnectionChange(event.connected, event.reconnected));
	}

	get state(): BackendClientState { return this._state; }
	get sessionId(): string { return this._sessionId; }
	get sessionFile(): string | undefined { return this._sessionPath; }
	get sessionName(): string | undefined { return this._sessionName; }
	get sessionStatus(): SessionStatus { return this._sessionStatus; }
	get isConnected(): boolean { return this.transport.isConnected; }
	get isReconnecting(): boolean { return this.transport.isReconnecting; }

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

	get toolCallTimings(): Readonly<ToolCallTimings> {
		return this._toolCallTimings;
	}

	get steeringQueue(): readonly string[] {
		if (!this._sessionPath) return [];
		const steering = this._steeringQueues.get(this._sessionPath) ?? [];
		const afterCompaction = this._compactionQueues.get(this._sessionPath) ?? [];
		if (afterCompaction.length === 0) return steering;
		return [...steering, ...afterCompaction.map((prompt) => prompt.text)];
	}

	get extensionStatuses(): ReadonlyMap<string, string> {
		const statuses = new Map(this._extensionStatuses);
		const modelProvider = usageProviderForModel(this._state.model);
		const providerUsage = modelProvider
			? this._providerUsageStatuses.get(modelProvider)
			: this._providerUsageStatuses.size === 1
				? this._providerUsageStatuses.values().next().value
				: undefined;
		if (providerUsage) statuses.set(PROVIDER_USAGE_STATUS_KEY, providerUsage);
		return statuses;
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

	private replaceProviderUsageStatuses(statuses: unknown): void {
		const next = new Map<string, string>();
		if (statuses && typeof statuses === "object" && !Array.isArray(statuses)) {
			for (const [key, value] of Object.entries(statuses)) {
				if (typeof value === "string") next.set(key, value);
			}
		}
		if (next.size === this._providerUsageStatuses.size
			&& [...next].every(([key, value]) => this._providerUsageStatuses.get(key) === value)) return;
		this._providerUsageStatuses = next;
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
	 * The server remains authoritative and can overwrite it via session_sync.
	 */
	private enqueueSteering(sessionPath: string, message: string) {
		const queue = this._steeringQueues.get(sessionPath) ?? [];
		this._steeringQueues.set(sessionPath, [...queue, message]);
		this.emitSteeringQueueChange();
	}

	private enqueueCompactionPrompt(
		sessionPath: string,
		text: string,
		images: ImageContent[] | undefined,
	): void {
		const model = toCompactModelRef(this._state.model);
		if (!model) throw new Error("BUG: active model has no provider/model ID");
		const queue = this._compactionQueues.get(sessionPath) ?? [];
		this._compactionQueues.set(sessionPath, [...queue, {
			text,
			images,
			model,
			thinkingLevel: this._state.thinkingLevel as ThinkingLevelValue,
			controlRevision: this._pendingControl?.revision ?? this._controlRevision,
		}]);
		this.emitSteeringQueueChange();
	}

	private flushCompactionQueue(sessionPath: string): void {
		const queue = this._compactionQueues.get(sessionPath);
		if (!queue?.length) return;

		this._compactionQueues.delete(sessionPath);
		this.emitSteeringQueueChange();

		// Send every queued item as a prompt in its original order. The server's
		// serialized SessionActor starts the first turn and converts later prompt
		// commands that arrive during startup into steering, matching normal rapid
		// submissions without trying to steer a process that is still compacting.
		const submissions = queue.map((prompt) => this.send({
			type: "prompt",
			sessionPath,
			message: prompt.text,
			model: prompt.model,
			thinkingLevel: prompt.thinkingLevel,
			controlRevision: prompt.controlRevision,
			images: prompt.images,
		}));
		void Promise.allSettled(submissions).then((results) => {
			const failed = queue.filter((_, index) => results[index]?.status === "rejected");
			if (failed.length === 0) return;
			const pending = this._compactionQueues.get(sessionPath) ?? [];
			this._compactionQueues.set(sessionPath, [...failed, ...pending]);
			this.emitSteeringQueueChange();
		});
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

	async connect(endpoint: string): Promise<void> {
		await this.transport.connect(endpoint);

		// When the tab regains focus, sync state in case events were missed
		// or updates didn't render while backgrounded.
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				this.syncStateOnFocus();
			}
		});
	}

	disconnect(): void {
		this.transport.close();
	}

	async setSessionSubscriptionActive(active: boolean): Promise<void> {
		if (active === this._sessionSubscriptionActive) return;
		this._sessionSubscriptionActive = active;
		this._sessionNonce++;
		this._awaitingFullSync = undefined;
		this.clearSessionSyncQueue();
		if (!active) {
			await this.subscribeToSession(undefined);
			return;
		}
		if (this._sessionPath && this._sessionStatus !== "virtual") {
			await this.requestFullSessionSync(this._sessionPath);
		}
	}

	getConnectionDiagnostics(): Promise<ConnectionDiagnostics | undefined> {
		return this.transport.getConnectionDiagnostics?.() ?? Promise.resolve(undefined);
	}

	private handleTransportConnectionChange(connected: boolean, reconnected: boolean): void {
		if (connected) {
			if (!reconnected) this._sessionStatus = "virtual";
			else this.onReconnected();
		} else {
			this.handleTransportDisconnected();
		}
		this.emitConnectionChange(connected);
	}

	private handleTransportDisconnected(): void {
		// Requests written to the old carrier can never receive a response.
		for (const pending of this.pendingRequests.values()) {
			pending.reject(new Error("Backend transport disconnected"));
		}
		this.pendingRequests.clear();

		// A sent edit may have failed before its acknowledgement; allow the
		// reconnect snapshot to restore truth. Keep genuinely unsent edits.
		if (this._pendingControl?.phase === "sent") {
			this.rollbackSentControl(this._pendingControl.revision);
		} else if (this._pendingControl?.phase === "acknowledged") {
			this._pendingControl = undefined;
		}
	}

	/**
	 * Called after a successful reconnect. Re-subscribes to the current
	 * session and refreshes session statuses so the UI is up-to-date.
	 */
	private async onReconnected() {
		// Re-subscribe to the current session to get fresh state
		if (this._sessionSubscriptionActive && this._sessionPath && this._sessionStatus !== "virtual") {
			// A request associated with the old socket can never complete here.
			this._awaitingFullSync = undefined;
			void this.requestFullSessionSync(this._sessionPath);
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
		if (this._sessionSubscriptionActive && this._sessionPath && this._sessionStatus !== "virtual") {
			this.subscribeToSession(this._sessionPath);
		}

		if (this._sessionStatus === "detached" && this._state.isStreaming) {
			// Session is detached (server says turn is done) but we still
			// think we're streaming — clear the stale state.
			console.log("[ws-adapter] Tab regained focus: clearing stale streaming state");
			this._state.isStreaming = false;
			this._pendingToolCallIds.clear();
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

	/** Reset the sync base and request exactly one authoritative full snapshot. */
	private async requestFullSessionSync(sessionPath: string): Promise<void> {
		const scope = { sessionPath, sessionNonce: this._sessionNonce };
		if (this._awaitingFullSync?.sessionPath === scope.sessionPath
			&& this._awaitingFullSync.sessionNonce === scope.sessionNonce) return;

		this._awaitingFullSync = scope;
		this._syncJson = "";
		this._syncHash = "";
		this._syncRevision = undefined;
		this.clearSessionSyncQueue();
		await this.subscribeToSession(sessionPath);
	}

	private handleProtocolError(error: ProtocolDecodeError): void {
		const message = `Protocol error: ${error.message}`;
		console.error(`[ws-adapter] ${message}`);
		this._state.error = message;
		this.emitStatusChange();
		if (error.code === "unsupported_version") this.transport.close(1002, "Unsupported protocol version");
	}

	private handleMessage(raw: string): void {
		// Semantic v2 responses share authenticated DataChannels with application v1.
		if (isBackendProtocolFrame(raw)) return;
		const decoded = decodeServerMessage(raw);
		if (!decoded.ok) {
			this.handleProtocolError(decoded.error);
			return;
		}

		const data = decoded.value;
		switch (data.type) {
			case "response": {
				if (!data.success && data.id === null) {
					this._state.error = data.error;
					this.emitStatusChange();
					return;
				}
				if (data.id === null) return;
				const pending = this.pendingRequests.get(data.id);
				if (!pending) return;
				this.pendingRequests.delete(data.id);
				if (data.command !== pending.command) {
					pending.reject(new Error(
						`Mismatched response for ${pending.command}: received ${data.command}`,
					));
					return;
				}
				if (data.success) {
					pending.resolve(data.data);
				} else {
					this._state.error = data.error;
					this.emitStatusChange();
					pending.reject(new Error(data.error));
				}
				return;
			}
			case "pi_install_required":
				this.emitPiInstallRequired({
					command: data.command,
					installable: data.installable,
					installing: data.installing,
					message: data.message,
				});
				return;
			case "init":
				this.setAllSessionStatuses(data.sessionStatuses);
				this.replaceProviderUsageStatuses(data.providerUsageStatuses);
				this._steeringQueues.clear();
				for (const [sessionPath, queue] of Object.entries(data.steeringQueues)) {
					if (queue.length > 0) this._steeringQueues.set(sessionPath, [...queue]);
				}
				this.emitSteeringQueueChange();
				return;
			case "session_status_change":
				this.setGlobalSessionStatus(data.sessionPath, data.status);
				return;
			case "provider_usage":
				this.replaceProviderUsageStatuses(data.statuses);
				return;
			case "extension_status":
				if (data.sessionPath === this._sessionPath) this.replaceExtensionStatuses(data.statuses);
				return;
			case "session_sync":
				if (data.sessionPath !== this._sessionPath) return;
				this.enqueueSessionSync({
					...data,
					__sessionPath: data.sessionPath,
					__sessionNonce: this._sessionNonce,
				});
				return;
			case "control_state": {
				if (data.sessionPath !== this._sessionPath) return;
				const applied = this.applyAuthoritativeControlState(
					data.model,
					data.thinkingLevel,
					data.controlRevision,
				);
				if (applied) this.emitContentChange();
				return;
			}
			case "session_attached": {
				this.setGlobalSessionStatus(data.sessionPath, "running");
				if (data.cwd) this._pendingCwd = data.cwd;
				const shouldAdopt = data.sessionPath === this._sessionPath
					|| (this._sessionStatus === "virtual" && this._pendingNewPrompt);
				if (shouldAdopt) {
					const adoptedVirtualSession = this._sessionStatus === "virtual";
					if (adoptedVirtualSession) {
						this._sessionPath = data.sessionPath;
						const filename = path.basename(data.sessionPath, ".jsonl");
						const parts = filename.split("_");
						this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
						this._startingPrompts.get(`virtual:${this._sessionNonce}`)?.resolveReady(data.sessionPath);
					}
					this._sessionStatus = "attached";
					this._state.isStreaming = true;
					void this.requestFullSessionSync(data.sessionPath);
					this.emitStatusChange();
				}
				if (!this._optimisticSessions.has(data.sessionPath)) {
					const now = new Date().toISOString();
					const filename = path.basename(data.sessionPath, ".jsonl");
					const parts = filename.split("_");
					const id = parts.length > 1 ? parts.slice(1).join("_") : filename;
					this._optimisticSessions.set(data.sessionPath, {
						id,
						path: data.sessionPath,
						cwd: data.cwd ?? "",
						created: now,
						modified: now,
						lastUserPromptTime: now,
						messageCount: 1,
						firstMessage: data.firstMessage ?? "(new session)",
					});
				}
				if (shouldAdopt) this.emitSessionChange();
				return;
			}
			case "sessions_changed":
				for (const listener of this.sessionsChangedListeners) listener(data.file);
				return;
			default:
				assertNever(data);
		}
	}

	/**
	 * Queue hash-dependent sync operations for the next frame. A newer full
	 * snapshot supersedes queued history, but every delta after that full must be
	 * retained and applied in order because its baseHash depends on the prior op.
	 */
	private enqueueSessionSync(syncMsg: ScopedSessionSync): void {
		const awaitingThisScope = this._awaitingFullSync !== undefined
			&& this._awaitingFullSync.sessionPath === syncMsg.__sessionPath
			&& this._awaitingFullSync.sessionNonce === syncMsg.__sessionNonce;
		if (syncMsg.op === "full") {
			if (awaitingThisScope) this._awaitingFullSync = undefined;
			this._pendingSessionSyncs = [syncMsg];
		} else {
			// Deltas already in flight before the server processes our recovery
			// subscription have no usable base. Drop them without requesting again.
			if (awaitingThisScope) return;
			this._pendingSessionSyncs.push(syncMsg);
		}
		if (this._sessionSyncFlushScheduled || this._sessionSyncFlushInProgress) return;
		this._sessionSyncFlushScheduled = true;

		this.requestFrame(() => {
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
				this.requestFrame(() => {
					this._sessionSyncFlushScheduled = false;
					this.flushSessionSyncQueue();
				});
			}
		}
	}


	private emitSessionSyncChanges(changes: SessionSyncChanges) {
		if (changes.steering) this.emitSteeringQueueChange();
		if (changes.content) this.emitContentChange();
		if (changes.status) this.emitStatusChange();
	}

	private async applySessionSyncBatch(syncMessages: ScopedSessionSync[]): Promise<SessionSyncChanges | undefined> {
		const syncSessionPath = this._sessionPath;
		const syncSessionNonce = this._sessionNonce;
		if (!syncSessionPath || syncMessages.length === 0) return;
		if (syncMessages.some((message) =>
			message.__sessionPath !== syncSessionPath || message.__sessionNonce !== syncSessionNonce
		)) return;

		let nextRevision = this._syncRevision;
		for (const message of syncMessages) {
			if (message.op === "full") {
				nextRevision = message.revision;
				continue;
			}
			if (nextRevision === undefined || message.revision !== nextRevision + 1) {
				console.error("[ws-adapter] Session revision gap, re-subscribing", {
					expected: nextRevision === undefined ? "full snapshot" : nextRevision + 1,
					actual: message.revision,
				});
				void this.requestFullSessionSync(syncSessionPath);
				return;
			}
			nextRevision = message.revision;
		}

		const syncOps: SyncOp[] = syncMessages.map((syncMessage) => syncMessage.op === "full"
			? { op: "full", data: syncMessage.data, hash: syncMessage.hash }
			: {
				op: "delta",
				patches: syncMessage.patches,
				hash: syncMessage.hash,
				baseHash: syncMessage.baseHash,
			});

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
			void this.requestFullSessionSync(syncSessionPath);
			return;
		}

		// Parse and validate only the final state in the batch. Intermediate
		// hash-chain states were never observable between animation frames.
		const decodedState = decodeSessionStateJson(result.data);
		if (!decodedState.ok) {
			this.handleProtocolError(decodedState.error);
			return;
		}
		const state = decodedState.value;

		this._syncJson = result.data;
		this._syncHash = result.hash;
		this._syncRevision = nextRevision;

		const previousStreaming = this._state.isStreaming;
		const previousSessionStatus = this._sessionStatus;
		const previousError = this._state.error;
		const previousSteering = [...(this._steeringQueues.get(syncSessionPath) ?? [])];

		// The server sends a flat messages array with everything merged in. Browser
		// slash-command output is not in JSONL, so retain it across a sync that was
		// already in flight when the command response arrived.
		this._state.messages = [...(state.messages ?? []), ...this._localAssistantMessages];
		this._state.isStreaming = state.isStreaming ?? false;
		if (this._sessionStatus !== "virtual") {
			this._sessionStatus = this._state.isStreaming ? "attached" : "detached";
		}
		this._pendingToolCallIds = new Set(state.pendingToolCalls ?? []);
		this._toolCallTimings = state.toolCallTimings ?? {};

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


	private send<Payload extends ClientCommandPayload>(
		command: Payload,
	): Promise<CommandResponseData<Payload["type"]>> {
		if (!this.transport.isConnected) {
			return Promise.reject(new Error("Backend transport is not connected"));
		}

		const id = `req_${++this.requestId}`;
		return new Promise<CommandResponseData<Payload["type"]>>((resolve, reject) => {
			const timeoutMs = command.type === "compact"
				? COMPACT_CLIENT_TIMEOUT_MS
				: command.type === "prompt" || command.type === "fork_prompt"
					? 90000
					: 30000;
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				command: command.type,
				resolve: (data) => {
					clearTimeout(timeout);
					resolve(data as CommandResponseData<Payload["type"]>);
				},
				reject: (error) => { clearTimeout(timeout); reject(error); },
			});

			this.transport.send(encodeClientCommand(command, id));
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

		// Browser-only command output is informational and should disappear when the
		// next input is submitted rather than drifting to the bottom of later syncs.
		this.clearLocalAssistantMessages();

		// Handle client-side slash commands
		const handled = await this.handleSlashCommand(text);
		if (handled) return;

		// Pi disconnects its agent loop while manual compaction runs, so steering
		// sent now would be accepted by the browser queue but rejected after the
		// compact command releases the process. Retain the prompt locally and flush
		// it through the regular prompt path as soon as compaction finishes.
		if (this._sessionPath && this._compactingSessions.has(this._sessionPath)) {
			this.enqueueCompactionPrompt(this._sessionPath, text, images);
			return;
		}

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
					void this.requestFullSessionSync(newSessionPath);
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

	/** Fetch slash commands for the active session's project context. */
	async fetchCommands(): Promise<SlashCommandInfo[]> {
		try {
			const context = this._sessionPath
				? { sessionPath: this._sessionPath }
				: { cwd: this._pendingCwd };
			const data = await this.send({ type: "get_commands", ...context });
			return data?.commands ?? [];
		} catch {
			return [];
		}
	}

	private clearLocalAssistantMessages(): void {
		if (this._localAssistantMessages.length === 0) return;
		const localMessages = new Set(this._localAssistantMessages);
		this._localAssistantMessages = [];
		this._state.messages = this._state.messages.filter((message) => !localMessages.has(message));
		this.emitContentChange();
	}

	private appendLocalAssistantMessage(text: string): void {
		const message = {
			role: "assistant",
			content: [{ type: "text", text }],
		} as AgentMessage;
		this._localAssistantMessages.push(message);
		this._state.messages = [...this._state.messages, message];
		this.emitContentChange();
	}

	private formatSessionStats(stats: SessionStats): string {
		const number = (value: number) => value.toLocaleString("en-US");
		const cost = `$${stats.cost.toFixed(stats.cost < 0.01 ? 4 : stats.cost < 1 ? 3 : 2)}`;
		const lines = [
			"**Session information**",
			"",
			`- **File:** \`${stats.sessionFile}\``,
			`- **ID:** \`${stats.sessionId}\``,
			`- **Messages:** ${number(stats.totalMessages)} total (${number(stats.userMessages)} user, ${number(stats.assistantMessages)} assistant)`,
			`- **Tools:** ${number(stats.toolCalls)} calls, ${number(stats.toolResults)} results`,
			`- **Tokens:** ${number(stats.tokens.total)} total (${number(stats.tokens.input)} input, ${number(stats.tokens.output)} output, ${number(stats.tokens.cacheRead)} cache read, ${number(stats.tokens.cacheWrite)} cache write)`,
			`- **Cost:** ${cost}`,
		];
		if (stats.contextUsage) {
			const context = stats.contextUsage.tokens === null
				? `unknown / ${number(stats.contextUsage.contextWindow)}`
				: `${number(stats.contextUsage.tokens)} / ${number(stats.contextUsage.contextWindow)}${stats.contextUsage.percent === null ? "" : ` (${stats.contextUsage.percent}%)`}`;
			lines.push(`- **Context:** ${context}`);
		}
		return lines.join("\n");
	}

	private async showSessionMessage(): Promise<void> {
		if (!this._sessionPath) {
			this.appendLocalAssistantMessage("No active session yet. Send a message first to create one.");
			return;
		}
		const stats = await this.send({ type: "get_session_stats", sessionPath: this._sessionPath });
		this.appendLocalAssistantMessage(this.formatSessionStats(stats));
	}

	private async showHelpMessage() {
		const lines: string[] = [
			"**Built-in commands:**",
			"",
			"| Command | Description |",
			"|---------|-------------|",
			...PIPANE_SLASH_COMMANDS.map((command) => {
				const usage = command.argumentHint ? ` ${command.argumentHint}` : "";
				return `| \`/${command.name}${usage}\` | ${command.description} |`;
			}),
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

		this.appendLocalAssistantMessage(lines.join("\n"));
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

		if (trimmed === "/session") {
			await this.showSessionMessage();
			return true;
		}

		if (trimmed === "/fork") {
			// Handled by the UI layer (main.ts) — emit a custom event
			window.dispatchEvent(new CustomEvent("pi-fork-request"));
			return true;
		}

		if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
			if (!this._sessionPath) return true;
			const sessionPath = this._sessionPath;
			const customInstructions = trimmed.startsWith("/compact ") ? trimmed.slice(9).trim() : undefined;
			// Show a loading indicator while compaction runs (LLM summarization can take a while)
			const placeholder = {
				role: "compactionSummary",
				summary: "",
				tokensBefore: 0,
				timestamp: Date.now(),
				_compacting: true,
			} as any;
			this._compactingSessions.add(sessionPath);
			this._state.isStreaming = true;
			this._state.messages = [...this._state.messages, placeholder];
			this.emitStatusChange();
			this.emitContentChange();
			try {
				await this.send({ type: "compact", sessionPath, customInstructions });
				// Re-subscribe to get fresh messages after compaction when the user is
				// still viewing this conversation.
				if (this._sessionPath === sessionPath) await this.subscribeToSession(sessionPath);
			} catch (error) {
				// Do not leave an optimistic "compacting…" row spinning forever when
				// the command fails before an authoritative snapshot replaces it.
				this._state.messages = this._state.messages.filter((message) => message !== placeholder);
				this.emitContentChange();
				throw error;
			} finally {
				this._compactingSessions.delete(sessionPath);
				if (this._sessionPath === sessionPath) {
					this._state.isStreaming = false;
					this.emitStatusChange();
				}
				// A failed compaction also leaves Pi idle, so queued work remains valid
				// and must not disappear with the detached-session snapshot.
				this.flushCompactionQueue(sessionPath);
			}
			return true;
		}

		if (trimmed.startsWith("/name ")) {
			const name = trimmed.slice(6).trim();
			if (!name) return true;
			if (!this._sessionPath) {
				this.appendLocalAssistantMessage("Cannot set name: no active session. Send a message first.");
				return true;
			}
			try {
				await this.send({ type: "set_session_name", sessionPath: this._sessionPath, name });
				this._sessionName = name;
				this.appendLocalAssistantMessage(`Session renamed to **${name}**`);
				this.emitSessionChange();
			} catch (err: any) {
				this.appendLocalAssistantMessage(`Failed to rename session: ${err?.message || "unknown error"}`);
			}
			return true;
		}

		if (trimmed === "/reload") {
			try {
				const data = await this.send({ type: "reload_processes" });
				const killed = data?.killed ?? 0;
				const draining = data?.draining ?? 0;
				this.appendLocalAssistantMessage(`Reload requested: killed ${killed} idle process(es), draining ${draining} running process(es).`);
			} catch (err: any) {
				this.appendLocalAssistantMessage(`Failed to reload pi processes: ${err?.message || "unknown error"}`);
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

	hardKill() {
		if (this._sessionPath) {
			this.send({ type: "hard_kill", sessionPath: this._sessionPath }).catch(() => {});
		}
	}

	steer(m: AgentMessage) {
		const text = this.extractText(m);
		if (!text || !this._sessionPath) return;
		if (this._compactingSessions.has(this._sessionPath)) {
			this.enqueueCompactionPrompt(this._sessionPath, text, undefined);
			return;
		}
		// Only steer if the current session is actually running (not some other session)
		const isRunning = this._globalSessionStatus.get(this._sessionPath) === "running";
		if (!isRunning) return;
		this.enqueueSteering(this._sessionPath, text);
		this.send({ type: "steer", sessionPath: this._sessionPath, message: text }).catch(console.error);
	}

	removeSteering(index: number) {
		if (!this._sessionPath) return;
		const sessionPath = this._sessionPath;
		const steeringCount = this._steeringQueues.get(sessionPath)?.length ?? 0;
		if (index >= steeringCount) {
			const queue = this._compactionQueues.get(sessionPath) ?? [];
			const compactionIndex = index - steeringCount;
			if (compactionIndex < 0 || compactionIndex >= queue.length) return;
			const next = queue.filter((_, itemIndex) => itemIndex !== compactionIndex);
			if (next.length > 0) this._compactionQueues.set(sessionPath, next);
			else this._compactionQueues.delete(sessionPath);
			this.emitSteeringQueueChange();
			return;
		}
		this.send({ type: "remove_steering", sessionPath, index }).catch(console.error);
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


	// ── Fork ───────────────────────────────────────────────────────────────

	/** Get user messages from the current session for the fork selector. */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		if (!this._sessionPath) return [];
		return this.listForkMessages(this._sessionPath);
	}

	listForkMessages(sessionPath: string) {
		return this.api.listForkMessages(sessionPath);
	}

	browseDirectory(path: string) {
		return this.api.browseDirectory(path);
	}

	createDirectory(parentPath: string, name: string) {
		return this.api.createDirectory(parentPath, name);
	}

	getRawSession(sessionPath: string) {
		return this.api.getRawSession(sessionPath);
	}

	getFileContent(sessionPath: string, path: string) {
		return this.api.getFileContent(sessionPath, path);
	}

	createFileUpload(metadata: Parameters<BackendApi["createFileUpload"]>[0]) {
		return this.api.createFileUpload(metadata);
	}

	appendFileUpload(chunk: Parameters<BackendApi["appendFileUpload"]>[0]) {
		return this.api.appendFileUpload(chunk);
	}

	completeFileUpload(uploadId: string) {
		return this.api.completeFileUpload(uploadId);
	}

	getLocalSettings() {
		return this.api.getLocalSettings();
	}

	validateLocalSettings(content: string) {
		return this.api.validateLocalSettings(content);
	}

	patchLocalSettings(patch: Record<string, unknown>) {
		return this.api.patchLocalSettings(patch);
	}

	saveLocalSettings(content: string) {
		return this.api.saveLocalSettings(content);
	}

	getUpdates() {
		return this.api.getUpdates();
	}

	runUpdate(target: UpdateTarget) {
		return this.api.runUpdate(target);
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
		let data: CommandResponseData<"fork_prompt">;
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
		const sessions = await this.api.listSessions();

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
		await this.api.deleteSession(sessionPath);
	}

	/** Switch to an existing session (load messages from server cache) */
	async switchSession(sessionPath: string, cwd?: string): Promise<void> {
		this._sessionSubscriptionActive = true;
		const nonce = ++this._sessionNonce;
		if (cwd !== undefined) this._pendingCwd = cwd;
		this._pendingNewPrompt = false;
		this._pendingControl = undefined;
		this._lastAuthoritativeControl = undefined;
		this._sessionPath = sessionPath;
		this._localAssistantMessages = [];
		this.clearExtensionStatuses();
		// Extract session ID from filename
		const filename = path.basename(sessionPath, ".jsonl");
		const parts = filename.split("_");
		this._sessionId = parts.length > 1 ? parts.slice(1).join("_") : filename;
		this._sessionStatus = "detached";

		// Clear current state — including isStreaming since a detached session is never streaming
		this._state.messages = [];
		this._state.isStreaming = false;
		this._pendingToolCallIds.clear();
		this._toolCallTimings = {};
		this._awaitingFullSync = undefined;
		this._state.error = undefined;

		// Subscribe to this session on the server — it will push session_sync
		// with the full state.
		await this.requestFullSessionSync(sessionPath);
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
		this._sessionSubscriptionActive = true;
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
		this._localAssistantMessages = [];
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
		this._pendingToolCallIds.clear();
		this._toolCallTimings = {};
		this._syncJson = "";
		this._syncHash = "";
		this._syncRevision = undefined;
		this._awaitingFullSync = undefined;
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

/**
 * Mock WsAgentAdapter for testing.
 *
 * Provides controllable session data, status tracking, and event emission
 * without requiring a real WebSocket connection or pi-mono backend.
 */

import type { SessionInfoDTO } from "../client/ws-agent-adapter.js";

export type SessionStatusValue = "running" | "done" | undefined;

export class MockAgent {
	// ── Session state ──────────────────────────────────────────────────────
	private _sessionId = "test-session-1";
	private _sessions: SessionInfoDTO[] = [];
	private _sessionStatuses = new Map<string, "running" | "done">();

	// ── Event listeners ────────────────────────────────────────────────────
	private _sessionChangeListeners = new Set<() => void>();
	private _sessionsChangedListeners = new Set<(file: string) => void>();
	private _globalStatusListeners = new Set<() => void>();
	private _statusChangeListeners = new Set<() => void>();
	private _sessionStatus: "virtual" | "attached" | "detached" = "virtual";

	// ── Public API (matches WsAgentAdapter interface used by session-picker) ──

	get sessionId(): string {
		return this._sessionId;
	}

	set sessionId(id: string) {
		this._sessionId = id;
	}

	getSessionStatus(sessionPath: string): "running" | "done" | undefined {
		return this._sessionStatuses.get(sessionPath);
	}

	onSessionChange(fn: () => void): () => void {
		this._sessionChangeListeners.add(fn);
		return () => this._sessionChangeListeners.delete(fn);
	}

	onSessionsChanged(fn: (file: string) => void): () => void {
		this._sessionsChangedListeners.add(fn);
		return () => this._sessionsChangedListeners.delete(fn);
	}

	onGlobalStatusChange(fn: () => void): () => void {
		this._globalStatusListeners.add(fn);
		return () => this._globalStatusListeners.delete(fn);
	}

	get sessionStatus(): "virtual" | "attached" | "detached" {
		return this._sessionStatus;
	}

	set sessionStatus(status: "virtual" | "attached" | "detached") {
		this._sessionStatus = status;
	}

	onStatusChange(fn: () => void): () => void {
		this._statusChangeListeners.add(fn);
		return () => this._statusChangeListeners.delete(fn);
	}

	async listSessions(): Promise<SessionInfoDTO[]> {
		return this._sessions;
	}

	async switchSession(_sessionPath: string): Promise<void> {
		// no-op in mock
	}

	async newSession(_cwd?: string): Promise<void> {
		// no-op in mock
	}

	async deleteSession(_sessionPath: string): Promise<void> {
		// no-op in mock
	}

	// ── Test helpers ───────────────────────────────────────────────────────

	/** Set the sessions that listSessions() will return. */
	setSessions(sessions: SessionInfoDTO[]) {
		this._sessions = sessions;
	}

	/** Set the status for a session path. */
	setSessionStatus(sessionPath: string, status: "running" | "done") {
		this._sessionStatuses.set(sessionPath, status);
	}

	/** Clear the status for a session path. */
	clearSessionStatus(sessionPath: string) {
		this._sessionStatuses.delete(sessionPath);
	}

	/** Clear all session statuses. */
	clearAllStatuses() {
		this._sessionStatuses.clear();
	}

	/** Emit a session change event (triggers sidebar reload). */
	emitSessionChange() {
		for (const fn of this._sessionChangeListeners) fn();
	}

	/** Emit a sessions-changed event (triggers sidebar reload). */
	emitSessionsChanged(file = "") {
		for (const fn of this._sessionsChangedListeners) fn(file);
	}

	/** Emit a global status change event (triggers status badge re-render). */
	emitGlobalStatusChange() {
		for (const fn of this._globalStatusListeners) fn();
	}

	/** Emit a status change event (triggers status-dependent UI updates). */
	emitStatusChange() {
		for (const fn of this._statusChangeListeners) fn();
	}
}

// ── Session factory helpers ────────────────────────────────────────────────

let sessionCounter = 0;

export interface SessionOptions {
	id?: string;
	name?: string;
	cwd?: string;
	firstMessage?: string;
	messageCount?: number;
	created?: string;
	modified?: string;
	lastUserPromptTime?: string;
}

/**
 * Create a SessionInfoDTO with sensible defaults.
 * Each call generates a unique id/path unless overridden.
 */
export function createSession(opts: SessionOptions = {}): SessionInfoDTO {
	sessionCounter++;
	const id = opts.id ?? `session-${sessionCounter}`;
	const cwd = opts.cwd ?? "/home/user/project";
	return {
		id,
		path: `${cwd}/.pi/sessions/${id}.jsonl`,
		cwd,
		name: opts.name,
		created: opts.created ?? "2026-02-28T10:00:00.000Z",
		modified: opts.modified ?? "2026-02-28T11:00:00.000Z",
		lastUserPromptTime: opts.lastUserPromptTime,
		messageCount: opts.messageCount ?? 5,
		firstMessage: opts.firstMessage ?? `First message of ${id}`,
	};
}

/** Reset the session counter (call in beforeEach). */
export function resetSessionCounter() {
	sessionCounter = 0;
}

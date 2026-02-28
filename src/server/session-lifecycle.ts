/**
 * Session lifecycle state machine.
 *
 * Single source of truth for session→process mappings, session status,
 * and steering queues. Enforces legal state transitions and emits typed events.
 *
 * States per session:
 *   (absent)  → session has never been tracked
 *   "running" → a pi process is attached and executing a turn
 *   "done"    → pi process was attached at some point and has since detached
 *
 * Transitions:
 *   attach(sessionPath, proc)  → sets "running"
 *   detach(sessionPath)        → sets "done", clears proc mapping
 *   crash(sessionPath)         → sets "done", clears proc mapping (for unexpected exits)
 */

export interface LifecycleProcess {
	id: number;
	[key: string]: any;
}

export type SessionState = "running" | "done";

export type LifecycleEvent =
	| { type: "session_attached"; sessionPath: string; procId: number }
	| { type: "session_detached"; sessionPath: string; procId: number }
	| { type: "status_change"; sessionPath: string; status: SessionState }
	| { type: "steering_queue_update"; sessionPath: string; queue: string[] };

export type LifecycleEventListener = (event: LifecycleEvent) => void;

export class SessionLifecycle {
	/** session path → attached process */
	private attached = new Map<string, LifecycleProcess>();
	/** session path → "running" | "done" (persists for server lifetime) */
	private statuses = new Map<string, SessionState>();
	/** session path → queued steering messages */
	private steeringQueues = new Map<string, string[]>();
	private listeners = new Set<LifecycleEventListener>();

	// ── Event subscription ───────────────────────────────────────────────

	subscribe(fn: LifecycleEventListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(event: LifecycleEvent) {
		for (const fn of this.listeners) fn(event);
	}

	// ── State queries ────────────────────────────────────────────────────

	getAttachedProcess(sessionPath: string): LifecycleProcess | undefined {
		return this.attached.get(sessionPath);
	}

	getAllStatuses(): Record<string, SessionState> {
		const result: Record<string, SessionState> = {};
		for (const [k, v] of this.statuses) result[k] = v;
		return result;
	}

	getAttachedSessionForProcess(proc: LifecycleProcess): string | undefined {
		for (const [sessionPath, p] of this.attached) {
			if (p === proc) return sessionPath;
		}
		return undefined;
	}

	get attachedCount(): number {
		return this.attached.size;
	}

	// ── Transitions ──────────────────────────────────────────────────────

	/**
	 * Attach a process to a session. Sets status to "running".
	 * If the session is already attached, returns the existing process (idempotent).
	 */
	attach(sessionPath: string, proc: LifecycleProcess): LifecycleProcess {
		const existing = this.attached.get(sessionPath);
		if (existing) {
			return existing;
		}

		this.attached.set(sessionPath, proc);
		this.statuses.set(sessionPath, "running");

		this.emit({ type: "status_change", sessionPath, status: "running" });
		this.emit({ type: "session_attached", sessionPath, procId: proc.id });

		return proc;
	}

	/**
	 * Detach a process from a session (normal completion). Sets status to "done".
	 * Returns the process that was detached, or undefined if not attached.
	 */
	detach(sessionPath: string): LifecycleProcess | undefined {
		const proc = this.attached.get(sessionPath);
		if (!proc) {
			console.warn(`[lifecycle] detach called for non-attached session: ${sessionPath}`);
			return undefined;
		}

		this.attached.delete(sessionPath);
		this.statuses.set(sessionPath, "done");

		// Clear steering queue on detach
		this.steeringQueues.delete(sessionPath);
		this.emit({ type: "steering_queue_update", sessionPath, queue: [] });

		this.emit({ type: "status_change", sessionPath, status: "done" });
		this.emit({ type: "session_detached", sessionPath, procId: proc.id });

		return proc;
	}

	/**
	 * Handle a process crash while attached to a session.
	 * Same as detach but named differently for clarity in call sites.
	 */
	crash(sessionPath: string): LifecycleProcess | undefined {
		return this.detach(sessionPath);
	}

	// ── Steering queue management ────────────────────────────────────────

	getAllSteeringQueues(): Record<string, string[]> {
		const result: Record<string, string[]> = {};
		for (const [k, v] of this.steeringQueues) {
			if (v.length > 0) result[k] = [...v];
		}
		return result;
	}

	enqueueSteering(sessionPath: string, message: string): void {
		let queue = this.steeringQueues.get(sessionPath);
		if (!queue) {
			queue = [];
			this.steeringQueues.set(sessionPath, queue);
		}
		queue.push(message);
		this.emit({ type: "steering_queue_update", sessionPath, queue: [...queue] });
	}

	/**
	 * Dequeue a steering message by matching its text.
	 * Used when the agent confirms it received a user message.
	 */
	dequeueSteering(sessionPath: string, text: string): boolean {
		const queue = this.steeringQueues.get(sessionPath);
		if (!queue) return false;

		const idx = queue.indexOf(text);
		if (idx === -1) return false;

		queue.splice(idx, 1);
		if (queue.length === 0) {
			this.steeringQueues.delete(sessionPath);
		}
		this.emit({ type: "steering_queue_update", sessionPath, queue: [...(this.steeringQueues.get(sessionPath) ?? [])] });
		return true;
	}

	/**
	 * Remove a steering message by index.
	 */
	removeSteeringByIndex(sessionPath: string, index: number): boolean {
		const queue = this.steeringQueues.get(sessionPath);
		if (!queue || index < 0 || index >= queue.length) return false;

		queue.splice(index, 1);
		if (queue.length === 0) {
			this.steeringQueues.delete(sessionPath);
		}
		this.emit({ type: "steering_queue_update", sessionPath, queue: [...(this.steeringQueues.get(sessionPath) ?? [])] });
		return true;
	}

	/**
	 * Clear all steering messages for a session.
	 */
	clearSteering(sessionPath: string): void {
		if (!this.steeringQueues.has(sessionPath)) return;
		this.steeringQueues.delete(sessionPath);
		this.emit({ type: "steering_queue_update", sessionPath, queue: [] });
	}
}

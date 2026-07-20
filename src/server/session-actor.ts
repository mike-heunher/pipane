import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcProcess, RpcProcessLease } from "./process-pool.js";
import { SessionJsonl } from "./session-jsonl.js";

export type SessionPhase =
	| "detached"
	| "attaching"
	| "ready"
	| "starting"
	| "running"
	| "settling"
	| "releasing"
	| "failed";

export type SessionActorEvent =
	| { type: "phase_change"; phase: SessionPhase }
	| { type: "attached"; proc: RpcProcess }
	| { type: "detached"; proc: RpcProcess }
	| { type: "steering_queue_update"; queue: string[] };

export interface AppliedProcessEvent {
	accepted: boolean;
	changed: boolean;
	started: boolean;
	ended: boolean;
	settled: boolean;
}

const LEGAL_TRANSITIONS: Record<SessionPhase, readonly SessionPhase[]> = {
	detached: ["attaching"],
	attaching: ["ready", "failed", "releasing"],
	ready: ["starting", "releasing", "failed"],
	starting: ["running", "settling", "releasing", "failed"],
	running: ["settling", "releasing", "failed"],
	settling: ["releasing", "failed"],
	releasing: ["detached"],
	failed: ["releasing"],
};

/**
 * Serialized owner of one session's mutable runtime state.
 *
 * Long-running turns do not hold the command mailbox: prompt startup commits the
 * `starting` phase and returns, Pi events are enqueued as internal commands, and
 * final settlement is enqueued separately. This leaves steer/abort responsive
 * while preventing compact/fork/rename from overlapping the turn.
 */
export class SessionActor {
	readonly sessionPath: string;

	private _phase: SessionPhase = "detached";
	private _lease: RpcProcessLease | undefined;
	private _session: SessionJsonl | undefined;
	private _turnGeneration = 0;
	private _steeringQueue: string[] = [];
	private _turnEventCleanup: (() => void) | undefined;
	private commandTail: Promise<void> = Promise.resolve();
	private emitEvent: (event: SessionActorEvent) => void;

	constructor(sessionPath: string, emitEvent: (event: SessionActorEvent) => void) {
		this.sessionPath = sessionPath;
		this.emitEvent = emitEvent;
	}

	get phase(): SessionPhase { return this._phase; }
	get process(): RpcProcess | undefined { return this._lease?.process; }
	get session(): SessionJsonl | undefined { return this._session; }
	get turnGeneration(): number { return this._turnGeneration; }
	get steeringQueue(): readonly string[] { return this._steeringQueue; }
	get isAttached(): boolean { return this._lease !== undefined; }
	get isTurnActive(): boolean {
		return this._phase === "starting" || this._phase === "running" || this._phase === "settling";
	}

	/** Serialize one command or internal event for this session. */
	enqueue<T>(operation: string, fn: () => T | Promise<T>): Promise<T> {
		const run = this.commandTail.then(fn);
		this.commandTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run.catch((error) => {
			if (error instanceof Error) {
				error.message = `[${operation}] ${error.message}`;
			}
			throw error;
		});
	}

	assertAvailable(operation: string): void {
		if (this.isTurnActive) {
			throw new Error(`Cannot ${operation} while session turn is ${this._phase}`);
		}
		if (this._phase !== "detached" && this._phase !== "ready") {
			throw new Error(`Cannot ${operation} while session is ${this._phase}`);
		}
	}

	attach(lease: RpcProcessLease, session: SessionJsonl): void {
		if (this._phase !== "detached" || this._lease) {
			throw new Error(`Session is already owned in phase ${this._phase}`);
		}
		this.transition("attaching");
		this._lease = lease;
		this._session = session;
		this.transition("ready");
		this.emitEvent({ type: "attached", proc: lease.process });
	}

	beginTurn(): number {
		if (this._phase !== "ready" || !this._lease || !this._session) {
			throw new Error(`Cannot start turn while session is ${this._phase}`);
		}
		this._turnGeneration += 1;
		this.transition("starting");
		return this._turnGeneration;
	}

	setTurnEventCleanup(generation: number, cleanup: () => void): void {
		if (generation !== this._turnGeneration || !this.isTurnActive) {
			cleanup();
			return;
		}
		this._turnEventCleanup?.();
		this._turnEventCleanup = cleanup;
	}

	owns(proc: RpcProcess, generation?: number): boolean {
		return this.process === proc && (generation === undefined || generation === this._turnGeneration);
	}

	async applyProcessEvent(
		proc: RpcProcess,
		generation: number,
		event: Record<string, any>,
		replacementMessages?: AgentMessage[],
	): Promise<AppliedProcessEvent> {
		return this.enqueue("process event", () => {
			if (!this.owns(proc, generation) || !this._session) {
				return { accepted: false, changed: false, started: false, ended: false, settled: false };
			}

			let started = false;
			let ended = false;
			let settled = false;
			if (event.type === "agent_start") {
				started = true;
				if (this._phase === "starting") this.transition("running");
			}
			if (event.type === "agent_end") {
				ended = true;
				if (this._phase === "starting" || this._phase === "running") this.transition("settling");
				this.clearSteering();
			}
			if (event.type === "agent_settled") {
				started = true;
				ended = true;
				settled = true;
				if (this._phase === "starting" || this._phase === "running") this.transition("settling");
			}

			let changed = this._session.applyEvent(event as AgentEvent);
			if (replacementMessages) {
				this._session.replaceMessages(replacementMessages);
				changed = true;
			}

			if (event.type === "message_end" && event.message?.role === "user") {
				const text = typeof event.message.content === "string"
					? event.message.content
					: (event.message.content || [])
						.filter((content: any) => content.type === "text")
						.map((content: any) => content.text)
						.join(" ");
				this.dequeueSteering(text);
			}

			return { accepted: true, changed, started, ended, settled };
		});
	}

	enqueueSteering(message: string): void {
		this._steeringQueue = [...this._steeringQueue, message];
		this.syncSteeringQueue();
	}

	removeSteeringByIndex(index: number): boolean {
		if (index < 0 || index >= this._steeringQueue.length) return false;
		this._steeringQueue = this._steeringQueue.filter((_, itemIndex) => itemIndex !== index);
		this.syncSteeringQueue();
		return true;
	}

	dequeueSteering(text: string): boolean {
		const index = this._steeringQueue.indexOf(text);
		if (index === -1) return false;
		this._steeringQueue = this._steeringQueue.filter((_, itemIndex) => itemIndex !== index);
		this.syncSteeringQueue();
		return true;
	}

	clearSteering(): void {
		if (this._steeringQueue.length === 0) return;
		this._steeringQueue = [];
		this.syncSteeringQueue();
	}

	markFailed(): void {
		if (this._phase === "detached" || this._phase === "releasing" || this._phase === "failed") return;
		this.transition("failed");
	}

	/**
	 * Release all runtime ownership. Safe to call once the actor command holding
	 * the current mutation reaches a terminal path.
	 */
	detach(): { proc: RpcProcess; liveSession: SessionJsonl } | undefined {
		const lease = this._lease;
		const liveSession = this._session;
		if (!lease || !liveSession) return undefined;

		if (this._phase !== "releasing") this.transition("releasing");
		this._turnEventCleanup?.();
		this._turnEventCleanup = undefined;
		if (this._steeringQueue.length > 0) {
			this._steeringQueue = [];
			this.emitEvent({ type: "steering_queue_update", queue: [] });
		}

		const proc = lease.process;
		this._lease = undefined;
		this._session = undefined;
		lease.release();
		this.transition("detached");
		this.emitEvent({ type: "detached", proc });
		return { proc, liveSession };
	}

	private syncSteeringQueue(): void {
		if (this._session) this._session.steeringQueue = [...this._steeringQueue];
		this.emitEvent({ type: "steering_queue_update", queue: [...this._steeringQueue] });
	}

	private transition(next: SessionPhase): void {
		if (next === this._phase) return;
		if (!LEGAL_TRANSITIONS[this._phase].includes(next)) {
			throw new Error(`Illegal session transition ${this._phase} -> ${next}`);
		}
		this._phase = next;
		this.emitEvent({ type: "phase_change", phase: next });
	}
}

import type { RpcProcess } from "./process-pool.js";
import { SessionActor, type SessionActorEvent, type SessionPhase } from "./session-actor.js";

export type SessionRuntimeStatus = "running" | "done";

export type SessionRegistryEvent =
	| { type: "session_attached"; sessionPath: string; procId: number }
	| { type: "session_detached"; sessionPath: string; procId: number }
	| { type: "status_change"; sessionPath: string; status: SessionRuntimeStatus }
	| { type: "phase_change"; sessionPath: string; phase: SessionPhase }
	| { type: "steering_queue_update"; sessionPath: string; queue: string[] };

export type SessionRegistryEventListener = (event: SessionRegistryEvent) => void;

/** Registry and process index for per-session actors. */
export class SessionRegistry {
	private actors = new Map<string, SessionActor>();
	private actorsByProcess = new Map<RpcProcess, SessionActor>();
	private pendingActors = new Set<string>();
	private statuses = new Map<string, SessionRuntimeStatus>();
	private listeners = new Set<SessionRegistryEventListener>();

	get(sessionPath: string): SessionActor {
		return this.getOrCreate(sessionPath);
	}

	/** Own a Pi-allocated path without advertising it until a real turn persists it. */
	getPending(sessionPath: string): SessionActor {
		const existing = this.actors.get(sessionPath);
		if (existing) return existing;
		this.pendingActors.add(sessionPath);
		return this.getOrCreate(sessionPath);
	}

	/** Make an attached pending actor visible as a normal running session. */
	promotePending(sessionPath: string): void {
		if (!this.pendingActors.delete(sessionPath)) return;
		const actor = this.actors.get(sessionPath);
		const proc = actor?.process;
		if (!actor || !proc) return;
		this.publishAttached(actor, proc);
	}

	/** Drop a pending actor that failed before it acquired runtime ownership. */
	discardPending(sessionPath: string): void {
		if (!this.pendingActors.has(sessionPath)) return;
		const actor = this.actors.get(sessionPath);
		if (actor?.isAttached) throw new Error(`Cannot discard attached pending session ${sessionPath}`);
		this.pendingActors.delete(sessionPath);
		this.actors.delete(sessionPath);
	}

	find(sessionPath: string): SessionActor | undefined {
		return this.actors.get(sessionPath);
	}

	getActorForProcess(proc: RpcProcess): SessionActor | undefined {
		return this.actorsByProcess.get(proc);
	}

	subscribe(listener: SessionRegistryEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getAllStatuses(): Record<string, SessionRuntimeStatus> {
		return Object.fromEntries(this.statuses);
	}

	getAllSteeringQueues(): Record<string, string[]> {
		const queues: Record<string, string[]> = {};
		for (const [sessionPath, actor] of this.actors) {
			if (actor.steeringQueue.length > 0) queues[sessionPath] = [...actor.steeringQueue];
		}
		return queues;
	}

	get attachedCount(): number {
		return this.actorsByProcess.size;
	}

	private getOrCreate(sessionPath: string): SessionActor {
		let actor = this.actors.get(sessionPath);
		if (!actor) {
			actor = new SessionActor(sessionPath, (event) => this.handleActorEvent(actor!, event));
			this.actors.set(sessionPath, actor);
		}
		return actor;
	}

	private publishAttached(actor: SessionActor, proc: RpcProcess): void {
		this.statuses.set(actor.sessionPath, "running");
		this.emit({ type: "status_change", sessionPath: actor.sessionPath, status: "running" });
		this.emit({ type: "session_attached", sessionPath: actor.sessionPath, procId: proc.id });
	}

	private handleActorEvent(actor: SessionActor, event: SessionActorEvent): void {
		switch (event.type) {
			case "attached":
				this.actorsByProcess.set(event.proc, actor);
				if (!this.pendingActors.has(actor.sessionPath)) this.publishAttached(actor, event.proc);
				break;
			case "detached":
				if (this.actorsByProcess.get(event.proc) === actor) this.actorsByProcess.delete(event.proc);
				if (this.pendingActors.delete(actor.sessionPath)) {
					this.actors.delete(actor.sessionPath);
					break;
				}
				this.statuses.set(actor.sessionPath, "done");
				this.emit({ type: "status_change", sessionPath: actor.sessionPath, status: "done" });
				this.emit({ type: "session_detached", sessionPath: actor.sessionPath, procId: event.proc.id });
				break;
			case "phase_change":
				this.emit({ type: "phase_change", sessionPath: actor.sessionPath, phase: event.phase });
				break;
			case "steering_queue_update":
				this.emit({ type: "steering_queue_update", sessionPath: actor.sessionPath, queue: event.queue });
				break;
		}
	}

	private emit(event: SessionRegistryEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

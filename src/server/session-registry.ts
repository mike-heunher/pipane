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
	private statuses = new Map<string, SessionRuntimeStatus>();
	private listeners = new Set<SessionRegistryEventListener>();

	get(sessionPath: string): SessionActor {
		let actor = this.actors.get(sessionPath);
		if (!actor) {
			actor = new SessionActor(sessionPath, (event) => this.handleActorEvent(actor!, event));
			this.actors.set(sessionPath, actor);
		}
		return actor;
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

	private handleActorEvent(actor: SessionActor, event: SessionActorEvent): void {
		switch (event.type) {
			case "attached":
				this.actorsByProcess.set(event.proc, actor);
				this.statuses.set(actor.sessionPath, "running");
				this.emit({ type: "status_change", sessionPath: actor.sessionPath, status: "running" });
				this.emit({ type: "session_attached", sessionPath: actor.sessionPath, procId: event.proc.id });
				break;
			case "detached":
				if (this.actorsByProcess.get(event.proc) === actor) this.actorsByProcess.delete(event.proc);
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

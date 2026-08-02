import { describe, expect, it, vi } from "vitest";
import { SessionActor, type SessionActorEvent } from "./session-actor.js";
import { SessionJsonl } from "./session-jsonl.js";
import { SessionRegistry } from "./session-registry.js";

function runtime() {
	const events: SessionActorEvent[] = [];
	const actor = new SessionActor("/sessions/a.jsonl", (event) => events.push(event));
	const proc = { id: 1 } as any;
	const release = vi.fn();
	const session = new SessionJsonl({ messages: [], model: null, thinkingLevel: "off" });
	const attach = () => actor.attach({ process: proc, release } as any, session);
	return { actor, proc, release, session, events, attach };
}

describe("SessionActor", () => {
	it("enforces explicit attach, turn, settle, and release phases", async () => {
		const { actor, proc, release, events, attach } = runtime();
		attach();
		expect(actor.phase).toBe("ready");
		const generation = actor.beginTurn();
		expect(actor.phase).toBe("starting");

		await actor.applyProcessEvent(proc, generation, { type: "agent_start" });
		expect(actor.phase).toBe("running");
		await actor.applyProcessEvent(proc, generation, { type: "agent_end" });
		expect(actor.phase).toBe("settling");
		actor.detach();

		expect(actor.phase).toBe("detached");
		expect(release).toHaveBeenCalledOnce();
		expect(events.filter((event) => event.type === "phase_change").map((event: any) => event.phase)).toEqual([
			"attaching", "ready", "starting", "running", "settling", "releasing", "detached",
		]);
	});

	it("serializes commands in arrival order even across awaits", async () => {
		const { actor } = runtime();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

		const first = actor.enqueue("first", async () => {
			order.push("first:start");
			await firstGate;
			order.push("first:end");
		});
		const second = actor.enqueue("second", () => { order.push("second"); });
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("rejects non-turn mutations while a turn is active", () => {
		const { actor, attach } = runtime();
		attach();
		actor.beginTurn();
		expect(() => actor.assertAvailable("compact")).toThrow("Cannot compact while session turn is starting");
	});

	it("keeps steering actor-owned and clears it when the agent ends", async () => {
		const { actor, proc, attach } = runtime();
		attach();
		const generation = actor.beginTurn();
		actor.enqueueSteering("first");
		actor.enqueueSteering("second");
		expect(actor.steeringQueue).toEqual(["first", "second"]);
		expect(actor.session?.toState().steeringQueue).toEqual(["first", "second"]);

		await actor.applyProcessEvent(proc, generation, { type: "agent_end" });
		expect(actor.steeringQueue).toEqual([]);
		expect(actor.session?.toState().steeringQueue).toEqual([]);
	});

	it("ignores events from an old turn generation", async () => {
		const { actor, proc, attach } = runtime();
		attach();
		const oldGeneration = actor.beginTurn();
		actor.detach();
		attach();
		actor.beginTurn();

		const result = await actor.applyProcessEvent(proc, oldGeneration, {
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "stale" }] },
		});
		expect(result.accepted).toBe(false);
		expect(actor.session?.toState().messages).toEqual([]);
	});

	it("releases ownership from failed phases", () => {
		const { actor, release, attach } = runtime();
		attach();
		actor.beginTurn();
		actor.markFailed();
		expect(actor.phase).toBe("failed");
		actor.detach();
		expect(actor.phase).toBe("detached");
		expect(release).toHaveBeenCalledOnce();
	});
});

describe("SessionRegistry", () => {
	it("indexes actors by process and emits authoritative running/done status", () => {
		const registry = new SessionRegistry();
		const events: any[] = [];
		registry.subscribe((event) => events.push(event));
		const actor = registry.get("/sessions/a.jsonl");
		const proc = { id: 10 } as any;
		actor.attach({ process: proc, release: vi.fn() } as any, new SessionJsonl({
			messages: [], model: null, thinkingLevel: "off",
		}));

		expect(registry.getActorForProcess(proc)).toBe(actor);
		expect(registry.getAllStatuses()).toEqual({ "/sessions/a.jsonl": "running" });
		actor.detach();
		expect(registry.getActorForProcess(proc)).toBeUndefined();
		expect(registry.getAllStatuses()).toEqual({ "/sessions/a.jsonl": "done" });
		expect(events).toContainEqual({
			type: "session_attached", sessionPath: "/sessions/a.jsonl", procId: 10,
		});
		expect(events).toContainEqual({
			type: "session_detached", sessionPath: "/sessions/a.jsonl", procId: 10,
		});
	});

	it("hides pending actors until promotion and discards unpersisted ones on detach", () => {
		const registry = new SessionRegistry();
		const events: any[] = [];
		registry.subscribe((event) => events.push(event));
		const session = () => new SessionJsonl({ messages: [], model: null, thinkingLevel: "off" });

		const discardedPath = "/sessions/discarded.jsonl";
		const discarded = registry.getPending(discardedPath);
		discarded.attach({ process: { id: 11 }, release: vi.fn() } as any, session());
		expect(registry.getAllStatuses()).toEqual({});
		discarded.detach();
		expect(registry.find(discardedPath)).toBeUndefined();
		expect(events.some((event) => event.sessionPath === discardedPath && event.type === "session_attached")).toBe(false);

		const promotedPath = "/sessions/promoted.jsonl";
		const promoted = registry.getPending(promotedPath);
		promoted.attach({ process: { id: 12 }, release: vi.fn() } as any, session());
		registry.promotePending(promotedPath);
		expect(registry.getAllStatuses()).toEqual({ [promotedPath]: "running" });
		promoted.detach();
		expect(registry.find(promotedPath)).toBe(promoted);
		expect(registry.getAllStatuses()).toEqual({ [promotedPath]: "done" });
	});

	it("returns actor-owned steering queues for reconnect snapshots", () => {
		const registry = new SessionRegistry();
		const actor = registry.get("/sessions/a.jsonl");
		actor.enqueueSteering("continue");
		expect(registry.getAllSteeringQueues()).toEqual({
			"/sessions/a.jsonl": ["continue"],
		});
	});
});

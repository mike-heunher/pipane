import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionLifecycle, type LifecycleEvent, type LifecycleProcess } from "./session-lifecycle.js";

function makeProc(id: number): LifecycleProcess {
	return { id };
}

describe("SessionLifecycle", () => {
	let lifecycle: SessionLifecycle;

	beforeEach(() => {
		lifecycle = new SessionLifecycle();
	});

	// ── attach / detach roundtrip ────────────────────────────────────────

	describe("attach and detach", () => {
		it("attach sets status to running and emits events", () => {
			const events: LifecycleEvent[] = [];
			lifecycle.subscribe((e) => events.push(e));

			const proc = makeProc(1);
			const result = lifecycle.attach("/sessions/a.jsonl", proc);

			expect(result).toBe(proc);
			expect(lifecycle.getAllStatuses()["/sessions/a.jsonl"]).toBe("running");
			expect(!!lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBe(true);
			expect(lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBe(proc);
			expect(lifecycle.attachedCount).toBe(1);

			expect(events).toHaveLength(2);
			expect(events[0]).toEqual({ type: "status_change", sessionPath: "/sessions/a.jsonl", status: "running" });
			expect(events[1]).toEqual({ type: "session_attached", sessionPath: "/sessions/a.jsonl", procId: 1 });
		});

		it("detach sets status to done and emits events", () => {
			const proc = makeProc(1);
			lifecycle.attach("/sessions/a.jsonl", proc);

			const events: LifecycleEvent[] = [];
			lifecycle.subscribe((e) => events.push(e));

			const detached = lifecycle.detach("/sessions/a.jsonl");

			expect(detached).toBe(proc);
			expect(lifecycle.getAllStatuses()["/sessions/a.jsonl"]).toBe("done");
			expect(!!lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBe(false);
			expect(lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBeUndefined();
			expect(lifecycle.attachedCount).toBe(0);

			// steering_queue_update (clear) + status_change + session_detached
			expect(events).toHaveLength(3);
			expect(events[0]).toEqual({ type: "steering_queue_update", sessionPath: "/sessions/a.jsonl", queue: [] });
			expect(events[1]).toEqual({ type: "status_change", sessionPath: "/sessions/a.jsonl", status: "done" });
			expect(events[2]).toEqual({ type: "session_detached", sessionPath: "/sessions/a.jsonl", procId: 1 });
		});

		it("attach is idempotent — returns existing proc", () => {
			const proc1 = makeProc(1);
			const proc2 = makeProc(2);

			lifecycle.attach("/sessions/a.jsonl", proc1);
			const result = lifecycle.attach("/sessions/a.jsonl", proc2);

			expect(result).toBe(proc1);
			expect(lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBe(proc1);
		});

		it("detach on non-attached session returns undefined and warns", () => {
			const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = lifecycle.detach("/sessions/nonexistent.jsonl");

			expect(result).toBeUndefined();
			expect(spy).toHaveBeenCalledOnce();
			spy.mockRestore();
		});
	});

	// ── crash ────────────────────────────────────────────────────────────

	describe("crash", () => {
		it("crash is equivalent to detach", () => {
			const proc = makeProc(1);
			lifecycle.attach("/sessions/a.jsonl", proc);

			const events: LifecycleEvent[] = [];
			lifecycle.subscribe((e) => events.push(e));

			const crashed = lifecycle.crash("/sessions/a.jsonl");

			expect(crashed).toBe(proc);
			expect(lifecycle.getAllStatuses()["/sessions/a.jsonl"]).toBe("done");
			expect(!!lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBe(false);

			const detachedEvent = events.find((e) => e.type === "session_detached");
			expect(detachedEvent).toBeDefined();
		});
	});

	// ── getAllStatuses ────────────────────────────────────────────────────

	describe("getAllStatuses", () => {
		it("returns all session statuses", () => {
			lifecycle.attach("/sessions/a.jsonl", makeProc(1));
			lifecycle.attach("/sessions/b.jsonl", makeProc(2));
			lifecycle.detach("/sessions/a.jsonl");

			const statuses = lifecycle.getAllStatuses();
			expect(statuses).toEqual({
				"/sessions/a.jsonl": "done",
				"/sessions/b.jsonl": "running",
			});
		});
	});

	// ── getAttachedSessionForProcess ──────────────────────────────────────

	describe("getAttachedSessionForProcess", () => {
		it("returns session path for attached process", () => {
			const proc = makeProc(1);
			lifecycle.attach("/sessions/a.jsonl", proc);

			expect(lifecycle.getAttachedSessionForProcess(proc)).toBe("/sessions/a.jsonl");
		});

		it("returns undefined for unattached process", () => {
			const proc = makeProc(1);
			expect(lifecycle.getAttachedSessionForProcess(proc)).toBeUndefined();
		});
	});

	// ── Steering queues ──────────────────────────────────────────────────

	describe("steering queues", () => {
		it("enqueue and get steering messages", () => {
			const events: LifecycleEvent[] = [];
			lifecycle.subscribe((e) => events.push(e));

			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg2");

			expect((lifecycle.getAllSteeringQueues()["/sessions/a.jsonl"] ?? [])).toEqual(["msg1", "msg2"]);

			const queueEvents = events.filter((e) => e.type === "steering_queue_update");
			expect(queueEvents).toHaveLength(2);
			expect((queueEvents[1] as any).queue).toEqual(["msg1", "msg2"]);
		});

		it("dequeueSteering removes by text match", () => {
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg2");

			const result = lifecycle.dequeueSteering("/sessions/a.jsonl", "msg1");
			expect(result).toBe(true);
			expect((lifecycle.getAllSteeringQueues()["/sessions/a.jsonl"] ?? [])).toEqual(["msg2"]);
		});

		it("dequeueSteering returns false for non-matching text", () => {
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");
			expect(lifecycle.dequeueSteering("/sessions/a.jsonl", "nonexistent")).toBe(false);
		});

		it("dequeueSteering returns false for empty session", () => {
			expect(lifecycle.dequeueSteering("/sessions/a.jsonl", "msg")).toBe(false);
		});

		it("removeSteeringByIndex removes by index", () => {
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg2");
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg3");

			const result = lifecycle.removeSteeringByIndex("/sessions/a.jsonl", 1);
			expect(result).toBe(true);
			expect((lifecycle.getAllSteeringQueues()["/sessions/a.jsonl"] ?? [])).toEqual(["msg1", "msg3"]);
		});

		it("removeSteeringByIndex returns false for out-of-bounds", () => {
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");
			expect(lifecycle.removeSteeringByIndex("/sessions/a.jsonl", 5)).toBe(false);
			expect(lifecycle.removeSteeringByIndex("/sessions/a.jsonl", -1)).toBe(false);
		});

		it("clearSteering clears all messages", () => {
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg2");

			const events: LifecycleEvent[] = [];
			lifecycle.subscribe((e) => events.push(e));

			lifecycle.clearSteering("/sessions/a.jsonl");
			expect((lifecycle.getAllSteeringQueues()["/sessions/a.jsonl"] ?? [])).toEqual([]);

			const queueEvents = events.filter((e) => e.type === "steering_queue_update");
			expect(queueEvents).toHaveLength(1);
			expect((queueEvents[0] as any).queue).toEqual([]);
		});

		it("clearSteering on empty session is a no-op", () => {
			const events: LifecycleEvent[] = [];
			lifecycle.subscribe((e) => events.push(e));

			lifecycle.clearSteering("/sessions/nonexistent.jsonl");
			expect(events).toHaveLength(0);
		});

		it("detach clears steering queue", () => {
			lifecycle.attach("/sessions/a.jsonl", makeProc(1));
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");

			lifecycle.detach("/sessions/a.jsonl");
			expect((lifecycle.getAllSteeringQueues()["/sessions/a.jsonl"] ?? [])).toEqual([]);
		});

		it("getAllSteeringQueues returns all non-empty queues", () => {
			lifecycle.enqueueSteering("/sessions/a.jsonl", "msg1");
			lifecycle.enqueueSteering("/sessions/b.jsonl", "msg2");

			const queues = lifecycle.getAllSteeringQueues();
			expect(queues).toEqual({
				"/sessions/a.jsonl": ["msg1"],
				"/sessions/b.jsonl": ["msg2"],
			});
		});
	});

	// ── Multiple sessions ────────────────────────────────────────────────

	describe("multiple sessions", () => {
		it("can attach multiple sessions simultaneously", () => {
			lifecycle.attach("/sessions/a.jsonl", makeProc(1));
			lifecycle.attach("/sessions/b.jsonl", makeProc(2));

			expect(lifecycle.attachedCount).toBe(2);
			expect(!!lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBe(true);
			expect(!!lifecycle.getAttachedProcess("/sessions/b.jsonl")).toBe(true);
		});

		it("detaching one session doesn't affect others", () => {
			lifecycle.attach("/sessions/a.jsonl", makeProc(1));
			lifecycle.attach("/sessions/b.jsonl", makeProc(2));

			lifecycle.detach("/sessions/a.jsonl");

			expect(!!lifecycle.getAttachedProcess("/sessions/a.jsonl")).toBe(false);
			expect(!!lifecycle.getAttachedProcess("/sessions/b.jsonl")).toBe(true);
			expect(lifecycle.getAllStatuses()["/sessions/a.jsonl"]).toBe("done");
			expect(lifecycle.getAllStatuses()["/sessions/b.jsonl"]).toBe("running");
		});
	});

	// ── subscribe / unsubscribe ──────────────────────────────────────────

	describe("subscription management", () => {
		it("unsubscribe stops receiving events", () => {
			const events: LifecycleEvent[] = [];
			const unsub = lifecycle.subscribe((e) => events.push(e));

			lifecycle.attach("/sessions/a.jsonl", makeProc(1));
			expect(events.length).toBeGreaterThan(0);

			const countBefore = events.length;
			unsub();

			lifecycle.attach("/sessions/b.jsonl", makeProc(2));
			expect(events.length).toBe(countBefore);
		});
	});
});

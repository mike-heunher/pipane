import { describe, expect, it, vi } from "vitest";
import { FrameTrafficMeter } from "./frame-traffic.js";

describe("FrameTrafficMeter", () => {
	it("separates logical protocol bytes from compressed physical messages by type", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
			const meter = new FrameTrafficMeter();
			const full = JSON.stringify({
				protocolVersion: 1,
				type: "session_sync",
				sessionPath: "/session.jsonl",
				revision: 1,
				op: "full",
				data: "x".repeat(10_000),
				hash: "a".repeat(64),
			});
			const delta = JSON.stringify({
				protocolVersion: 1,
				type: "session_sync",
				sessionPath: "/session.jsonl",
				revision: 2,
				op: "delta",
				patches: [],
				baseHash: "a".repeat(64),
				hash: "b".repeat(64),
			});
			meter.recordLogical("received", full);
			meter.recordLogical("received", delta);
			meter.recordPhysical("received", "compressed-one");
			meter.recordPhysical("received", new Uint8Array(8));
			meter.recordLogical("sent", JSON.stringify({ protocolVersion: 1, id: "r1", type: "subscribe_session" }));
			meter.recordReconnect();

			const stats = meter.snapshot();
			expect(stats.startedAt).toBe("2026-07-24T12:00:00.000Z");
			expect(stats.reconnects).toBe(1);
			expect(stats.received).toMatchObject({
				physicalMessages: 2,
				physicalBytes: 22,
				logicalFrames: 2,
				logicalBytesByType: {
					"session_sync.full": new TextEncoder().encode(full).byteLength,
					"session_sync.delta": new TextEncoder().encode(delta).byteLength,
				},
				logicalFramesByType: { "session_sync.full": 1, "session_sync.delta": 1 },
			});
			expect(stats.sent.logicalFramesByType).toEqual({ subscribe_session: 1 });
		} finally {
			vi.useRealTimers();
		}
	});
});

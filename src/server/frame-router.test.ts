/** @vitest-environment node */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import { FRAME_CONNECTION_OPEN, type ServerFrameConnection } from "./frame-connection.js";
import { routeFrameConnection } from "./frame-router.js";

class FakeConnection extends EventEmitter implements ServerFrameConnection {
	readyState = FRAME_CONNECTION_OPEN;
	sent: string[] = [];
	send(frame: string): void { this.sent.push(frame); }
	close(): void { this.emit("close"); }
}

describe("routeFrameConnection", () => {
	it("isolates semantic v2 frames from application v1 while sharing output and close", () => {
		const source = new FakeConnection();
		const routes = routeFrameConnection(source);
		const application: string[] = [];
		const semantic: string[] = [];
		let closes = 0;
		routes.application.on("message", (frame) => application.push(frame.toString()));
		routes.semantic.on("message", (frame) => semantic.push(frame.toString()));
		routes.application.on("close", () => closes++);
		routes.semantic.on("close", () => closes++);

		const v1 = JSON.stringify({ protocolVersion: 1, type: "get_session_statuses", id: "a" });
		const v2 = JSON.stringify({ v: BACKEND_PROTOCOL_VERSION, kind: "request", id: "b", method: "sessions.list", params: {} });
		source.emit("message", v1);
		source.emit("message", v2);
		routes.semantic.send("response");
		source.emit("close");

		expect(application).toEqual([v1]);
		expect(semantic).toEqual([v2]);
		expect(source.sent).toEqual(["response"]);
		expect(closes).toBe(2);
	});
});

/** @vitest-environment node */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BackendApi } from "../shared/backend-api.js";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import { BackendProtocolHandler } from "./backend-protocol-handler.js";
import { FRAME_CONNECTION_OPEN, type ServerFrameConnection } from "./frame-connection.js";
import { LocalBackendApiError } from "./local-backend-api.js";

class FakeConnection extends EventEmitter implements ServerFrameConnection {
	readyState = FRAME_CONNECTION_OPEN;
	sent: string[] = [];
	send(frame: string): void { this.sent.push(frame); }
	close(): void { this.emit("close"); }
	message(frame: object | string): void { this.emit("message", typeof frame === "string" ? frame : JSON.stringify(frame)); }
}

function api(overrides: Partial<BackendApi> = {}): BackendApi {
	return {
		getCapabilities: async () => ({ backendId: "b_test", semanticProtocolVersion: 2, applicationProtocolVersions: [1], features: [] }),
		listSessions: async () => [],
		deleteSession: async () => undefined,
		listForkMessages: async () => [],
		browseDirectory: async () => ({ path: "/", dirs: [] }),
		getRawSession: async () => "",
		getFileContent: async () => ({ path: "/file", content: "" }),
		getLocalSettings: async () => ({ path: "/settings", exists: false, errors: [], settings: {}, formatted: "{}" }),
		validateLocalSettings: async () => ({ valid: true, errors: [] }),
		patchLocalSettings: async () => ({ valid: true, errors: [] }),
		saveLocalSettings: async () => ({ valid: true, errors: [] }),
		getUpdates: async () => ({ checkedAt: new Date(0).toISOString(), notices: [] }),
		runUpdate: async () => ({ result: { target: "pi", message: "done", restartRequired: false }, snapshot: { checkedAt: new Date(0).toISOString(), notices: [] } }),
		...overrides,
	};
}

function request(id: string, method: string, params: object): object {
	return { v: BACKEND_PROTOCOL_VERSION, kind: "request", id, method, params };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BackendProtocolHandler", () => {
	it("dispatches every semantic namespace and caches completed request IDs", async () => {
		const listSessions = vi.fn(async () => [{
			id: "s", path: "/s.jsonl", cwd: "/tmp", created: "now", modified: "now", messageCount: 0, firstMessage: "",
		}]);
		const connection = new FakeConnection();
		const handler = new BackendProtocolHandler(api({ listSessions }));
		handler.accept(connection, "d_one");
		connection.message(request("r1", "sessions.list", {}));
		await settle();
		const reconnected = new FakeConnection();
		handler.accept(reconnected, "d_one");
		reconnected.message(request("r1", "sessions.list", {}));
		expect(listSessions).toHaveBeenCalledTimes(1);
		expect(connection.sent).toHaveLength(1);
		expect(reconnected.sent).toEqual(connection.sent);
		expect(JSON.parse(connection.sent[0])).toMatchObject({ success: true, method: "sessions.list" });
	});

	it("scopes idempotency records to the authenticated device", async () => {
		const listSessions = vi.fn(async () => []);
		const handler = new BackendProtocolHandler(api({ listSessions }));
		const first = new FakeConnection();
		const second = new FakeConnection();
		handler.accept(first, "d_one");
		handler.accept(second, "d_two");
		first.message(request("shared-id", "sessions.list", {}));
		second.message(request("shared-id", "sessions.list", {}));
		await settle();
		expect(listSessions).toHaveBeenCalledTimes(2);
	});

	it("returns stable local errors and rejects malformed requests before dispatch", async () => {
		const deleteSession = vi.fn(async () => {
			throw new LocalBackendApiError("missing", 404, "not_found");
		});
		const connection = new FakeConnection();
		new BackendProtocolHandler(api({ deleteSession })).accept(connection);
		connection.message(request("r1", "sessions.delete", { sessionPath: "/missing.jsonl" }));
		connection.message(request("r2", "sessions.delete", {}));
		await settle();
		expect(deleteSession).toHaveBeenCalledTimes(1);
		expect(connection.sent.map((frame) => JSON.parse(frame))).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "r1", success: false, error: { code: "not_found", message: "missing" } }),
			expect.objectContaining({ id: "r2", success: false, error: expect.objectContaining({ code: "invalid_request" }) }),
		]));
	});
});

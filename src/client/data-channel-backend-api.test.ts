import { describe, expect, it } from "vitest";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import type { FrameTransport, FrameTransportConnectionEvent } from "./frame-transport.js";
import { DataChannelBackendApi, DataChannelBackendApiError } from "./data-channel-backend-api.js";

class FakeTransport implements FrameTransport {
	isConnected = true;
	isReconnecting = false;
	private frames = new Set<(frame: string) => void>();
	private changes = new Set<(event: FrameTransportConnectionEvent) => void>();
	sent: any[] = [];

	connect(): Promise<void> { return Promise.resolve(); }
	send(frame: string): void { this.sent.push(JSON.parse(frame)); }
	close(): void { this.disconnect(); }
	onFrame(listener: (frame: string) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
	onConnectionChange(listener: (event: FrameTransportConnectionEvent) => void): () => void { this.changes.add(listener); return () => this.changes.delete(listener); }
	reply(requestIndex: number, result: unknown): void {
		const request = this.sent[requestIndex];
		this.emit({ v: BACKEND_PROTOCOL_VERSION, kind: "response", id: request.id, method: request.method, success: true, result });
	}
	fail(requestIndex: number): void {
		const request = this.sent[requestIndex];
		this.emit({ v: BACKEND_PROTOCOL_VERSION, kind: "response", id: request.id, method: request.method, success: false, error: { code: "forbidden", message: "denied" } });
	}
	disconnect(): void {
		this.isConnected = false;
		for (const listener of this.changes) listener({ connected: false, reconnected: false });
	}
	reconnect(): void {
		this.isConnected = true;
		for (const listener of this.changes) listener({ connected: true, reconnected: true });
	}
	private emit(value: object): void { for (const listener of this.frames) listener(JSON.stringify(value)); }
}

describe("DataChannelBackendApi", () => {
	it("correlates semantic responses and scopes session references to the backend", async () => {
		const transport = new FakeTransport();
		const api = new DataChannelBackendApi(transport, "b_one");
		const pending = api.listSessions();
		expect(transport.sent[0]).toMatchObject({ method: "sessions.list", params: {} });
		transport.reply(0, [{
			id: "s1", path: "/s1.jsonl", cwd: "/tmp", created: "a", modified: "b", messageCount: 1, firstMessage: "hello",
		}]);
		await expect(pending).resolves.toEqual([expect.objectContaining({ backendId: "b_one", path: "/s1.jsonl" })]);
	});

	it("validates capabilities and surfaces structured failures", async () => {
		const transport = new FakeTransport();
		const api = new DataChannelBackendApi(transport, "b_one");
		const capabilities = api.getCapabilities();
		transport.reply(0, { backendId: "b_one", semanticProtocolVersion: 2, applicationProtocolVersions: [1], features: ["sessions"] });
		await expect(capabilities).resolves.toMatchObject({ backendId: "b_one" });

		const deletion = api.deleteSession("/x.jsonl");
		transport.fail(1);
		await expect(deletion).rejects.toBeInstanceOf(DataChannelBackendApiError);
	});

	it("retries a pending request with the same id after carrier reconnection", async () => {
		const transport = new FakeTransport();
		const api = new DataChannelBackendApi(transport, "b_one");
		const pending = api.getRawSession("/x.jsonl");
		transport.disconnect();
		transport.reconnect();
		expect(transport.sent).toHaveLength(2);
		expect(transport.sent[1].id).toBe(transport.sent[0].id);
		transport.reply(1, "raw");
		await expect(pending).resolves.toBe("raw");
	});
});

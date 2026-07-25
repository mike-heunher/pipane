import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DATA_CHANNEL_CHUNK_PAYLOAD_BYTES,
	encodeDataChannelFrame,
	encodeDataChannelFrameCancellation,
} from "../shared/data-channel-framing.js";
import { WebSocketFrameTransport, type WebSocketLike } from "./websocket-frame-transport.js";

class FakeSocket {
	readyState: number = WebSocket.CONNECTING;
	sent: string[] = [];
	onopen: ((event: Event) => unknown) | null = null;
	onerror: ((event: Event) => unknown) | null = null;
	onclose: ((event: CloseEvent) => unknown) | null = null;
	onmessage: ((event: MessageEvent) => unknown) | null = null;

	send(frame: string): void {
		this.sent.push(frame);
	}

	close(): void {
		this.readyState = WebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close"));
	}

	open(): void {
		this.readyState = WebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	receive(frame: string): void {
		this.onmessage?.(new MessageEvent("message", { data: frame }));
	}

	disconnect(): void {
		this.readyState = WebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close"));
	}
}

function socketFactory() {
	const sockets: FakeSocket[] = [];
	const createWebSocket = vi.fn(() => {
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket as WebSocketLike;
	});
	return { sockets, createWebSocket };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("WebSocketFrameTransport", () => {
	it("carries ordered text frames without exposing WebSocket to the protocol client", async () => {
		const { sockets, createWebSocket } = socketFactory();
		const transport = new WebSocketFrameTransport({ createWebSocket });
		const frames: string[] = [];
		const connections: Array<{ connected: boolean; reconnected: boolean }> = [];
		transport.onFrame((frame) => frames.push(frame));
		transport.onConnectionChange((event) => connections.push(event));

		const connecting = transport.connect("wss://example.test/ws");
		expect(createWebSocket).toHaveBeenCalledWith("wss://example.test/ws");
		sockets[0].open();
		await connecting;

		expect(transport.isConnected).toBe(true);
		transport.send("request");
		sockets[0].receive("response");
		expect(sockets[0].sent).toEqual(["request"]);
		expect(frames).toEqual(["response"]);
		expect(connections).toEqual([{ connected: true, reconnected: false }]);
	});

	it("reassembles large frames and drops cancelled stale transfers", async () => {
		const { sockets, createWebSocket } = socketFactory();
		const transport = new WebSocketFrameTransport({ createWebSocket });
		const frames: string[] = [];
		transport.onFrame((frame) => frames.push(frame));
		const connecting = transport.connect("wss://example.test/ws");
		sockets[0].open();
		await connecting;

		const stale = encodeDataChannelFrame("s".repeat(DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 1), "stale");
		sockets[0].receive(stale[0]);
		sockets[0].receive(encodeDataChannelFrameCancellation("stale"));
		sockets[0].receive("control");
		const replacementText = "r".repeat(DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 1);
		for (const chunk of encodeDataChannelFrame(replacementText, "replacement")) sockets[0].receive(chunk);

		expect(frames).toEqual(["control", replacementText]);
	});

	it("reconnects with backoff and marks the recovered connection", async () => {
		vi.useFakeTimers();
		const { sockets, createWebSocket } = socketFactory();
		const transport = new WebSocketFrameTransport({ createWebSocket });
		const connections: Array<{ connected: boolean; reconnected: boolean }> = [];
		transport.onConnectionChange((event) => connections.push(event));

		const connecting = transport.connect("wss://example.test/ws");
		sockets[0].open();
		await connecting;
		sockets[0].disconnect();

		expect(transport.isConnected).toBe(false);
		expect(transport.isReconnecting).toBe(true);
		expect(connections.at(-1)).toEqual({ connected: false, reconnected: false });

		await vi.advanceTimersByTimeAsync(499);
		expect(sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets).toHaveLength(2);
		sockets[1].open();

		expect(transport.isConnected).toBe(true);
		expect(transport.isReconnecting).toBe(false);
		expect(connections.at(-1)).toEqual({ connected: true, reconnected: true });
	});

	it("does not reconnect after an intentional close", async () => {
		vi.useFakeTimers();
		const { sockets, createWebSocket } = socketFactory();
		const transport = new WebSocketFrameTransport({ createWebSocket });
		const connecting = transport.connect("wss://example.test/ws");
		sockets[0].open();
		await connecting;

		transport.close();
		await vi.runAllTimersAsync();

		expect(transport.isReconnecting).toBe(false);
		expect(sockets).toHaveLength(1);
	});

	it("rejects writes and connection attempts that cannot open", async () => {
		const { sockets, createWebSocket } = socketFactory();
		const transport = new WebSocketFrameTransport({ createWebSocket });
		expect(() => transport.send("request")).toThrow("not connected");

		const connecting = transport.connect("wss://example.test/ws");
		sockets[0].disconnect();
		await expect(connecting).rejects.toThrow("closed before connecting");
	});
});

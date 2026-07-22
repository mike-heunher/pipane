// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { DataChannel } from "node-datachannel";
import {
	DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES,
	DataChannelFrameDecoder,
	MAX_DATA_CHANNEL_MESSAGE_BYTES,
} from "../shared/data-channel-framing.js";
import {
	DataChannelFrameConnection,
	FRAME_CONNECTION_CLOSED,
	FRAME_CONNECTION_OPEN,
	WebSocketFrameConnection,
} from "./frame-connection.js";

function fakeChannel() {
	let messageListener: ((message: string | Buffer | ArrayBuffer) => void) | undefined;
	let closedListener: (() => void) | undefined;
	let bufferedAmountLowListener: (() => void) | undefined;
	let open = true;
	let bufferNextSend = false;
	let bufferedAmount = 0;
	let blockAfterNextSend = false;
	const channel = {
		onMessage: (listener: typeof messageListener) => { messageListener = listener; },
		onClosed: (listener: () => void) => { closedListener = listener; },
		onBufferedAmountLow: (listener: () => void) => { bufferedAmountLowListener = listener; },
		setBufferedAmountLowThreshold: vi.fn(),
		bufferedAmount: () => bufferedAmount,
		isOpen: () => open,
		sendMessage: vi.fn((_message: string) => {
			if (blockAfterNextSend) {
				blockAfterNextSend = false;
				bufferedAmount = DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES;
			}
			if (!bufferNextSend) return true;
			bufferNextSend = false;
			return false;
		}),
		close: vi.fn(() => { open = false; closedListener?.(); }),
	};
	return {
		channel: channel as unknown as DataChannel,
		sendMessage: channel.sendMessage,
		message: (value: string) => messageListener?.(value),
		close: () => { open = false; closedListener?.(); },
		bufferSend: () => { bufferNextSend = true; },
		block: () => { bufferedAmount = DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES; },
		blockAfterSend: () => { blockAfterNextSend = true; },
		drain: () => {
			bufferedAmount = 0;
			bufferedAmountLowListener?.();
		},
	};
}

describe("DataChannelFrameConnection", () => {
	it("adapts ordered text frames to the server connection boundary", () => {
		const fake = fakeChannel();
		const connection = new DataChannelFrameConnection(fake.channel);
		const message = vi.fn();
		const closed = vi.fn();
		connection.on("message", message);
		connection.on("close", closed);
		expect(connection.readyState).toBe(FRAME_CONNECTION_OPEN);
		fake.message("browser-frame");
		expect(message.mock.calls[0][0].toString()).toBe("browser-frame");
		connection.send("server-frame");
		expect(fake.channel.sendMessage).toHaveBeenCalledWith("server-frame");
		connection.close();
		expect(connection.readyState).toBe(FRAME_CONNECTION_CLOSED);
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("fragments and reassembles large logical frames below the physical message limit", () => {
		const sender = fakeChannel();
		const receiver = fakeChannel();
		const outgoing = new DataChannelFrameConnection(sender.channel);
		const incoming = new DataChannelFrameConnection(receiver.channel);
		const message = vi.fn();
		incoming.on("message", message);
		const largeFrame = JSON.stringify({ type: "session_sync", content: "🙂 large history ".repeat(20_000) });

		outgoing.send(largeFrame);
		const chunks = sender.sendMessage.mock.calls.map(([chunk]) => chunk);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= MAX_DATA_CHANNEL_MESSAGE_BYTES)).toBe(true);
		for (const chunk of chunks) receiver.message(chunk);
		expect(message).toHaveBeenCalledTimes(1);
		expect(message.mock.calls[0][0].toString()).toBe(largeFrame);
	});

	it("keeps flushing after libdatachannel accepts a chunk into native buffering", () => {
		const sender = fakeChannel();
		const receiver = fakeChannel();
		const outgoing = new DataChannelFrameConnection(sender.channel);
		const incoming = new DataChannelFrameConnection(receiver.channel);
		const message = vi.fn();
		incoming.on("message", message);
		const largeFrame = JSON.stringify({ type: "session_sync", content: "buffered history ".repeat(20_000) });

		sender.bufferSend();
		outgoing.send(largeFrame);
		const chunks = sender.sendMessage.mock.calls.map(([chunk]) => chunk);
		expect(chunks.length).toBeGreaterThan(1);
		expect(outgoing.readyState).toBe(FRAME_CONNECTION_OPEN);
		for (const chunk of chunks) receiver.message(chunk);
		expect(message).toHaveBeenCalledOnce();
		expect(message.mock.calls[0][0].toString()).toBe(largeFrame);
	});

	it("sends controls ahead of queued bulk chunks", () => {
		const fake = fakeChannel();
		const connection = new DataChannelFrameConnection(fake.channel);
		fake.block();
		connection.send("bulk ".repeat(20_000), { priority: "bulk", transferKey: "session" });
		connection.send("control", { priority: "control" });
		expect(fake.sendMessage).not.toHaveBeenCalled();

		fake.drain();
		expect(fake.sendMessage.mock.calls[0][0]).toBe("control");
	});

	it("cancels a partial stale transfer before delivering its replacement", () => {
		const sender = fakeChannel();
		const receiver = fakeChannel();
		const outgoing = new DataChannelFrameConnection(sender.channel);
		const incoming = new DataChannelFrameConnection(receiver.channel);
		const frames: string[] = [];
		incoming.on("message", (frame) => frames.push(frame.toString()));
		const stale = "stale ".repeat(20_000);
		const replacement = "replacement ".repeat(20_000);

		sender.blockAfterSend();
		outgoing.send(stale, { priority: "bulk", transferKey: "session" });
		expect(sender.sendMessage).toHaveBeenCalledOnce();
		outgoing.cancelTransfer("session");
		outgoing.send("control", { priority: "control" });
		outgoing.send(replacement, { priority: "bulk", transferKey: "session" });
		sender.drain();

		for (const [message] of sender.sendMessage.mock.calls) receiver.message(message);
		expect(frames).toEqual(["control", replacement]);
		expect(outgoing.readyState).toBe(FRAME_CONNECTION_OPEN);
	});

	it("applies priority and cancellation to WebSocket bulk transfers", () => {
		let readyState = FRAME_CONNECTION_OPEN;
		let bufferedAmount = 0;
		let blockAfterNextSend = true;
		const callbacks: Array<(error?: Error) => void> = [];
		const closeListeners: Array<() => void> = [];
		const sent: string[] = [];
		const socket = {
			get readyState() { return readyState; },
			get bufferedAmount() { return bufferedAmount; },
			send: (message: string, callback: (error?: Error) => void) => {
				sent.push(message);
				callbacks.push(callback);
				if (blockAfterNextSend) {
					blockAfterNextSend = false;
					bufferedAmount = DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES;
				}
			},
			close: () => {
				readyState = FRAME_CONNECTION_CLOSED;
				for (const listener of closeListeners) listener();
			},
			on: (event: string, listener: () => void) => {
				if (event === "close") closeListeners.push(listener);
			},
		};
		const connection = new WebSocketFrameConnection(socket as any);
		const stale = "stale ".repeat(20_000);
		const replacement = "replacement ".repeat(20_000);

		connection.send(stale, { priority: "bulk", transferKey: "session" });
		expect(sent).toHaveLength(1);
		connection.cancelTransfer("session");
		connection.send("control", { priority: "control" });
		connection.send(replacement, { priority: "bulk", transferKey: "session" });
		bufferedAmount = 0;
		callbacks.shift()?.();

		const decoder = new DataChannelFrameDecoder();
		const received: string[] = [];
		for (const message of sent) {
			const decoded = decoder.accept(message);
			if (decoded !== undefined) received.push(decoded);
		}
		expect(received).toEqual(["control", replacement]);
	});

	it("closes on malformed carrier chunks without exposing them", () => {
		const fake = fakeChannel();
		const connection = new DataChannelFrameConnection(fake.channel);
		const message = vi.fn();
		connection.on("message", message);
		fake.message('{"__pipaneDataChannelChunk":1,"id":"bad","index":1,"total":2,"data":"eA=="}');
		expect(connection.readyState).toBe(FRAME_CONNECTION_CLOSED);
		expect(message).not.toHaveBeenCalled();
	});

	it("rejects sends after the channel closes", () => {
		const fake = fakeChannel();
		const connection = new DataChannelFrameConnection(fake.channel);
		fake.close();
		expect(() => connection.send("late")).toThrow("closed");
	});
});

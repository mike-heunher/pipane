// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { DataChannel } from "node-datachannel";
import { MAX_DATA_CHANNEL_MESSAGE_BYTES } from "../shared/data-channel-framing.js";
import { DataChannelFrameConnection, FRAME_CONNECTION_CLOSED, FRAME_CONNECTION_OPEN } from "./frame-connection.js";

function fakeChannel() {
	let messageListener: ((message: string | Buffer | ArrayBuffer) => void) | undefined;
	let closedListener: (() => void) | undefined;
	let bufferedAmountLowListener: (() => void) | undefined;
	let open = true;
	let bufferNextSend = false;
	const channel = {
		onMessage: (listener: typeof messageListener) => { messageListener = listener; },
		onClosed: (listener: () => void) => { closedListener = listener; },
		onBufferedAmountLow: (listener: () => void) => { bufferedAmountLowListener = listener; },
		setBufferedAmountLowThreshold: vi.fn(),
		bufferedAmount: () => 0,
		isOpen: () => open,
		sendMessage: vi.fn((_message: string) => {
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
		drain: () => bufferedAmountLowListener?.(),
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

	it("waits for native backpressure without closing or resending accepted chunks", () => {
		const sender = fakeChannel();
		const receiver = fakeChannel();
		const outgoing = new DataChannelFrameConnection(sender.channel);
		const incoming = new DataChannelFrameConnection(receiver.channel);
		const message = vi.fn();
		incoming.on("message", message);
		const largeFrame = JSON.stringify({ type: "session_sync", content: "buffered history ".repeat(20_000) });

		sender.bufferSend();
		outgoing.send(largeFrame);
		expect(sender.sendMessage).toHaveBeenCalledTimes(1);
		expect(outgoing.readyState).toBe(FRAME_CONNECTION_OPEN);

		sender.drain();
		const chunks = sender.sendMessage.mock.calls.map(([chunk]) => chunk);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) receiver.message(chunk);
		expect(message).toHaveBeenCalledOnce();
		expect(message.mock.calls[0][0].toString()).toBe(largeFrame);
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

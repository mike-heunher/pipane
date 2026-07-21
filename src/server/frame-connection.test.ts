// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { DataChannel } from "node-datachannel";
import { DataChannelFrameConnection, FRAME_CONNECTION_CLOSED, FRAME_CONNECTION_OPEN } from "./frame-connection.js";

function fakeChannel() {
	let messageListener: ((message: string | Buffer | ArrayBuffer) => void) | undefined;
	let closedListener: (() => void) | undefined;
	let open = true;
	const channel = {
		onMessage: (listener: typeof messageListener) => { messageListener = listener; },
		onClosed: (listener: () => void) => { closedListener = listener; },
		isOpen: () => open,
		sendMessage: vi.fn(() => true),
		close: vi.fn(() => { open = false; closedListener?.(); }),
	};
	return {
		channel: channel as unknown as DataChannel,
		message: (value: string) => messageListener?.(value),
		close: () => { open = false; closedListener?.(); },
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

	it("rejects sends after the channel closes", () => {
		const fake = fakeChannel();
		const connection = new DataChannelFrameConnection(fake.channel);
		fake.close();
		expect(() => connection.send("late")).toThrow("closed");
	});
});

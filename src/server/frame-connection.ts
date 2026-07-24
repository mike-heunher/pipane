import type { DataChannel } from "node-datachannel";
import { gzipSync } from "node:zlib";
import type { RawData, WebSocket } from "ws";
import {
	DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES,
	DATA_CHANNEL_BUFFER_LOW_WATER_BYTES,
	DataChannelFrameDecoder,
	MAX_DATA_CHANNEL_QUEUED_BYTES,
	encodeDataChannelFrame,
	encodeDataChannelFrameCancellation,
} from "../shared/data-channel-framing.js";

export const FRAME_CONNECTION_OPEN = 1;
export const FRAME_CONNECTION_CLOSED = 3;

const compressFrame = (bytes: Uint8Array): Uint8Array => gzipSync(bytes, { level: 3 });

export interface FrameSendOptions {
	priority?: "control" | "bulk";
	/** Identifies a cancellable logical transfer such as the active session snapshot. */
	transferKey?: string;
}

export interface ServerFrameConnection {
	readonly readyState: number;
	send(frame: string, options?: FrameSendOptions): unknown;
	/** Drop queued physical chunks for a stale logical transfer. */
	cancelTransfer?(transferKey: string): void;
	close(code?: number, reason?: string): unknown;
	on(event: "message", listener: (frame: { toString(): string }) => void): this;
	on(event: "close", listener: () => void): this;
}

interface PhysicalMessage {
	value: string;
	byteLength: number;
}

interface OutgoingFrame {
	id: string;
	messages: PhysicalMessage[];
	nextIndex: number;
	transferKey?: string;
}

/**
 * Bounded two-lane scheduler shared by server WebSocket and DataChannel carriers.
 * Control frames may overtake queued bulk chunks, while each logical frame keeps
 * its own ordered chunk sequence.
 */
class PrioritizedFrameQueue {
	private readonly control: OutgoingFrame[] = [];
	private readonly bulk: OutgoingFrame[] = [];
	private nextFrameId = 0;
	private queuedBytes = 0;
	private flushing = false;

	constructor(
		private readonly idPrefix: string,
		private readonly canWrite: () => boolean,
		private readonly write: (message: string) => void,
		private readonly onFailure: () => void,
	) {}

	enqueue(frame: string, options: FrameSendOptions = {}): void {
		const id = `${this.idPrefix}${(++this.nextFrameId).toString(36)}`;
		const messages = encodeDataChannelFrame(frame, id, compressFrame).map((value) => ({
			value,
			byteLength: Buffer.byteLength(value),
		}));
		const addedBytes = messages.reduce((total, message) => total + message.byteLength, 0);
		if (this.queuedBytes + addedBytes > MAX_DATA_CHANNEL_QUEUED_BYTES) {
			this.onFailure();
			throw new Error("Carrier outgoing frame queue exceeds its limit");
		}
		const outgoing: OutgoingFrame = {
			id,
			messages,
			nextIndex: 0,
			...(options.transferKey ? { transferKey: options.transferKey } : {}),
		};
		(options.priority === "bulk" ? this.bulk : this.control).push(outgoing);
		this.queuedBytes += addedBytes;
		this.flush();
	}

	cancelTransfer(transferKey: string): void {
		const cancellationIds: string[] = [];
		for (const queue of [this.control, this.bulk]) {
			for (let index = queue.length - 1; index >= 0; index--) {
				const frame = queue[index];
				if (frame.transferKey !== transferKey) continue;
				for (let messageIndex = frame.nextIndex; messageIndex < frame.messages.length; messageIndex++) {
					this.queuedBytes -= frame.messages[messageIndex].byteLength;
				}
				if (frame.nextIndex > 0 && frame.nextIndex < frame.messages.length) {
					cancellationIds.push(frame.id);
				}
				queue.splice(index, 1);
			}
		}

		const cancellations = cancellationIds.map((id): OutgoingFrame => {
			const value = encodeDataChannelFrameCancellation(id);
			const message = { value, byteLength: Buffer.byteLength(value) };
			this.queuedBytes += message.byteLength;
			return { id: `${this.idPrefix}c${id}`, messages: [message], nextIndex: 0 };
		});
		this.control.unshift(...cancellations);
		this.flush();
	}

	flush(): void {
		if (this.flushing) return;
		this.flushing = true;
		try {
			while (this.canWrite()) {
				const queue = this.control.length > 0 ? this.control : this.bulk;
				const frame = queue[0];
				if (!frame) break;
				const message = frame.messages[frame.nextIndex];
				this.write(message.value);
				frame.nextIndex++;
				this.queuedBytes -= message.byteLength;
				if (frame.nextIndex === frame.messages.length) queue.shift();
			}
		} catch {
			this.onFailure();
		} finally {
			this.flushing = false;
		}
	}

	clear(): void {
		this.control.length = 0;
		this.bulk.length = 0;
		this.queuedBytes = 0;
	}
}

/** Adapts an authenticated reliable DataChannel to the server's logical frame connection contract. */
export class DataChannelFrameConnection implements ServerFrameConnection {
	private readonly messageListeners = new Set<(frame: { toString(): string }) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly decoder = new DataChannelFrameDecoder();
	private readonly outgoing: PrioritizedFrameQueue;
	private state = FRAME_CONNECTION_OPEN;
	private closeEmitted = false;

	constructor(private readonly channel: DataChannel) {
		this.outgoing = new PrioritizedFrameQueue(
			"s",
			() => this.readyState === FRAME_CONNECTION_OPEN
				&& channel.bufferedAmount() < DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES,
			(message) => {
				// A false result means libdatachannel accepted the message into
				// native buffering. bufferedAmount, not the result, controls flow.
				channel.sendMessage(message);
			},
			() => this.close(),
		);
		channel.setBufferedAmountLowThreshold(DATA_CHANNEL_BUFFER_LOW_WATER_BYTES);
		channel.onBufferedAmountLow(() => this.outgoing.flush());
		channel.onMessage((message) => {
			try {
				const decoded = this.decoder.accept(message.toString());
				if (decoded === undefined) return;
				const frame = { toString: () => decoded };
				for (const listener of this.messageListeners) listener(frame);
			} catch {
				this.close();
			}
		});
		channel.onClosed(() => this.finishClose());
	}

	get readyState(): number {
		return this.state === FRAME_CONNECTION_OPEN && this.channel.isOpen()
			? FRAME_CONNECTION_OPEN
			: FRAME_CONNECTION_CLOSED;
	}

	send(frame: string, options?: FrameSendOptions): void {
		if (this.readyState !== FRAME_CONNECTION_OPEN) throw new Error("DataChannel frame connection is closed");
		this.outgoing.enqueue(frame, options);
	}

	cancelTransfer(transferKey: string): void {
		this.outgoing.cancelTransfer(transferKey);
	}

	close(): void {
		if (this.state === FRAME_CONNECTION_CLOSED) return;
		this.state = FRAME_CONNECTION_CLOSED;
		try {
			this.channel.close();
		} finally {
			this.finishClose();
		}
	}

	on(event: "message" | "close", listener: ((frame: { toString(): string }) => void) | (() => void)): this {
		if (event === "message") this.messageListeners.add(listener as (frame: { toString(): string }) => void);
		else this.closeListeners.add(listener as () => void);
		return this;
	}

	private finishClose(): void {
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		this.state = FRAME_CONNECTION_CLOSED;
		this.outgoing.clear();
		this.decoder.reset();
		const listeners = [...this.closeListeners];
		this.closeListeners.clear();
		for (const listener of listeners) listener();
	}
}

/**
 * Adds the same bounded, prioritised carrier scheduler to local WebSockets.
 * Incoming browser commands remain ordinary WebSocket text frames; large
 * server responses use the shared transparent carrier envelopes.
 */
export class WebSocketFrameConnection implements ServerFrameConnection {
	private readonly outgoing: PrioritizedFrameQueue;

	constructor(private readonly socket: WebSocket) {
		this.outgoing = new PrioritizedFrameQueue(
			"w",
			() => this.readyState === FRAME_CONNECTION_OPEN
				&& socket.bufferedAmount < DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES,
			(message) => socket.send(message, (error) => {
				if (error) this.close(1011, "WebSocket send failed");
				else this.outgoing.flush();
			}),
			() => this.close(1011, "WebSocket frame queue failed"),
		);
		socket.on("close", () => this.outgoing.clear());
	}

	get readyState(): number {
		return this.socket.readyState;
	}

	send(frame: string, options?: FrameSendOptions): void {
		if (this.readyState !== FRAME_CONNECTION_OPEN) throw new Error("WebSocket frame connection is closed");
		this.outgoing.enqueue(frame, options);
	}

	cancelTransfer(transferKey: string): void {
		this.outgoing.cancelTransfer(transferKey);
	}

	close(code?: number, reason?: string): void {
		this.outgoing.clear();
		this.socket.close(code, reason);
	}

	on(event: "message", listener: (frame: { toString(): string }) => void): this;
	on(event: "close", listener: () => void): this;
	on(event: "message" | "close", listener: ((frame: { toString(): string }) => void) | (() => void)): this {
		if (event === "message") {
			this.socket.on("message", (data: RawData) => (listener as (frame: { toString(): string }) => void)(data));
		} else {
			this.socket.on("close", listener as () => void);
		}
		return this;
	}
}

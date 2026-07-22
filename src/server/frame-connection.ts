import type { DataChannel } from "node-datachannel";
import {
	DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES,
	DATA_CHANNEL_BUFFER_LOW_WATER_BYTES,
	DataChannelFrameDecoder,
	MAX_DATA_CHANNEL_QUEUED_BYTES,
	encodeDataChannelFrame,
} from "../shared/data-channel-framing.js";

export const FRAME_CONNECTION_OPEN = 1;
export const FRAME_CONNECTION_CLOSED = 3;

export interface ServerFrameConnection {
	readonly readyState: number;
	send(frame: string): unknown;
	close(code?: number, reason?: string): unknown;
	on(event: "message", listener: (frame: { toString(): string }) => void): this;
	on(event: "close", listener: () => void): this;
}

/** Adapts an authenticated reliable DataChannel to the server's logical frame connection contract. */
export class DataChannelFrameConnection implements ServerFrameConnection {
	private readonly messageListeners = new Set<(frame: { toString(): string }) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly decoder = new DataChannelFrameDecoder();
	private readonly outgoing: Array<{ message: string; byteLength: number }> = [];
	private state = FRAME_CONNECTION_OPEN;
	private nextFrameId = 0;
	private queuedBytes = 0;
	private flushing = false;
	private closeEmitted = false;

	constructor(private readonly channel: DataChannel) {
		channel.setBufferedAmountLowThreshold(DATA_CHANNEL_BUFFER_LOW_WATER_BYTES);
		channel.onBufferedAmountLow(() => this.flushOutgoing());
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

	send(frame: string): void {
		if (this.readyState !== FRAME_CONNECTION_OPEN) throw new Error("DataChannel frame connection is closed");
		const messages = encodeDataChannelFrame(frame, `s${(++this.nextFrameId).toString(36)}`);
		const additions = messages.map((message) => ({ message, byteLength: Buffer.byteLength(message) }));
		const addedBytes = additions.reduce((total, item) => total + item.byteLength, 0);
		if (this.queuedBytes + addedBytes > MAX_DATA_CHANNEL_QUEUED_BYTES) {
			this.close();
			throw new Error("DataChannel outgoing frame queue exceeds its limit");
		}
		this.outgoing.push(...additions);
		this.queuedBytes += addedBytes;
		this.flushOutgoing();
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

	private flushOutgoing(): void {
		if (this.flushing || this.readyState !== FRAME_CONNECTION_OPEN) return;
		this.flushing = true;
		try {
			while (this.outgoing.length > 0 && this.channel.bufferedAmount() < DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES) {
				const next = this.outgoing[0];
				if (!this.channel.sendMessage(next.message)) {
					this.close();
					return;
				}
				this.outgoing.shift();
				this.queuedBytes -= next.byteLength;
			}
		} catch {
			this.close();
		} finally {
			this.flushing = false;
		}
	}

	private finishClose(): void {
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		this.state = FRAME_CONNECTION_CLOSED;
		this.outgoing.length = 0;
		this.queuedBytes = 0;
		this.decoder.reset();
		const listeners = [...this.closeListeners];
		this.closeListeners.clear();
		for (const listener of listeners) listener();
	}
}

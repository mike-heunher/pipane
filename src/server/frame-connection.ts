import type { DataChannel } from "node-datachannel";

export const FRAME_CONNECTION_OPEN = 1;
export const FRAME_CONNECTION_CLOSED = 3;

export interface ServerFrameConnection {
	readonly readyState: number;
	send(frame: string): unknown;
	close(code?: number, reason?: string): unknown;
	on(event: "message", listener: (frame: { toString(): string }) => void): this;
	on(event: "close", listener: () => void): this;
}

/** Adapts an authenticated reliable DataChannel to the server's frame connection contract. */
export class DataChannelFrameConnection implements ServerFrameConnection {
	private readonly messageListeners = new Set<(frame: { toString(): string }) => void>();
	private readonly closeListeners = new Set<() => void>();
	private state = FRAME_CONNECTION_OPEN;

	constructor(private readonly channel: DataChannel) {
		channel.onMessage((message) => {
			for (const listener of this.messageListeners) listener(message);
		});
		channel.onClosed(() => {
			if (this.state === FRAME_CONNECTION_CLOSED) return;
			this.state = FRAME_CONNECTION_CLOSED;
			for (const listener of this.closeListeners) listener();
		});
	}

	get readyState(): number {
		return this.state === FRAME_CONNECTION_OPEN && this.channel.isOpen()
			? FRAME_CONNECTION_OPEN
			: FRAME_CONNECTION_CLOSED;
	}

	send(frame: string): void {
		if (this.readyState !== FRAME_CONNECTION_OPEN || !this.channel.sendMessage(frame)) {
			throw new Error("DataChannel frame connection is closed");
		}
	}

	close(): void {
		if (this.state === FRAME_CONNECTION_CLOSED) return;
		this.state = FRAME_CONNECTION_CLOSED;
		this.channel.close();
		for (const listener of this.closeListeners) listener();
	}

	on(event: "message" | "close", listener: ((frame: { toString(): string }) => void) | (() => void)): this {
		if (event === "message") this.messageListeners.add(listener as (frame: { toString(): string }) => void);
		else this.closeListeners.add(listener as () => void);
		return this;
	}
}

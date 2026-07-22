import { isBackendProtocolFrame } from "../shared/backend-protocol.js";
import type { FrameSendOptions, ServerFrameConnection } from "./frame-connection.js";

class RoutedFrameConnection implements ServerFrameConnection {
	private readonly messageListeners = new Set<(frame: { toString(): string }) => void>();
	private readonly closeListeners = new Set<() => void>();

	constructor(private readonly connection: ServerFrameConnection) {}

	get readyState(): number { return this.connection.readyState; }
	send(frame: string, options?: FrameSendOptions): unknown { return this.connection.send(frame, options); }
	cancelTransfer(transferKey: string): void { this.connection.cancelTransfer?.(transferKey); }
	close(code?: number, reason?: string): unknown { return this.connection.close(code, reason); }

	on(event: "message", listener: (frame: { toString(): string }) => void): this;
	on(event: "close", listener: () => void): this;
	on(event: "message" | "close", listener: ((frame: { toString(): string }) => void) | (() => void)): this {
		if (event === "message") this.messageListeners.add(listener as (frame: { toString(): string }) => void);
		else this.closeListeners.add(listener as () => void);
		return this;
	}

	emitMessage(raw: string): void {
		const frame = { toString: () => raw };
		for (const listener of this.messageListeners) listener(frame);
	}

	emitClose(): void {
		for (const listener of this.closeListeners) listener();
	}
}

/** Splits application v1 and semantic v2 frames without creating extra DataChannels. */
export function routeFrameConnection(connection: ServerFrameConnection): {
	application: ServerFrameConnection;
	semantic: ServerFrameConnection;
} {
	const application = new RoutedFrameConnection(connection);
	const semantic = new RoutedFrameConnection(connection);
	connection.on("message", (frame) => {
		const raw = frame.toString();
		if (isBackendProtocolFrame(raw)) semantic.emitMessage(raw);
		else application.emitMessage(raw);
	});
	connection.on("close", () => {
		application.emitClose();
		semantic.emitClose();
	});
	return { application, semantic };
}

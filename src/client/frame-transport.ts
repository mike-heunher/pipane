export interface FrameTransportConnectionEvent {
	connected: boolean;
	/** True only when a previously connected transport has recovered. */
	reconnected: boolean;
}

/**
 * Ordered text-frame carrier used by the browser protocol client.
 *
 * WebSocket and reliable ordered WebRTC DataChannels both preserve message
 * boundaries, so neither protocol nor application state needs to know which
 * carrier is active.
 */
export interface FrameTransport {
	readonly isConnected: boolean;
	readonly isReconnecting: boolean;

	connect(endpoint: string): Promise<void>;
	send(frame: string): void;
	close(code?: number, reason?: string): void;
	onFrame(listener: (frame: string) => void): () => void;
	onConnectionChange(listener: (event: FrameTransportConnectionEvent) => void): () => void;
}

import type { FrameTransport, FrameTransportConnectionEvent } from "./frame-transport.js";

const SOCKET_OPEN = 1;
const MAX_RECONNECT_DELAY_MS = 10_000;

export type WebSocketLike = Pick<
	WebSocket,
	"readyState" | "send" | "close" | "onopen" | "onerror" | "onclose" | "onmessage"
>;

export interface WebSocketFrameTransportOptions {
	/** Existing open socket for deterministic tests. */
	socket?: WebSocketLike;
	createWebSocket?: (endpoint: string) => WebSocketLike;
	schedule?: typeof globalThis.setTimeout;
	cancelSchedule?: typeof globalThis.clearTimeout;
}

/** Reliable text-frame transport with automatic WebSocket reconnection. */
export class WebSocketFrameTransport implements FrameTransport {
	private socket: WebSocketLike | null = null;
	private endpoint: string | undefined;
	private reconnecting = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private manuallyClosed = false;
	private readonly frameListeners = new Set<(frame: string) => void>();
	private readonly connectionListeners = new Set<(event: FrameTransportConnectionEvent) => void>();
	private readonly createWebSocket: (endpoint: string) => WebSocketLike;
	private readonly schedule: typeof globalThis.setTimeout;
	private readonly cancelSchedule: typeof globalThis.clearTimeout;

	constructor(options: WebSocketFrameTransportOptions = {}) {
		this.createWebSocket = options.createWebSocket ?? ((endpoint) => new WebSocket(endpoint));
		this.schedule = options.schedule ?? globalThis.setTimeout.bind(globalThis);
		this.cancelSchedule = options.cancelSchedule ?? globalThis.clearTimeout.bind(globalThis);
		if (options.socket) {
			this.socket = options.socket;
			this.attachFrameHandler(options.socket);
		}
	}

	get isConnected(): boolean {
		return this.socket?.readyState === SOCKET_OPEN;
	}

	get isReconnecting(): boolean {
		return this.reconnecting;
	}

	onFrame(listener: (frame: string) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onConnectionChange(listener: (event: FrameTransportConnectionEvent) => void): () => void {
		this.connectionListeners.add(listener);
		return () => this.connectionListeners.delete(listener);
	}

	async connect(endpoint: string): Promise<void> {
		if (this.isConnected) return;
		this.endpoint = endpoint;
		this.manuallyClosed = false;
		await this.openSocket(false);
	}

	send(frame: string): void {
		if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
			throw new Error("Backend transport is not connected");
		}
		this.socket.send(frame);
	}

	close(code = 1000, reason = "Client closed"): void {
		this.manuallyClosed = true;
		this.reconnecting = false;
		if (this.reconnectTimer) {
			this.cancelSchedule(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.socket?.close(code, reason);
	}

	private attachFrameHandler(socket: WebSocketLike): void {
		socket.onmessage = (event) => {
			const frame = String(event.data);
			for (const listener of this.frameListeners) listener(frame);
		};
	}

	private emitConnectionChange(event: FrameTransportConnectionEvent): void {
		for (const listener of this.connectionListeners) listener(event);
	}

	private openSocket(reconnected: boolean): Promise<void> {
		const endpoint = this.endpoint;
		if (!endpoint) return Promise.reject(new Error("Backend transport endpoint is missing"));

		return new Promise<void>((resolve, reject) => {
			const socket = this.createWebSocket(endpoint);
			let opened = false;
			let settled = false;
			this.socket = socket;
			this.attachFrameHandler(socket);

			socket.onopen = () => {
				if (this.socket !== socket) return;
				opened = true;
				settled = true;
				this.reconnecting = false;
				this.reconnectAttempt = 0;
				this.emitConnectionChange({ connected: true, reconnected });
				resolve();
			};

			socket.onerror = () => {
				if (!reconnected && !settled) {
					settled = true;
					reject(new Error("WebSocket connection failed"));
				}
			};

			socket.onclose = () => {
				if (this.socket === socket) this.socket = null;
				if (!settled) {
					settled = true;
					reject(new Error("WebSocket closed before connecting"));
				}

				if (this.manuallyClosed) {
					if (opened) this.emitConnectionChange({ connected: false, reconnected: false });
					return;
				}

				if (opened || reconnected) {
					this.scheduleReconnect();
					if (opened) this.emitConnectionChange({ connected: false, reconnected: false });
				}
			};
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.manuallyClosed) return;
		this.reconnecting = true;
		this.reconnectAttempt++;
		const delay = Math.min(500 * 2 ** (this.reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);

		this.reconnectTimer = this.schedule(() => {
			this.reconnectTimer = undefined;
			void this.openSocket(true).catch(() => {
				// A reconnecting socket schedules the next attempt from onclose.
			});
		}, delay);
	}
}

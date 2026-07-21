import {
	RENDEZVOUS_PROTOCOL_VERSION,
	decodeBrowserMessage,
	encodeRendezvousMessage,
	rendezvousWebSocketUrl,
	type IceSignal,
	type RendezvousErrorMessage,
} from "../shared/rendezvous-protocol.js";

export type BrowserRendezvousSocket = Pick<
	WebSocket,
	"readyState" | "send" | "close" | "onopen" | "onerror" | "onclose" | "onmessage"
>;

export interface BrowserRendezvousClientOptions {
	url: string;
	backendId: string;
	createWebSocket?: (url: string) => BrowserRendezvousSocket;
}

/** One browser/backend signaling route; application data never passes through it. */
export class BrowserRendezvousClient {
	private readonly endpoint: string;
	private readonly backendId: string;
	private readonly createWebSocket: (url: string) => BrowserRendezvousSocket;
	private readonly signalListeners = new Set<(signal: IceSignal) => void>();
	private readonly closedListeners = new Set<(reason: string) => void>();
	private readonly errorListeners = new Set<(error: RendezvousErrorMessage | Error) => void>();
	private socket: BrowserRendezvousSocket | null = null;
	private connectionId: string | undefined;
	private connecting: Promise<string> | undefined;
	private resolveConnecting: ((connectionId: string) => void) | undefined;
	private rejectConnecting: ((error: Error) => void) | undefined;

	constructor(options: BrowserRendezvousClientOptions) {
		this.endpoint = rendezvousWebSocketUrl(options.url, "browser");
		this.backendId = options.backendId;
		this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
	}

	get activeConnectionId(): string | undefined {
		return this.connectionId;
	}

	connect(): Promise<string> {
		if (this.connectionId) return Promise.resolve(this.connectionId);
		if (this.connecting) return this.connecting;
		this.connecting = new Promise<string>((resolve, reject) => {
			this.resolveConnecting = resolve;
			this.rejectConnecting = reject;
		});
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.sendRaw({ type: "connect_backend", backendId: this.backendId });
			return this.connecting;
		}

		const socket = this.createWebSocket(this.endpoint);
		this.socket = socket;
		socket.onopen = () => this.sendRaw({ type: "connect_backend", backendId: this.backendId });
		socket.onmessage = (event) => this.handleMessage(socket, String(event.data));
		socket.onerror = () => {
			const error = new Error("Rendezvous WebSocket failed");
			this.emitError(error);
			this.failConnection(error);
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.socket = null;
			const hadConnection = this.connectionId !== undefined;
			this.connectionId = undefined;
			const error = new Error("Rendezvous WebSocket closed");
			this.failConnection(error);
			if (hadConnection) {
				for (const listener of this.closedListeners) listener(error.message);
			}
		};
		return this.connecting;
	}

	onSignal(listener: (signal: IceSignal) => void): () => void {
		this.signalListeners.add(listener);
		return () => this.signalListeners.delete(listener);
	}

	onConnectionClosed(listener: (reason: string) => void): () => void {
		this.closedListeners.add(listener);
		return () => this.closedListeners.delete(listener);
	}

	onError(listener: (error: RendezvousErrorMessage | Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	sendSignal(signal: IceSignal): void {
		if (!this.connectionId) throw new Error("Browser rendezvous route is not connected");
		this.sendRaw({ type: "signal", connectionId: this.connectionId, signal });
	}

	close(reason = "Browser closed connection"): void {
		if (this.connectionId && this.socket?.readyState === WebSocket.OPEN) {
			this.sendRaw({ type: "close_connection", connectionId: this.connectionId, reason });
		}
		this.connectionId = undefined;
		this.socket?.close(1000, reason);
		this.socket = null;
		this.failConnection(new Error(reason));
	}

	private handleMessage(socket: BrowserRendezvousSocket, raw: string): void {
		if (socket !== this.socket) return;
		const decoded = decodeBrowserMessage(raw);
		if (!decoded.ok) {
			const error = new Error(decoded.error.message);
			this.emitError(error);
			this.failConnection(error);
			socket.close(1002, "Invalid rendezvous message");
			return;
		}
		const message = decoded.value;
		switch (message.type) {
			case "backend_connected":
				if (message.backendId !== this.backendId) {
					const error = new Error("Rendezvous connected an unexpected backend");
					this.emitError(error);
					this.failConnection(error);
					socket.close(1002, "Backend identity mismatch");
					return;
				}
				this.connectionId = message.connectionId;
				this.resolveConnecting?.(message.connectionId);
				this.clearConnecting();
				break;
			case "signal":
				if (message.connectionId !== this.connectionId) return;
				for (const listener of this.signalListeners) listener(message.signal);
				break;
			case "connection_closed":
				if (message.connectionId !== this.connectionId) return;
				this.connectionId = undefined;
				for (const listener of this.closedListeners) listener(message.reason);
				break;
			case "error":
				this.emitError(message);
				if (!this.connectionId) this.failConnection(new Error(message.message));
				break;
		}
	}

	private sendRaw(command: object): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("Rendezvous WebSocket is not connected");
		}
		this.socket.send(encodeRendezvousMessage({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			...command,
		}));
	}

	private failConnection(error: Error): void {
		this.rejectConnecting?.(error);
		this.clearConnecting();
	}

	private clearConnecting(): void {
		this.connecting = undefined;
		this.resolveConnecting = undefined;
		this.rejectConnecting = undefined;
	}

	private emitError(error: RendezvousErrorMessage | Error): void {
		for (const listener of this.errorListeners) listener(error);
	}
}

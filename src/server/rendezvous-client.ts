import { WebSocket } from "ws";
import {
	RENDEZVOUS_PROTOCOL_VERSION,
	decodeBackendMessage,
	encodeRendezvousMessage,
	type BackendRegistrationMetadata,
	type BackendRendezvousCommand,
	type IceSignal,
	type RendezvousErrorMessage,
	type WithoutProtocolVersion,
	rendezvousWebSocketUrl,
} from "../shared/rendezvous-protocol.js";
import type { BackendIdentityBinding, IceServerConfiguration } from "../shared/trust-protocol.js";
import { signBackendChallenge, type BackendIdentity } from "./backend-identity.js";

export { rendezvousWebSocketUrl } from "../shared/rendezvous-protocol.js";

export interface BackendConnectionRequest {
	connectionId: string;
	ticket: string;
	iceServers: IceServerConfiguration[];
}

export interface PairingConfirmation {
	connectionId: string;
	pairId: string;
	accountId: string;
	deviceId: string;
}

export interface AuthorizationRevocation {
	accountId: string;
	deviceId?: string;
}

export interface BackendRendezvousClientOptions {
	url: string;
	identity: BackendIdentity;
	metadata: BackendRegistrationMetadata;
	createWebSocket?: (url: string) => WebSocket;
	schedule?: typeof globalThis.setTimeout;
	cancelSchedule?: typeof globalThis.clearTimeout;
	maxReconnectDelayMs?: number;
}

export class BackendRendezvousClient {
	private readonly endpoint: string;
	private readonly identity: BackendIdentity;
	private readonly metadata: BackendRegistrationMetadata;
	private readonly createWebSocket: (url: string) => WebSocket;
	private readonly schedule: typeof globalThis.setTimeout;
	private readonly cancelSchedule: typeof globalThis.clearTimeout;
	private readonly maxReconnectDelayMs: number;
	private readonly statusListeners = new Set<(connected: boolean) => void>();
	private readonly connectionListeners = new Set<(request: BackendConnectionRequest) => void>();
	private readonly signalListeners = new Set<(connectionId: string, signal: IceSignal) => void>();
	private readonly closedListeners = new Set<(connectionId: string, reason: string) => void>();
	private readonly revocationListeners = new Set<(revocation: AuthorizationRevocation) => void>();
	private readonly errorListeners = new Set<(error: RendezvousErrorMessage | Error) => void>();
	private readonly activePairings = new Map<string, number>();
	private readonly pairingResolvers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
	private readonly confirmationResolvers = new Map<string, {
		resolve: (confirmation: PairingConfirmation) => void;
		reject: (error: Error) => void;
	}>();
	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private stopped = true;
	private registered = false;
	private firstRegistrationSettled = false;
	private readonly firstRegistration: Promise<string>;
	private resolveFirstRegistration!: (backendId: string) => void;
	private rejectFirstRegistration!: (error: Error) => void;
	private _ticketPublicKey: string | undefined;
	private _iceServers: IceServerConfiguration[] = [];

	constructor(options: BackendRendezvousClientOptions) {
		this.endpoint = rendezvousWebSocketUrl(options.url, "backend");
		this.identity = options.identity;
		this.metadata = options.metadata;
		this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
		this.schedule = options.schedule ?? globalThis.setTimeout.bind(globalThis);
		this.cancelSchedule = options.cancelSchedule ?? globalThis.clearTimeout.bind(globalThis);
		this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 10_000;
		this.firstRegistration = new Promise<string>((resolve, reject) => {
			this.resolveFirstRegistration = resolve;
			this.rejectFirstRegistration = reject;
		});
	}

	get isRegistered(): boolean {
		return this.registered;
	}

	get ticketPublicKey(): string {
		if (!this._ticketPublicKey) throw new Error("Rendezvous ticket verification key is unavailable");
		return this._ticketPublicKey;
	}

	get iceServers(): IceServerConfiguration[] {
		return this._iceServers.map((server) => ({
			...server,
			urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
		}));
	}

	start(): Promise<string> {
		if (this.stopped) {
			this.stopped = false;
			this.open();
		}
		return this.firstRegistration;
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.registered = false;
		if (this.reconnectTimer) {
			this.cancelSchedule(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const error = new Error("Rendezvous client stopped");
		if (!this.firstRegistrationSettled) {
			this.firstRegistrationSettled = true;
			this.rejectFirstRegistration(error);
		}
		for (const pending of this.pairingResolvers.values()) pending.reject(error);
		for (const pending of this.confirmationResolvers.values()) pending.reject(error);
		this.pairingResolvers.clear();
		this.confirmationResolvers.clear();
		this.socket?.close(1000, "Backend stopped");
		this.socket = null;
	}

	onStatus(listener: (connected: boolean) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	onConnectionRequest(listener: (request: BackendConnectionRequest) => void): () => void {
		this.connectionListeners.add(listener);
		return () => this.connectionListeners.delete(listener);
	}

	onSignal(listener: (connectionId: string, signal: IceSignal) => void): () => void {
		this.signalListeners.add(listener);
		return () => this.signalListeners.delete(listener);
	}

	onConnectionClosed(listener: (connectionId: string, reason: string) => void): () => void {
		this.closedListeners.add(listener);
		return () => this.closedListeners.delete(listener);
	}

	onAuthorizationRevoked(listener: (revocation: AuthorizationRevocation) => void): () => void {
		this.revocationListeners.add(listener);
		return () => this.revocationListeners.delete(listener);
	}

	onError(listener: (error: RendezvousErrorMessage | Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	openPairing(pairId: string, expiresAt: number): Promise<void> {
		this.activePairings.set(pairId, expiresAt);
		const existing = this.pairingResolvers.get(pairId);
		if (existing) return Promise.reject(new Error("Pairing request is already pending"));
		const promise = new Promise<void>((resolve, reject) => this.pairingResolvers.set(pairId, { resolve, reject }));
		if (this.registered) this.send({ type: "open_pairing", pairId, expiresAt });
		return promise;
	}

	confirmPairing(connectionId: string): Promise<PairingConfirmation> {
		if (this.confirmationResolvers.has(connectionId)) return Promise.reject(new Error("Pairing confirmation is already pending"));
		const promise = new Promise<PairingConfirmation>((resolve, reject) => {
			this.confirmationResolvers.set(connectionId, { resolve, reject });
		});
		this.send({ type: "confirm_pairing", connectionId });
		return promise;
	}

	sendSignal(connectionId: string, signal: IceSignal): void {
		this.send({ type: "signal", connectionId, signal });
	}

	sendIdentityBinding(connectionId: string, binding: BackendIdentityBinding): void {
		this.send({ type: "connection_binding", connectionId, binding });
	}

	closeConnection(connectionId: string, reason?: string): void {
		this.send({ type: "close_connection", connectionId, reason });
	}

	private open(): void {
		if (this.stopped) return;
		const socket = this.createWebSocket(this.endpoint);
		this.socket = socket;

		socket.on("message", (raw) => this.handleMessage(socket, raw.toString()));
		socket.on("error", (error) => this.emitError(error));
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.socket = null;
			const interruption = new Error("Rendezvous disconnected during pairing confirmation");
			for (const pending of this.confirmationResolvers.values()) pending.reject(interruption);
			this.confirmationResolvers.clear();
			const wasRegistered = this.registered;
			this.registered = false;
			if (wasRegistered) this.emitStatus(false);
			if (!this.stopped) this.scheduleReconnect();
		});
	}

	private handleMessage(socket: WebSocket, raw: string): void {
		if (socket !== this.socket) return;
		const decoded = decodeBackendMessage(raw);
		if (!decoded.ok) {
			this.emitError(new Error(decoded.error.message));
			socket.close(1002, "Invalid rendezvous message");
			return;
		}
		const message = decoded.value;
		switch (message.type) {
			case "challenge":
				this.sendRaw({
					type: "register_backend",
					publicKey: this.identity.publicKey,
					signature: signBackendChallenge(this.identity, message.nonce),
					metadata: this.metadata,
				});
				break;
			case "registered":
				if (message.backendId !== this.identity.backendId) {
					this.emitError(new Error("Rendezvous registered an unexpected backend identity"));
					socket.close(1002, "Backend identity mismatch");
					return;
				}
				this._ticketPublicKey = message.ticketPublicKey;
				this._iceServers = message.iceServers;
				this.registered = true;
				this.reconnectAttempt = 0;
				this.emitStatus(true);
				if (!this.firstRegistrationSettled) {
					this.firstRegistrationSettled = true;
					this.resolveFirstRegistration(message.backendId);
				}
				for (const [pairId, expiresAt] of this.activePairings) {
					if (expiresAt > Date.now()) this.send({ type: "open_pairing", pairId, expiresAt });
					else this.activePairings.delete(pairId);
				}
				break;
			case "pairing_opened": {
				const pending = this.pairingResolvers.get(message.pairId);
				this.pairingResolvers.delete(message.pairId);
				pending?.resolve();
				break;
			}
			case "pairing_confirmed": {
				const pending = this.confirmationResolvers.get(message.connectionId);
				this.confirmationResolvers.delete(message.connectionId);
				this.activePairings.delete(message.pairId);
				pending?.resolve(message);
				break;
			}
			case "connection_request":
				for (const listener of this.connectionListeners) listener({
					connectionId: message.connectionId,
					ticket: message.ticket,
					iceServers: message.iceServers,
				});
				break;
			case "signal":
				for (const listener of this.signalListeners) listener(message.connectionId, message.signal);
				break;
			case "connection_closed": {
				const pending = this.confirmationResolvers.get(message.connectionId);
				this.confirmationResolvers.delete(message.connectionId);
				pending?.reject(new Error(message.reason));
				for (const listener of this.closedListeners) listener(message.connectionId, message.reason);
				break;
			}
			case "authorization_revoked":
				for (const listener of this.revocationListeners) listener(message);
				break;
			case "error": {
				this.emitError(message);
				if (message.connectionId) {
					const pending = this.confirmationResolvers.get(message.connectionId);
					this.confirmationResolvers.delete(message.connectionId);
					pending?.reject(new Error(message.message));
				}
				break;
			}
		}
	}

	private send(command: WithoutProtocolVersion<BackendRendezvousCommand>): void {
		if (!this.registered) throw new Error("Backend is not registered with rendezvous");
		this.sendRaw(command);
	}

	private sendRaw(command: object): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Rendezvous WebSocket is not connected");
		this.socket.send(encodeRendezvousMessage({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, ...command }));
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.stopped) return;
		this.reconnectAttempt++;
		const delay = Math.min(500 * 2 ** (this.reconnectAttempt - 1), this.maxReconnectDelayMs);
		this.reconnectTimer = this.schedule(() => {
			this.reconnectTimer = undefined;
			this.open();
		}, delay);
	}

	private emitStatus(connected: boolean): void {
		for (const listener of this.statusListeners) listener(connected);
	}

	private emitError(error: RendezvousErrorMessage | Error): void {
		for (const listener of this.errorListeners) listener(error);
	}
}

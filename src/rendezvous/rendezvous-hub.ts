import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
	RENDEZVOUS_PROTOCOL_VERSION,
	decodeBackendCommand,
	decodeBrowserCommand,
	encodeRendezvousMessage,
	type BackendRegistrationMetadata,
	type BackendRendezvousMessage,
	type BrowserRendezvousMessage,
	type IceSignal,
	type RendezvousErrorCode,
	type WithoutProtocolVersion,
} from "../shared/rendezvous-protocol.js";
import {
	deriveBackendId,
	verifyBackendChallenge,
} from "../server/backend-identity.js";

interface RegisteredBackend {
	backendId: string;
	metadata: BackendRegistrationMetadata;
	socket: WebSocket;
}

interface BackendHandshake {
	nonce: string;
	registered?: RegisteredBackend;
	timeout: ReturnType<typeof setTimeout>;
}

interface BrowserRoute {
	connectionId: string;
	backendId: string;
	browser: WebSocket;
}

export interface RendezvousHubOptions {
	registrationTimeoutMs?: number;
}

export class RendezvousHub {
	private readonly registrationTimeoutMs: number;
	private readonly backendHandshakes = new Map<WebSocket, BackendHandshake>();
	private readonly backends = new Map<string, RegisteredBackend>();
	private readonly browserRoutes = new Map<WebSocket, BrowserRoute>();
	private readonly routes = new Map<string, BrowserRoute>();
	private readonly registeredListeners = new Set<(backendId: string) => void>();

	constructor(options: RendezvousHubOptions = {}) {
		this.registrationTimeoutMs = options.registrationTimeoutMs ?? 10_000;
	}

	onBackendRegistered(listener: (backendId: string) => void): () => void {
		this.registeredListeners.add(listener);
		return () => this.registeredListeners.delete(listener);
	}

	isBackendOnline(backendId: string): boolean {
		return this.backends.get(backendId)?.socket.readyState === WebSocket.OPEN;
	}

	getBackendMetadata(backendId: string): BackendRegistrationMetadata | undefined {
		return this.backends.get(backendId)?.metadata;
	}

	acceptBackend(socket: WebSocket): void {
		const nonce = randomBytes(32).toString("base64url");
		const timeout = setTimeout(() => {
			this.sendError(socket, "unauthorized_connection", "Backend registration timed out");
			socket.close(1008, "Registration timed out");
		}, this.registrationTimeoutMs);
		timeout.unref?.();
		this.backendHandshakes.set(socket, { nonce, timeout });
		this.sendBackend(socket, { type: "challenge", nonce });

		socket.on("message", (raw) => this.handleBackendMessage(socket, raw.toString()));
		socket.on("close", () => this.removeBackendSocket(socket));
	}

	acceptBrowser(socket: WebSocket): void {
		socket.on("message", (raw) => this.handleBrowserMessage(socket, raw.toString()));
		socket.on("close", () => this.removeBrowser(socket, "Browser disconnected"));
	}

	close(): void {
		for (const handshake of this.backendHandshakes.values()) clearTimeout(handshake.timeout);
		for (const backend of this.backends.values()) backend.socket.close(1001, "Rendezvous shutting down");
		for (const browser of this.browserRoutes.keys()) browser.close(1001, "Rendezvous shutting down");
		this.backendHandshakes.clear();
		this.backends.clear();
		this.browserRoutes.clear();
		this.routes.clear();
	}

	private handleBackendMessage(socket: WebSocket, raw: string): void {
		const decoded = decodeBackendCommand(raw);
		if (!decoded.ok) {
			this.sendError(socket, decoded.error.code, decoded.error.message);
			return;
		}
		const handshake = this.backendHandshakes.get(socket);
		if (!handshake) {
			this.sendError(socket, "unauthorized_connection", "Unknown backend connection");
			return;
		}
		const command = decoded.value;

		if (!handshake.registered) {
			if (command.type !== "register_backend") {
				this.sendError(socket, "unauthorized_connection", "Backend must register before signaling");
				return;
			}
			this.registerBackend(socket, handshake, command.publicKey, command.signature, command.metadata);
			return;
		}

		if (command.type === "register_backend") {
			this.sendError(socket, "invalid_message", "Backend is already registered");
			return;
		}
		if (command.type === "signal") {
			this.relayBackendSignal(handshake.registered, command.connectionId, command.signal);
			return;
		}
		this.closeFromBackend(handshake.registered, command.connectionId, command.reason ?? "Backend closed connection");
	}

	private registerBackend(
		socket: WebSocket,
		handshake: BackendHandshake,
		publicKey: string,
		signature: string,
		metadata: BackendRegistrationMetadata,
	): void {
		if (!verifyBackendChallenge(publicKey, handshake.nonce, signature)) {
			this.sendError(socket, "unauthorized_connection", "Invalid backend registration signature");
			socket.close(1008, "Invalid registration signature");
			return;
		}

		let backendId: string;
		try {
			backendId = deriveBackendId(publicKey);
		} catch {
			this.sendError(socket, "invalid_message", "Invalid backend public key");
			socket.close(1008, "Invalid public key");
			return;
		}

		const previous = this.backends.get(backendId);
		if (previous && previous.socket !== socket) {
			this.removeRegisteredBackend(previous, "Backend reconnected");
			previous.socket.close(4001, "Replaced by a newer connection");
		}

		clearTimeout(handshake.timeout);
		const registered = { backendId, metadata, socket };
		handshake.registered = registered;
		this.backends.set(backendId, registered);
		this.sendBackend(socket, { type: "registered", backendId });
		for (const listener of this.registeredListeners) listener(backendId);
	}

	private relayBackendSignal(backend: RegisteredBackend, connectionId: string, signal: IceSignal): void {
		const route = this.routes.get(connectionId);
		if (!route || route.backendId !== backend.backendId) {
			this.sendError(backend.socket, "unauthorized_connection", "Connection does not belong to this backend", connectionId);
			return;
		}
		this.sendBrowser(route.browser, { type: "signal", connectionId, signal });
	}

	private closeFromBackend(backend: RegisteredBackend, connectionId: string, reason: string): void {
		const route = this.routes.get(connectionId);
		if (!route || route.backendId !== backend.backendId) {
			this.sendError(backend.socket, "unauthorized_connection", "Connection does not belong to this backend", connectionId);
			return;
		}
		this.removeRoute(route);
		this.sendBrowser(route.browser, { type: "connection_closed", connectionId, reason });
	}

	private handleBrowserMessage(socket: WebSocket, raw: string): void {
		const decoded = decodeBrowserCommand(raw);
		if (!decoded.ok) {
			this.sendBrowserError(socket, decoded.error.code, decoded.error.message);
			return;
		}
		const command = decoded.value;
		if (command.type === "connect_backend") {
			this.connectBrowser(socket, command.backendId);
			return;
		}

		const route = this.browserRoutes.get(socket);
		if (!route || route.connectionId !== command.connectionId) {
			this.sendBrowserError(socket, "unauthorized_connection", "Connection does not belong to this browser", command.connectionId);
			return;
		}
		const backend = this.backends.get(route.backendId);
		if (!backend || backend.socket.readyState !== WebSocket.OPEN) {
			this.removeRoute(route);
			this.sendBrowserError(socket, "backend_offline", "Backend is offline", command.connectionId);
			return;
		}

		if (command.type === "signal") {
			this.sendBackend(backend.socket, {
				type: "signal",
				connectionId: command.connectionId,
				signal: command.signal,
			});
			return;
		}
		this.removeRoute(route);
		this.sendBackend(backend.socket, {
			type: "connection_closed",
			connectionId: command.connectionId,
			reason: command.reason ?? "Browser closed connection",
		});
	}

	private connectBrowser(socket: WebSocket, backendId: string): void {
		const backend = this.backends.get(backendId);
		if (!backend || backend.socket.readyState !== WebSocket.OPEN) {
			this.sendBrowserError(socket, "backend_offline", "Backend is offline");
			return;
		}

		const previous = this.browserRoutes.get(socket);
		if (previous) {
			this.removeRoute(previous);
			const previousBackend = this.backends.get(previous.backendId);
			if (previousBackend) {
				this.sendBackend(previousBackend.socket, {
					type: "connection_closed",
					connectionId: previous.connectionId,
					reason: "Browser opened another connection",
				});
			}
		}

		const connectionId = `c_${randomUUID()}`;
		const route = { connectionId, backendId, browser: socket };
		this.routes.set(connectionId, route);
		this.browserRoutes.set(socket, route);
		this.sendBackend(backend.socket, { type: "connection_request", connectionId });
		this.sendBrowser(socket, { type: "backend_connected", backendId, connectionId });
	}

	private removeBackendSocket(socket: WebSocket): void {
		const handshake = this.backendHandshakes.get(socket);
		if (!handshake) return;
		clearTimeout(handshake.timeout);
		this.backendHandshakes.delete(socket);
		if (handshake.registered && this.backends.get(handshake.registered.backendId)?.socket === socket) {
			this.removeRegisteredBackend(handshake.registered, "Backend disconnected");
		}
	}

	private removeRegisteredBackend(backend: RegisteredBackend, reason: string): void {
		if (this.backends.get(backend.backendId)?.socket === backend.socket) this.backends.delete(backend.backendId);
		for (const route of [...this.routes.values()]) {
			if (route.backendId !== backend.backendId) continue;
			this.removeRoute(route);
			this.sendBrowser(route.browser, { type: "connection_closed", connectionId: route.connectionId, reason });
		}
	}

	private removeBrowser(socket: WebSocket, reason: string): void {
		const route = this.browserRoutes.get(socket);
		if (!route) return;
		this.removeRoute(route);
		const backend = this.backends.get(route.backendId);
		if (backend) {
			this.sendBackend(backend.socket, { type: "connection_closed", connectionId: route.connectionId, reason });
		}
	}

	private removeRoute(route: BrowserRoute): void {
		if (this.routes.get(route.connectionId) === route) this.routes.delete(route.connectionId);
		if (this.browserRoutes.get(route.browser) === route) this.browserRoutes.delete(route.browser);
	}

	private sendBackend(socket: WebSocket, payload: WithoutProtocolVersion<BackendRendezvousMessage>): void {
		this.send(socket, payload);
	}

	private sendBrowser(socket: WebSocket, payload: WithoutProtocolVersion<BrowserRendezvousMessage>): void {
		this.send(socket, payload);
	}

	private sendError(socket: WebSocket, code: RendezvousErrorCode, message: string, connectionId?: string): void {
		this.sendBackend(socket, { type: "error", code, message, connectionId });
	}

	private sendBrowserError(socket: WebSocket, code: RendezvousErrorCode, message: string, connectionId?: string): void {
		this.sendBrowser(socket, { type: "error", code, message, connectionId });
	}

	private send(socket: WebSocket, payload: object): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		socket.send(encodeRendezvousMessage({
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			...payload,
		}));
	}
}

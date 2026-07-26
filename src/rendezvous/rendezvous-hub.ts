import { randomBytes } from "node:crypto";
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
import type { ConnectionTicketClaims, IceServerConfiguration } from "../shared/trust-protocol.js";
import {
	deriveBackendId,
	extractDtlsFingerprint,
	sha256Base64Url,
	verifyBackendChallenge,
	verifyBackendIdentityBinding,
} from "../server/backend-identity.js";
import {
	IceServerProvider,
	RendezvousTrustStore,
	type RevocationResult,
} from "./trust-store.js";

const MAX_PAIRING_LIFETIME_MS = 15 * 60_000;

interface RegisteredBackend {
	backendId: string;
	publicKey: string;
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
	ticket: string;
	claims: ConnectionTicketClaims;
	offerSdp?: string;
	answerSdp?: string;
}

interface ActivePairing {
	pairId: string;
	backendId: string;
	expiresAt: number;
}

export interface RendezvousHubOptions {
	trustStore: RendezvousTrustStore;
	iceServerProvider?: IceServerProvider;
	registrationTimeoutMs?: number;
	now?: () => number;
}

export class RendezvousHub {
	readonly trustStore: RendezvousTrustStore;
	private readonly iceServerProvider: IceServerProvider;
	private readonly registrationTimeoutMs: number;
	private readonly now: () => number;
	private readonly backendHandshakes = new Map<WebSocket, BackendHandshake>();
	private readonly backends = new Map<string, RegisteredBackend>();
	private readonly browserRoutes = new Map<WebSocket, BrowserRoute>();
	private readonly routes = new Map<string, BrowserRoute>();
	private readonly pairings = new Map<string, ActivePairing>();
	private readonly registeredListeners = new Set<(backendId: string) => void>();

	constructor(options: RendezvousHubOptions) {
		this.trustStore = options.trustStore;
		this.iceServerProvider = options.iceServerProvider ?? new IceServerProvider();
		this.registrationTimeoutMs = options.registrationTimeoutMs ?? 10_000;
		this.now = options.now ?? Date.now;
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

	getOpenPairing(pairId: string): ActivePairing | undefined {
		const pairing = this.pairings.get(pairId);
		if (!pairing) return undefined;
		if (pairing.expiresAt <= this.now() || !this.isBackendOnline(pairing.backendId)) {
			this.pairings.delete(pairId);
			return undefined;
		}
		return { ...pairing };
	}

	notifyRevocation(result: RevocationResult): void {
		const affectedBackends = result.backendId
			? [this.backends.get(result.backendId)].filter((backend): backend is RegisteredBackend => !!backend)
			: [...this.backends.values()].filter((backend) => this.trustStore.getBackendOwner(backend.backendId) === result.accountId);
		for (const backend of affectedBackends) {
			this.sendBackend(backend.socket, {
				type: "authorization_revoked",
				accountId: result.accountId,
				deviceId: result.deviceId,
			});
		}
		for (const route of [...this.routes.values()]) {
			if (route.claims.accountId !== result.accountId) continue;
			if (result.backendId && route.backendId !== result.backendId) continue;
			if (result.deviceId && route.claims.deviceId !== result.deviceId) continue;
			this.removeRoute(route);
			this.sendBrowser(route.browser, {
				type: "connection_closed",
				connectionId: route.connectionId,
				reason: "Authorization revoked",
			});
		}
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
		this.pairings.clear();
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
				this.sendError(socket, "unauthorized_connection", "Backend must register before other commands");
				return;
			}
			this.registerBackend(socket, handshake, command.publicKey, command.signature, command.metadata);
			return;
		}

		const backend = handshake.registered;
		switch (command.type) {
			case "register_backend":
				this.sendError(socket, "invalid_message", "Backend is already registered");
				break;
			case "open_pairing":
				this.openPairing(backend, command.pairId, command.expiresAt);
				break;
			case "confirm_pairing":
				this.confirmPairing(backend, command.connectionId);
				break;
			case "signal":
				this.relayBackendSignal(backend, command.connectionId, command.signal);
				break;
			case "connection_binding":
				this.relayBackendBinding(backend, command.connectionId, command.binding);
				break;
			case "close_connection":
				this.closeFromBackend(backend, command.connectionId, command.reason ?? "Backend closed connection");
				break;
		}
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
		const registered = { backendId, publicKey, metadata, socket };
		handshake.registered = registered;
		this.backends.set(backendId, registered);
		this.sendBackend(socket, {
			type: "registered",
			backendId,
			ticketPublicKey: this.trustStore.ticketPublicKey,
			iceServers: this.iceServerProvider.issue(backendId),
		});
		const pendingRevocation = this.trustStore.getPendingBackendRevocation(backendId);
		if (pendingRevocation) {
			this.sendBackend(socket, {
				type: "authorization_revoked",
				accountId: pendingRevocation.accountId,
			});
		}
		for (const listener of this.registeredListeners) listener(backendId);
	}

	private openPairing(backend: RegisteredBackend, pairId: string, expiresAt: number): void {
		const now = this.now();
		if (expiresAt <= now || expiresAt > now + MAX_PAIRING_LIFETIME_MS) {
			this.sendError(backend.socket, "invalid_pairing", "Pairing expiry is outside the allowed window");
			return;
		}
		const existing = this.getOpenPairing(pairId);
		if (existing && existing.backendId !== backend.backendId) {
			this.sendError(backend.socket, "invalid_pairing", "Pairing id is already active");
			return;
		}
		this.pairings.set(pairId, { pairId, backendId: backend.backendId, expiresAt });
		this.sendBackend(backend.socket, { type: "pairing_opened", pairId, expiresAt });
	}

	private confirmPairing(backend: RegisteredBackend, connectionId: string): void {
		const route = this.routeForBackend(backend, connectionId);
		if (!route) return;
		if (route.claims.kind !== "pairing" || !route.claims.pairId) {
			this.sendError(backend.socket, "invalid_pairing", "Connection is not a pairing attempt", connectionId);
			return;
		}
		const pairing = this.getOpenPairing(route.claims.pairId);
		if (!pairing || pairing.backendId !== backend.backendId) {
			this.sendError(backend.socket, "invalid_pairing", "Pairing capability is missing or expired", connectionId);
			return;
		}
		try {
			const pairId = route.claims.pairId;
			const confirmation = this.trustStore.confirmPairing(route.claims);
			route.claims = { ...route.claims, accountId: confirmation.accountId };
			this.pairings.delete(pairId);
			this.sendBackend(backend.socket, {
				type: "pairing_confirmed",
				connectionId,
				pairId,
				accountId: confirmation.accountId,
				deviceId: confirmation.deviceId,
			});
		} catch (error) {
			this.sendError(backend.socket, "invalid_pairing", error instanceof Error ? error.message : String(error), connectionId);
		}
	}

	private relayBackendSignal(backend: RegisteredBackend, connectionId: string, signal: IceSignal): void {
		const route = this.routeForBackend(backend, connectionId);
		if (!route) return;
		if (signal.kind === "description") {
			if (signal.type !== "answer") {
				this.sendError(backend.socket, "invalid_message", "Backend must send an SDP answer", connectionId);
				return;
			}
			route.answerSdp = signal.sdp;
		}
		this.sendBrowser(route.browser, { type: "signal", connectionId, signal });
	}

	private relayBackendBinding(
		backend: RegisteredBackend,
		connectionId: string,
		binding: import("../shared/trust-protocol.js").BackendIdentityBinding,
	): void {
		const route = this.routeForBackend(backend, connectionId);
		if (!route) return;
		try {
			if (!route.offerSdp || !route.answerSdp) throw new Error("SDP exchange is incomplete");
			if (binding.backendId !== backend.backendId || binding.publicKey !== backend.publicKey || binding.connectionId !== connectionId) {
				throw new Error("Backend binding identity does not match the route");
			}
			if (binding.offerSha256 !== sha256Base64Url(route.offerSdp)
				|| binding.answerSha256 !== sha256Base64Url(route.answerSdp)
				|| binding.dtlsFingerprint !== extractDtlsFingerprint(route.answerSdp)
				|| binding.expiresAt !== route.claims.expiresAt
				|| !verifyBackendIdentityBinding(binding)) {
				throw new Error("Backend identity binding is invalid");
			}
			this.sendBrowser(route.browser, { type: "connection_binding", connectionId, binding });
		} catch (error) {
			this.sendError(backend.socket, "invalid_message", error instanceof Error ? error.message : String(error), connectionId);
			this.closeFromBackend(backend, connectionId, "Backend identity binding failed");
		}
	}

	private closeFromBackend(backend: RegisteredBackend, connectionId: string, reason: string): void {
		const route = this.routeForBackend(backend, connectionId);
		if (!route) return;
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
			this.connectBrowser(socket, command.backendId, command.ticket, command.iceServers ?? []);
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
			if (command.signal.kind === "description") {
				if (command.signal.type !== "offer") {
					this.sendBrowserError(socket, "invalid_message", "Browser must send an SDP offer", command.connectionId);
					return;
				}
				route.offerSdp = command.signal.sdp;
			}
			this.sendBackend(backend.socket, { type: "signal", connectionId: command.connectionId, signal: command.signal });
			return;
		}
		this.removeRoute(route);
		this.sendBackend(backend.socket, {
			type: "connection_closed",
			connectionId: command.connectionId,
			reason: command.reason ?? "Browser closed connection",
		});
	}

	private connectBrowser(
		socket: WebSocket,
		backendId: string,
		ticket: string,
		browserIceServers: IceServerConfiguration[],
	): void {
		const backend = this.backends.get(backendId);
		if (!backend || backend.socket.readyState !== WebSocket.OPEN) {
			this.sendBrowserError(socket, "backend_offline", "Backend is offline");
			return;
		}

		let claims: ConnectionTicketClaims;
		try {
			claims = this.trustStore.consumeRouteTicket(ticket);
			if (claims.backendId !== backendId) throw new Error("Ticket targets another backend");
			if (claims.kind === "pairing") {
				const pairing = claims.pairId ? this.getOpenPairing(claims.pairId) : undefined;
				if (!pairing || pairing.backendId !== backendId) throw new Error("Pairing capability is missing or expired");
			} else if (!claims.accountId
				|| this.trustStore.getBackendOwner(backendId) !== claims.accountId
				|| !this.trustStore.isDeviceActive(claims.deviceId)) {
				throw new Error("Ticket authorization was revoked");
			}
		} catch (error) {
			this.sendBrowserError(socket, "invalid_ticket", error instanceof Error ? error.message : String(error));
			return;
		}
		if (this.routes.has(claims.connectionId)) {
			this.sendBrowserError(socket, "invalid_ticket", "Connection id is already active");
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

		const route: BrowserRoute = { connectionId: claims.connectionId, backendId, browser: socket, ticket, claims };
		this.routes.set(route.connectionId, route);
		this.browserRoutes.set(socket, route);
		this.sendBackend(backend.socket, {
			type: "connection_request",
			connectionId: route.connectionId,
			ticket,
			iceServers: [
				...this.iceServerProvider.issue(backendId),
				...browserIceServers.map((server) => ({
					...server,
					urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
				})),
			],
		});
		this.sendBrowser(socket, { type: "backend_connected", backendId, connectionId: route.connectionId });
	}

	private routeForBackend(backend: RegisteredBackend, connectionId: string): BrowserRoute | undefined {
		const route = this.routes.get(connectionId);
		if (!route || route.backendId !== backend.backendId) {
			this.sendError(backend.socket, "unauthorized_connection", "Connection does not belong to this backend", connectionId);
			return undefined;
		}
		return route;
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
		for (const [pairId, pairing] of this.pairings) {
			if (pairing.backendId === backend.backendId) this.pairings.delete(pairId);
		}
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
		if (backend) this.sendBackend(backend.socket, { type: "connection_closed", connectionId: route.connectionId, reason });
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
		socket.send(encodeRendezvousMessage({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, ...payload }));
	}
}

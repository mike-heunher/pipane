import nodeDataChannel, { type DataChannel, type IceServer, type PeerConnection } from "node-datachannel";
import type { IceSignal } from "../shared/rendezvous-protocol.js";
import {
	PIPANE_DATA_CHANNEL_LABEL,
	PIPANE_DATA_CHANNEL_PROTOCOL,
	TRUST_PROTOCOL_VERSION,
	decodeDataChannelAuthenticateFrame,
	deviceConnectionProofPayload,
	type BackendIdentityBinding,
	type ConnectionTicketClaims,
	type DataChannelAuthenticationFrame,
} from "../shared/trust-protocol.js";
import { deriveDeviceId, verifyConnectionTicket, verifyDeviceSignature } from "../shared/node-trust-crypto.js";
import {
	signBackendIdentityBinding,
	type BackendIdentity,
} from "./backend-identity.js";
import type { BackendConnectionRequest } from "./rendezvous-client.js";
import { toNodeIceServers } from "./ice-servers.js";

export { PIPANE_DATA_CHANNEL_LABEL, PIPANE_DATA_CHANNEL_PROTOCOL } from "../shared/trust-protocol.js";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
const MAX_AUTHENTICATION_FRAME_BYTES = 32 * 1024;

export interface BackendSignalingClient {
	onConnectionRequest(listener: (request: BackendConnectionRequest) => void): () => void;
	onSignal(listener: (connectionId: string, signal: IceSignal) => void): () => void;
	onConnectionClosed(listener: (connectionId: string, reason: string) => void): () => void;
	sendSignal(connectionId: string, signal: IceSignal): void;
	sendIdentityBinding(connectionId: string, binding: BackendIdentityBinding): void;
	closeConnection(connectionId: string, reason?: string): void;
}

export interface BackendAuthorizationContext {
	claims: ConnectionTicketClaims;
	pairingSecret?: string;
}

export interface BackendAuthorizationResult {
	accountId: string;
	deviceId: string;
}

export interface AuthenticatedDataChannel extends BackendAuthorizationResult {
	connectionId: string;
	channel: DataChannel;
}

export interface BackendWebRtcManagerOptions {
	signaling: BackendSignalingClient;
	identity: BackendIdentity;
	ticketPublicKey: () => string;
	authorize: (context: BackendAuthorizationContext) => Promise<BackendAuthorizationResult>;
	iceServers?: Array<string | IceServer>;
	iceTransportPolicy?: "all" | "relay";
	/** Bind ICE to one address, primarily for deterministic loopback tests. */
	bindAddress?: string;
	authenticationTimeoutMs?: number;
}

interface PeerState {
	request: BackendConnectionRequest;
	claims: ConnectionTicketClaims;
	peer: PeerConnection;
	offerSdp?: string;
	binding?: BackendIdentityBinding;
	authenticated?: BackendAuthorizationResult;
	authenticationTimer?: ReturnType<typeof setTimeout>;
}

/** Answer-side WebRTC peers that expose channels only after ticket and device proof validation. */
export class BackendWebRtcManager {
	private readonly signaling: BackendSignalingClient;
	private readonly identity: BackendIdentity;
	private readonly ticketPublicKey: () => string;
	private readonly authorize: BackendWebRtcManagerOptions["authorize"];
	private readonly iceServers: Array<string | IceServer>;
	private readonly iceTransportPolicy: "all" | "relay";
	private readonly bindAddress: string | undefined;
	private readonly authenticationTimeoutMs: number;
	private readonly peers = new Map<string, PeerState>();
	private readonly channelListeners = new Set<(connection: AuthenticatedDataChannel) => void>();
	private readonly errorListeners = new Set<(connectionId: string, error: Error) => void>();
	private readonly unsubscribers: Array<() => void>;

	constructor(options: BackendWebRtcManagerOptions) {
		this.signaling = options.signaling;
		this.identity = options.identity;
		this.ticketPublicKey = options.ticketPublicKey;
		this.authorize = options.authorize;
		this.iceServers = options.iceServers ?? [];
		this.iceTransportPolicy = options.iceTransportPolicy ?? "all";
		this.bindAddress = options.bindAddress;
		this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? AUTHENTICATION_TIMEOUT_MS;
		this.unsubscribers = [
			this.signaling.onConnectionRequest((request) => this.createPeer(request)),
			this.signaling.onSignal((connectionId, signal) => this.applySignal(connectionId, signal)),
			this.signaling.onConnectionClosed((connectionId) => this.removePeer(connectionId)),
		];
	}

	onDataChannel(listener: (connection: AuthenticatedDataChannel) => void): () => void {
		this.channelListeners.add(listener);
		return () => this.channelListeners.delete(listener);
	}

	onError(listener: (connectionId: string, error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	closeAuthorization(accountId: string, deviceId?: string): void {
		for (const [connectionId, state] of this.peers) {
			if (state.authenticated?.accountId !== accountId) continue;
			if (deviceId && state.authenticated.deviceId !== deviceId) continue;
			// Rendezvous already removed the route before delivering revocation.
			this.removePeer(connectionId);
		}
	}

	close(): void {
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		for (const connectionId of [...this.peers.keys()]) this.removePeer(connectionId);
	}

	private createPeer(request: BackendConnectionRequest): void {
		this.removePeer(request.connectionId);
		let claims: ConnectionTicketClaims;
		try {
			claims = verifyConnectionTicket(request.ticket, this.ticketPublicKey());
			if (claims.connectionId !== request.connectionId || claims.backendId !== this.identity.backendId) {
				throw new Error("Connection ticket does not match this backend route");
			}
			if (deriveDeviceId(claims.devicePublicKey) !== claims.deviceId) throw new Error("Connection ticket device identity is invalid");
		} catch (error) {
			this.rejectRequest(request.connectionId, error);
			return;
		}

		const peer = new nodeDataChannel.PeerConnection(request.connectionId, {
			iceServers: request.iceServers.length > 0 ? toNodeIceServers(request.iceServers) : this.iceServers,
			iceTransportPolicy: this.iceTransportPolicy,
			bindAddress: this.bindAddress,
		});
		const state: PeerState = { request, claims, peer };
		this.peers.set(request.connectionId, state);

		peer.onLocalDescription((sdp, type) => {
			if (this.peers.get(request.connectionId) !== state || type !== "answer" || !state.offerSdp) return;
			try {
				const binding = signBackendIdentityBinding(this.identity, {
					connectionId: request.connectionId,
					offerSdp: state.offerSdp,
					answerSdp: sdp,
					expiresAt: claims.expiresAt,
				});
				state.binding = binding;
				this.signaling.sendSignal(request.connectionId, { kind: "description", type: "answer", sdp });
				this.signaling.sendIdentityBinding(request.connectionId, binding);
			} catch (error) {
				this.failPeer(request.connectionId, error);
			}
		});
		peer.onLocalCandidate((candidate, mid) => {
			if (this.peers.get(request.connectionId) !== state) return;
			this.safeSendSignal(request.connectionId, {
				kind: "candidate",
				candidate,
				sdpMid: mid || null,
				sdpMLineIndex: null,
			});
		});
		peer.onDataChannel((channel) => this.handleDataChannel(state, channel));
		peer.onStateChange((connectionState) => {
			if (connectionState === "failed" || connectionState === "closed") this.removePeer(request.connectionId);
		});
	}

	private handleDataChannel(state: PeerState, channel: DataChannel): void {
		if (channel.getLabel() !== PIPANE_DATA_CHANNEL_LABEL || channel.getProtocol() !== PIPANE_DATA_CHANNEL_PROTOCOL) {
			channel.close();
			return;
		}
		state.authenticationTimer = setTimeout(() => this.failPeer(state.request.connectionId, new Error("DataChannel authentication timed out")), this.authenticationTimeoutMs);
		state.authenticationTimer.unref?.();
		channel.onMessage((message) => {
			if (state.authenticated) return;
			const raw = message.toString();
			if (Buffer.byteLength(raw) > MAX_AUTHENTICATION_FRAME_BYTES) {
				this.failAuthentication(state, channel, "Authentication frame is too large");
				return;
			}
			const hello = decodeDataChannelAuthenticateFrame(raw);
			if (!hello) {
				this.failAuthentication(state, channel, "First DataChannel frame must authenticate the device");
				return;
			}
			void this.authenticateChannel(state, channel, hello).catch((error) => {
				if (this.peers.get(state.request.connectionId) !== state) return;
				this.failAuthentication(state, channel, error instanceof Error ? error.message : String(error));
			});
		});
	}

	private async authenticateChannel(
		state: PeerState,
		channel: DataChannel,
		hello: import("../shared/trust-protocol.js").DataChannelAuthenticateFrame,
	): Promise<void> {
		if (!state.binding) throw new Error("Backend identity binding is not ready");
		if (state.claims.expiresAt <= Date.now()) throw new Error("Connection ticket expired during negotiation");
		if (hello.ticket !== state.request.ticket || hello.bindingSignature !== state.binding.signature) {
			throw new Error("Device proof does not match the negotiated connection");
		}
		if (!verifyDeviceSignature(
			state.claims.devicePublicKey,
			deviceConnectionProofPayload(hello.ticket, hello.bindingSignature),
			hello.deviceSignature,
		)) {
			throw new Error("Invalid device connection signature");
		}
		const authorization = await this.authorize({ claims: state.claims, pairingSecret: hello.pairingSecret });
		if (this.peers.get(state.request.connectionId) !== state) throw new Error("Connection closed during authorization");
		if (authorization.deviceId !== state.claims.deviceId) throw new Error("Authorized device does not match the ticket");
		state.authenticated = authorization;
		if (state.authenticationTimer) clearTimeout(state.authenticationTimer);
		state.authenticationTimer = undefined;
		const response: DataChannelAuthenticationFrame = {
			protocolVersion: TRUST_PROTOCOL_VERSION,
			type: "authenticated",
			accountId: authorization.accountId,
			deviceId: authorization.deviceId,
		};
		channel.sendMessage(JSON.stringify(response));
		for (const listener of this.channelListeners) {
			listener({ connectionId: state.request.connectionId, channel, ...authorization });
		}
	}

	private failAuthentication(state: PeerState, channel: DataChannel, message: string): void {
		const response: DataChannelAuthenticationFrame = {
			protocolVersion: TRUST_PROTOCOL_VERSION,
			type: "authentication_error",
			message,
		};
		channel.sendMessage(JSON.stringify(response));
		this.failPeer(state.request.connectionId, new Error(message));
	}

	private applySignal(connectionId: string, signal: IceSignal): void {
		const state = this.peers.get(connectionId);
		if (!state) {
			this.signaling.closeConnection(connectionId, "Unknown backend WebRTC connection");
			return;
		}
		try {
			if (signal.kind === "candidate") {
				state.peer.addRemoteCandidate(signal.candidate, signal.sdpMid ?? "0");
				return;
			}
			if (signal.type !== "offer") throw new Error("Backend WebRTC peer expected an offer");
			state.offerSdp = signal.sdp;
			state.peer.setRemoteDescription(signal.sdp, "offer");
		} catch (error) {
			this.failPeer(connectionId, error);
		}
	}

	private safeSendSignal(connectionId: string, signal: IceSignal): void {
		try {
			this.signaling.sendSignal(connectionId, signal);
		} catch (error) {
			this.failPeer(connectionId, error);
		}
	}

	private rejectRequest(connectionId: string, error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.errorListeners) listener(connectionId, normalized);
		this.signaling.closeConnection(connectionId, normalized.message);
	}

	private failPeer(connectionId: string, error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.errorListeners) listener(connectionId, normalized);
		try {
			this.signaling.closeConnection(connectionId, "WebRTC negotiation failed");
		} finally {
			this.removePeer(connectionId);
		}
	}

	private removePeer(connectionId: string): void {
		const state = this.peers.get(connectionId);
		if (!state) return;
		this.peers.delete(connectionId);
		if (state.authenticationTimer) clearTimeout(state.authenticationTimer);
		state.peer.close();
	}
}

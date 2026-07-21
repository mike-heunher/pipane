import nodeDataChannel, {
	type DataChannel,
	type IceServer,
	type PeerConnection,
} from "node-datachannel";
import type { IceSignal } from "../shared/rendezvous-protocol.js";

export const PIPANE_DATA_CHANNEL_LABEL = "pipane";
export const PIPANE_DATA_CHANNEL_PROTOCOL = "pipane.v1";

export interface BackendSignalingClient {
	onConnectionRequest(listener: (connectionId: string) => void): () => void;
	onSignal(listener: (connectionId: string, signal: IceSignal) => void): () => void;
	onConnectionClosed(listener: (connectionId: string, reason: string) => void): () => void;
	sendSignal(connectionId: string, signal: IceSignal): void;
	closeConnection(connectionId: string, reason?: string): void;
}

export interface BackendWebRtcManagerOptions {
	signaling: BackendSignalingClient;
	iceServers?: Array<string | IceServer>;
	/** Bind ICE to one address, primarily for deterministic loopback tests. */
	bindAddress?: string;
}

interface PeerState {
	connectionId: string;
	peer: PeerConnection;
}

/** Owns answer-side WebRTC peers while rendezvous owns only signaling frames. */
export class BackendWebRtcManager {
	private readonly signaling: BackendSignalingClient;
	private readonly iceServers: Array<string | IceServer>;
	private readonly bindAddress: string | undefined;
	private readonly peers = new Map<string, PeerState>();
	private readonly channelListeners = new Set<(connectionId: string, channel: DataChannel) => void>();
	private readonly errorListeners = new Set<(connectionId: string, error: Error) => void>();
	private readonly unsubscribers: Array<() => void>;

	constructor(options: BackendWebRtcManagerOptions) {
		this.signaling = options.signaling;
		this.iceServers = options.iceServers ?? [];
		this.bindAddress = options.bindAddress;
		this.unsubscribers = [
			this.signaling.onConnectionRequest((connectionId) => this.createPeer(connectionId)),
			this.signaling.onSignal((connectionId, signal) => this.applySignal(connectionId, signal)),
			this.signaling.onConnectionClosed((connectionId) => this.removePeer(connectionId)),
		];
	}

	onDataChannel(listener: (connectionId: string, channel: DataChannel) => void): () => void {
		this.channelListeners.add(listener);
		return () => this.channelListeners.delete(listener);
	}

	onError(listener: (connectionId: string, error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	close(): void {
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		for (const connectionId of [...this.peers.keys()]) this.removePeer(connectionId);
	}

	private createPeer(connectionId: string): void {
		this.removePeer(connectionId);
		const peer = new nodeDataChannel.PeerConnection(connectionId, {
			iceServers: this.iceServers,
			bindAddress: this.bindAddress,
		});
		const state: PeerState = { connectionId, peer };
		this.peers.set(connectionId, state);

		peer.onLocalDescription((sdp, type) => {
			if (this.peers.get(connectionId) !== state || type !== "answer") return;
			this.safeSendSignal(connectionId, { kind: "description", type: "answer", sdp });
		});
		peer.onLocalCandidate((candidate, mid) => {
			if (this.peers.get(connectionId) !== state) return;
			this.safeSendSignal(connectionId, {
				kind: "candidate",
				candidate,
				sdpMid: mid || null,
				sdpMLineIndex: null,
			});
		});
		peer.onDataChannel((channel) => {
			if (channel.getLabel() !== PIPANE_DATA_CHANNEL_LABEL || channel.getProtocol() !== PIPANE_DATA_CHANNEL_PROTOCOL) {
				channel.close();
				return;
			}
			for (const listener of this.channelListeners) listener(connectionId, channel);
		});
		peer.onStateChange((connectionState) => {
			if (connectionState === "failed" || connectionState === "closed") this.removePeer(connectionId);
		});
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
		state.peer.close();
	}
}

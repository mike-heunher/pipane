import type { FrameTransport, FrameTransportConnectionEvent } from "./frame-transport.js";
import { BrowserRendezvousClient } from "./browser-rendezvous-client.js";
import {
	signDeviceConnection,
	verifyBrowserBackendBinding,
	type BrowserDeviceIdentity,
} from "./device-identity.js";
import type { ConnectionTicketClaims, ConnectionTicketResponse } from "../shared/trust-protocol.js";
import {
	PIPANE_DATA_CHANNEL_LABEL,
	PIPANE_DATA_CHANNEL_PROTOCOL,
	TRUST_PROTOCOL_VERSION,
	parseConnectionTicketClaims,
} from "../shared/trust-protocol.js";

export interface BrowserConnectionAuthorization extends ConnectionTicketResponse {
	pairingSecret?: string;
}

export interface WebRtcFrameTransportOptions {
	rendezvousUrl: string;
	backendId: string;
	deviceIdentity: BrowserDeviceIdentity;
	authorize: () => Promise<BrowserConnectionAuthorization>;
	iceTransportPolicy?: RTCIceTransportPolicy;
	createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
	createRendezvousClient?: (ticket: string) => BrowserRendezvousClient;
	reconnectDelayMs?: (attempt: number) => number;
	schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

/** Authenticated reliable browser DataChannel carrier for the existing v1 frame protocol. */
export class WebRtcFrameTransport implements FrameTransport {
	private readonly rendezvousUrl: string;
	private readonly backendId: string;
	private readonly deviceIdentity: BrowserDeviceIdentity;
	private readonly authorize: WebRtcFrameTransportOptions["authorize"];
	private readonly iceTransportPolicy: RTCIceTransportPolicy;
	private readonly createPeerConnection: (configuration: RTCConfiguration) => RTCPeerConnection;
	private readonly createRendezvousClient: (ticket: string) => BrowserRendezvousClient;
	private readonly reconnectDelayMs: (attempt: number) => number;
	private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	private readonly frameListeners = new Set<(frame: string) => void>();
	private readonly connectionListeners = new Set<(event: FrameTransportConnectionEvent) => void>();
	private peer: RTCPeerConnection | undefined;
	private channel: RTCDataChannel | undefined;
	private rendezvous: BrowserRendezvousClient | undefined;
	private connected = false;
	private manuallyClosed = false;
	private everConnected = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: WebRtcFrameTransportOptions) {
		this.rendezvousUrl = options.rendezvousUrl;
		this.backendId = options.backendId;
		this.deviceIdentity = options.deviceIdentity;
		this.authorize = options.authorize;
		this.iceTransportPolicy = options.iceTransportPolicy ?? "all";
		this.createPeerConnection = options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration));
		this.createRendezvousClient = options.createRendezvousClient ?? ((ticket) => new BrowserRendezvousClient({
			url: this.rendezvousUrl,
			backendId: this.backendId,
			ticket,
		}));
		this.reconnectDelayMs = options.reconnectDelayMs ?? ((attempt) => Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)));
		this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	}

	get isConnected(): boolean {
		return this.connected && this.channel?.readyState === "open";
	}

	get isReconnecting(): boolean {
		return this.reconnectTimer !== undefined;
	}

	onFrame(listener: (frame: string) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onConnectionChange(listener: (event: FrameTransportConnectionEvent) => void): () => void {
		this.connectionListeners.add(listener);
		return () => this.connectionListeners.delete(listener);
	}

	async connect(_endpoint: string): Promise<void> {
		if (this.isConnected) return;
		this.manuallyClosed = false;
		const authorization = await this.authorize();
		const claims = decodeTicketClaims(authorization.ticket);
		if (claims.backendId !== this.backendId || claims.deviceId !== this.deviceIdentity.deviceId) {
			throw new Error("Connection ticket does not match this browser and backend");
		}
		const rendezvous = this.createRendezvousClient(authorization.ticket);
		const peer = this.createPeerConnection({
			iceServers: authorization.iceServers,
			iceTransportPolicy: this.iceTransportPolicy,
		});
		const channel = peer.createDataChannel(PIPANE_DATA_CHANNEL_LABEL, {
			ordered: true,
			protocol: PIPANE_DATA_CHANNEL_PROTOCOL,
		});
		this.rendezvous = rendezvous;
		this.peer = peer;
		this.channel = channel;

		await new Promise<void>(async (resolve, reject) => {
			let settled = false;
			let connectionId = "";
			let offerSdp = "";
			let answerSdp: string | undefined;
			let binding: import("../shared/trust-protocol.js").BackendIdentityBinding | undefined;
			let remoteDescriptionSet = false;
			const pendingCandidates: RTCIceCandidateInit[] = [];

			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				this.closeInternal();
				reject(error instanceof Error ? error : new Error(String(error)));
			};
			const applyAnswer = async (): Promise<void> => {
				if (!answerSdp || !binding || remoteDescriptionSet) return;
				await verifyBrowserBackendBinding(binding, {
					backendId: this.backendId,
					connectionId,
					offerSdp,
					answerSdp,
					expiresAt: claims.expiresAt,
				});
				await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
				remoteDescriptionSet = true;
				for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
			};

			peer.onicecandidate = (event) => {
				if (!event.candidate || !connectionId) return;
				const candidate = event.candidate.toJSON();
				rendezvous.sendSignal({
					kind: "candidate",
					candidate: candidate.candidate ?? "",
					sdpMid: candidate.sdpMid ?? null,
					sdpMLineIndex: candidate.sdpMLineIndex ?? null,
				});
			};
			peer.onconnectionstatechange = () => {
				if (peer.connectionState === "failed" || peer.connectionState === "closed") {
					if (!settled) fail(new Error(`WebRTC connection ${peer.connectionState}`));
					else this.handleDisconnected();
				}
			};
			channel.onerror = () => fail(new Error("WebRTC DataChannel failed"));
			channel.onclose = () => {
				if (!settled) fail(new Error("WebRTC DataChannel closed before authentication"));
				else this.handleDisconnected();
			};
			channel.onopen = () => {
				void signDeviceConnection(this.deviceIdentity, authorization.ticket, binding?.signature ?? "").then((deviceSignature) => {
					if (!binding) throw new Error("Backend identity binding is missing");
					channel.send(JSON.stringify({
						protocolVersion: TRUST_PROTOCOL_VERSION,
						type: "authenticate",
						ticket: authorization.ticket,
						bindingSignature: binding.signature,
						deviceSignature,
						pairingSecret: authorization.pairingSecret,
					}));
				}).catch(fail);
			};
			channel.onmessage = (event) => {
				const frame = String(event.data);
				if (!this.connected) {
					let result: any;
					try {
						result = JSON.parse(frame);
					} catch {
						fail(new Error("Backend returned an invalid authentication frame"));
						return;
					}
					if (result?.protocolVersion !== TRUST_PROTOCOL_VERSION || result?.type !== "authenticated") {
						fail(new Error(result?.message || "Backend rejected DataChannel authentication"));
						return;
					}
					if (result.deviceId !== this.deviceIdentity.deviceId) {
						fail(new Error("Backend authenticated an unexpected browser device"));
						return;
					}
					this.connected = true;
					this.reconnectAttempt = 0;
					settled = true;
					this.emitConnectionChange({ connected: true, reconnected: this.everConnected });
					this.everConnected = true;
					resolve();
					return;
				}
				for (const listener of this.frameListeners) listener(frame);
			};

			rendezvous.onSignal((signal) => {
				void (async () => {
					if (signal.kind === "description") {
						if (signal.type !== "answer") throw new Error("Browser expected an SDP answer");
						answerSdp = signal.sdp;
						await applyAnswer();
						return;
					}
					const candidate = {
						candidate: signal.candidate,
						sdpMid: signal.sdpMid,
						sdpMLineIndex: signal.sdpMLineIndex,
					};
					if (remoteDescriptionSet) await peer.addIceCandidate(candidate);
					else pendingCandidates.push(candidate);
				})().catch(fail);
			});
			rendezvous.onIdentityBinding((received) => {
				binding = received;
				void applyAnswer().catch(fail);
			});
			rendezvous.onConnectionClosed((reason) => fail(new Error(reason)));
			rendezvous.onError((error) => fail(error instanceof Error ? error : new Error(error.message)));

			try {
				connectionId = await rendezvous.connect();
				if (connectionId !== claims.connectionId) throw new Error("Rendezvous route does not match the connection ticket");
				const offer = await peer.createOffer();
				offerSdp = offer.sdp ?? "";
				if (!offerSdp) throw new Error("Browser WebRTC offer is empty");
				await peer.setLocalDescription(offer);
				rendezvous.sendSignal({ kind: "description", type: "offer", sdp: offerSdp });
			} catch (error) {
				fail(error);
			}
		});
	}

	send(frame: string): void {
		if (!this.isConnected || !this.channel) throw new Error("Backend transport is not connected");
		this.channel.send(frame);
	}

	close(_code = 1000, reason = "Client closed"): void {
		this.manuallyClosed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.rendezvous?.close(reason);
		this.closeInternal();
	}

	private closeInternal(): void {
		const wasConnected = this.connected;
		this.connected = false;
		this.channel?.close();
		this.peer?.close();
		this.rendezvous?.close();
		this.channel = undefined;
		this.peer = undefined;
		this.rendezvous = undefined;
		if (wasConnected) this.emitConnectionChange({ connected: false, reconnected: false });
	}

	private handleDisconnected(): void {
		if (this.manuallyClosed || !this.connected) return;
		this.closeInternal();
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.manuallyClosed || this.reconnectTimer) return;
		const attempt = this.reconnectAttempt++;
		this.reconnectTimer = this.schedule(() => {
			this.reconnectTimer = undefined;
			void this.connect("webrtc").catch(() => this.scheduleReconnect());
		}, this.reconnectDelayMs(attempt));
	}

	private emitConnectionChange(event: FrameTransportConnectionEvent): void {
		for (const listener of this.connectionListeners) listener(event);
	}
}

function decodeTicketClaims(ticket: string): ConnectionTicketClaims {
	const [encodedClaims] = ticket.split(".");
	if (!encodedClaims) throw new Error("Connection ticket is malformed");
	try {
		const base64 = encodedClaims.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encodedClaims.length / 4) * 4, "=");
		const claims = parseConnectionTicketClaims(JSON.parse(atob(base64)));
		if (!claims) throw new Error("Connection ticket claims are invalid");
		return claims;
	} catch {
		throw new Error("Connection ticket claims are malformed");
	}
}

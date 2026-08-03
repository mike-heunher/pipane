export type IceConnectionPath = "direct-host" | "direct-stun" | "turn-relay" | "unknown";

export type ConnectionFailureCode =
	| "rendezvous"
	| "backend_offline"
	| "authorization"
	| "ice"
	| "datachannel"
	| "authentication"
	| "relay_configuration"
	| "unknown";

export interface ConnectionFailureDetails {
	code: ConnectionFailureCode;
	message: string;
	turnRecommended: boolean;
}

export class ConnectionAttemptError extends Error implements ConnectionFailureDetails {
	constructor(
		readonly code: ConnectionFailureCode,
		message: string,
		readonly turnRecommended = code === "ice",
	) {
		super(message);
		this.name = "ConnectionAttemptError";
	}
}

export function connectionFailureDetails(error: unknown): ConnectionFailureDetails {
	if (error && typeof error === "object") {
		const candidate = error as Partial<ConnectionFailureDetails>;
		if (isConnectionFailureCode(candidate.code)
			&& typeof candidate.message === "string"
			&& typeof candidate.turnRecommended === "boolean") {
			return { code: candidate.code, message: candidate.message, turnRecommended: candidate.turnRecommended };
		}
	}
	return {
		code: "unknown",
		message: error instanceof Error ? error.message : String(error),
		turnRecommended: false,
	};
}

function isConnectionFailureCode(value: unknown): value is ConnectionFailureCode {
	return value === "rendezvous"
		|| value === "backend_offline"
		|| value === "authorization"
		|| value === "ice"
		|| value === "datachannel"
		|| value === "authentication"
		|| value === "relay_configuration"
		|| value === "unknown";
}

export interface IceCandidateDiagnostics {
	id: string;
	scope: "local" | "remote";
	address?: string;
	port?: number;
	protocol?: string;
	candidateType?: string;
	networkType?: string;
	tcpType?: string;
	relayProtocol?: string;
	relatedAddress?: string;
	relatedPort?: number;
	url?: string;
	priority?: number;
}

export interface SelectedIcePairDiagnostics {
	state?: string;
	nominated?: boolean;
	currentRoundTripTimeMs?: number;
	availableOutgoingBitrate?: number;
	bytesSent?: number;
	bytesReceived?: number;
	packetsSent?: number;
	packetsReceived?: number;
	local?: IceCandidateDiagnostics;
	remote?: IceCandidateDiagnostics;
}

export interface ConnectionDiagnostics {
	collectedAt: string;
	carrier: "webrtc";
	backendId: string;
	rendezvousUrl: string;
	signalingUrl: string;
	connectionState?: string;
	iceConnectionState?: string;
	iceGatheringState?: string;
	signalingState?: string;
	dtlsState?: string;
	icePath: IceConnectionPath;
	iceServerUrls: string[];
	failure?: ConnectionFailureDetails;
	/** Most recent established carrier interruption, retained after recovery. */
	lastDisconnect?: ConnectionDisconnectDiagnostics;
	selectedPair?: SelectedIcePairDiagnostics;
	candidates: IceCandidateDiagnostics[];
	dataChannel: {
		state?: string;
		label?: string;
		protocol?: string;
		ordered?: boolean;
		bufferedAmount?: number;
		maxMessageSize?: number;
		messagesSent?: number;
		messagesReceived?: number;
		bytesSent?: number;
		bytesReceived?: number;
	};
}

export interface ConnectionDisconnectDiagnostics {
	occurredAt: string;
	failure: ConnectionFailureDetails;
	/** Browser-local snapshot captured immediately before the failed peer closed. */
	snapshot: Omit<ConnectionDiagnostics, "failure" | "lastDisconnect">;
}

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
	getConnectionDiagnostics?(): Promise<ConnectionDiagnostics | undefined>;
}

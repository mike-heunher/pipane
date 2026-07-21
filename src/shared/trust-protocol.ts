export const TRUST_PROTOCOL_VERSION = 1 as const;
export const CONNECTION_TICKET_VERSION = 1 as const;
export const PIPANE_DATA_CHANNEL_LABEL = "pipane";
export const PIPANE_DATA_CHANNEL_PROTOCOL = "pipane.v1";

export type DeviceChallengePurpose = "pair" | "connect" | "discover" | "revoke_device" | "revoke_backend";

export interface AuthorizedBackendDescriptor {
	backendId: string;
	name?: string;
	softwareVersion?: string;
	protocolVersions: number[];
	online: boolean;
}

export interface DeviceChallenge {
	version: typeof TRUST_PROTOCOL_VERSION;
	challengeId: string;
	nonce: string;
	purpose: DeviceChallengePurpose;
	deviceId: string;
	devicePublicKey: string;
	backendId?: string;
	connectionId?: string;
	pairId?: string;
	targetDeviceId?: string;
	expiresAt: number;
}

export interface DeviceChallengeRequest {
	purpose: DeviceChallengePurpose;
	deviceId?: string;
	devicePublicKey?: string;
	backendId?: string;
	connectionId?: string;
	pairId?: string;
	targetDeviceId?: string;
}

export type ConnectionTicketKind = "pairing" | "connection";

export interface ConnectionTicketClaims {
	version: typeof CONNECTION_TICKET_VERSION;
	kind: ConnectionTicketKind;
	ticketId: string;
	backendId: string;
	connectionId: string;
	deviceId: string;
	devicePublicKey: string;
	accountId?: string;
	pairId?: string;
	issuedAt: number;
	expiresAt: number;
}

export interface IceServerConfiguration {
	urls: string | string[];
	username?: string;
	credential?: string;
}

export interface ConnectionTicketResponse {
	ticket: string;
	iceServers: IceServerConfiguration[];
}

export interface BackendIdentityBinding {
	version: typeof TRUST_PROTOCOL_VERSION;
	backendId: string;
	publicKey: string;
	connectionId: string;
	offerSha256: string;
	answerSha256: string;
	dtlsFingerprint: string;
	expiresAt: number;
	signature: string;
}

export interface DataChannelAuthenticateFrame {
	protocolVersion: typeof TRUST_PROTOCOL_VERSION;
	type: "authenticate";
	ticket: string;
	bindingSignature: string;
	deviceSignature: string;
	pairingSecret?: string;
}

export type DataChannelAuthenticationFrame =
	| {
		protocolVersion: typeof TRUST_PROTOCOL_VERSION;
		type: "authenticated";
		accountId: string;
		deviceId: string;
	}
	| {
		protocolVersion: typeof TRUST_PROTOCOL_VERSION;
		type: "authentication_error";
		message: string;
	};

export function deviceChallengePayload(challenge: DeviceChallenge): string {
	return [
		`pipane-device-challenge-v${TRUST_PROTOCOL_VERSION}`,
		challenge.challengeId,
		challenge.nonce,
		challenge.purpose,
		challenge.deviceId,
		challenge.devicePublicKey,
		challenge.backendId ?? "",
		challenge.connectionId ?? "",
		challenge.pairId ?? "",
		challenge.targetDeviceId ?? "",
		String(challenge.expiresAt),
	].join("\n");
}

export function connectionTicketSignaturePayload(encodedClaims: string): string {
	return `pipane-connection-ticket-v${CONNECTION_TICKET_VERSION}\n${encodedClaims}`;
}

export function backendIdentityBindingPayload(binding: Omit<BackendIdentityBinding, "signature">): string {
	return [
		`pipane-backend-binding-v${TRUST_PROTOCOL_VERSION}`,
		binding.backendId,
		binding.publicKey,
		binding.connectionId,
		binding.offerSha256,
		binding.answerSha256,
		binding.dtlsFingerprint,
		String(binding.expiresAt),
	].join("\n");
}

export function deviceConnectionProofPayload(ticket: string, bindingSignature: string): string {
	return [
		`pipane-device-connection-v${TRUST_PROTOCOL_VERSION}`,
		ticket,
		bindingSignature,
	].join("\n");
}

export function decodeDataChannelAuthenticateFrame(raw: string): DataChannelAuthenticateFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value)
		|| value.protocolVersion !== TRUST_PROTOCOL_VERSION
		|| value.type !== "authenticate"
		|| !isNonEmptyString(value.ticket)
		|| !isNonEmptyString(value.bindingSignature)
		|| !isNonEmptyString(value.deviceSignature)
		|| !isOptionalString(value.pairingSecret)) {
		return undefined;
	}
	return value as unknown as DataChannelAuthenticateFrame;
}

export function parseConnectionTicketClaims(value: unknown): ConnectionTicketClaims | undefined {
	if (!isRecord(value)
		|| value.version !== CONNECTION_TICKET_VERSION
		|| (value.kind !== "pairing" && value.kind !== "connection")
		|| !isNonEmptyString(value.ticketId)
		|| !isNonEmptyString(value.backendId)
		|| !isNonEmptyString(value.connectionId)
		|| !isNonEmptyString(value.deviceId)
		|| !isNonEmptyString(value.devicePublicKey)
		|| !isOptionalString(value.accountId)
		|| !isOptionalString(value.pairId)
		|| !isNonNegativeInteger(value.issuedAt)
		|| !isPositiveInteger(value.expiresAt)
		|| value.expiresAt <= value.issuedAt) {
		return undefined;
	}
	if (value.kind === "pairing" && !isNonEmptyString(value.pairId)) return undefined;
	if (value.kind === "connection" && !isNonEmptyString(value.accountId)) return undefined;
	return value as unknown as ConnectionTicketClaims;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || isNonEmptyString(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

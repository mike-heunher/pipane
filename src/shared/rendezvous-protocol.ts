import type { BackendIdentityBinding, IceServerConfiguration } from "./trust-protocol.js";

export const RENDEZVOUS_PROTOCOL_VERSION = 2 as const;

export type RendezvousRole = "backend" | "browser";

export function rendezvousWebSocketUrl(baseUrl: string, role: RendezvousRole): string {
	const url = new URL(baseUrl);
	if (url.protocol === "http:") url.protocol = "ws:";
	else if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`Unsupported rendezvous URL protocol: ${url.protocol}`);
	}
	url.pathname = `/v${RENDEZVOUS_PROTOCOL_VERSION}/rendezvous/${role}`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

export interface BackendRegistrationMetadata {
	name?: string;
	softwareVersion: string;
	protocolVersions: number[];
}

export type IceSignal =
	| { kind: "description"; type: "offer" | "answer"; sdp: string }
	| {
		kind: "candidate";
		candidate: string;
		sdpMid: string | null;
		sdpMLineIndex: number | null;
	};

interface RendezvousEnvelope {
	protocolVersion: typeof RENDEZVOUS_PROTOCOL_VERSION;
}

export type WithoutProtocolVersion<Message> = Message extends RendezvousEnvelope
	? Omit<Message, "protocolVersion">
	: never;

export type BackendRendezvousCommand = RendezvousEnvelope & (
	| {
		type: "register_backend";
		publicKey: string;
		signature: string;
		metadata: BackendRegistrationMetadata;
	}
	| { type: "open_pairing"; pairId: string; expiresAt: number }
	| { type: "confirm_pairing"; connectionId: string }
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "connection_binding"; connectionId: string; binding: BackendIdentityBinding }
	| { type: "close_connection"; connectionId: string; reason?: string }
);

export type BackendRendezvousMessage = RendezvousEnvelope & (
	| { type: "challenge"; nonce: string }
	| {
		type: "registered";
		backendId: string;
		ticketPublicKey: string;
		iceServers: IceServerConfiguration[];
	}
	| { type: "pairing_opened"; pairId: string; expiresAt: number }
	| { type: "pairing_confirmed"; connectionId: string; pairId: string; accountId: string; deviceId: string }
	| { type: "connection_request"; connectionId: string; ticket: string; iceServers: IceServerConfiguration[] }
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "connection_closed"; connectionId: string; reason: string }
	| { type: "authorization_revoked"; accountId: string; deviceId?: string }
	| RendezvousErrorMessage
);

export type BrowserRendezvousCommand = RendezvousEnvelope & (
	| { type: "connect_backend"; backendId: string; ticket: string }
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "close_connection"; connectionId: string; reason?: string }
);

export type BrowserRendezvousMessage = RendezvousEnvelope & (
	| { type: "backend_connected"; backendId: string; connectionId: string }
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "connection_binding"; connectionId: string; binding: BackendIdentityBinding }
	| { type: "connection_closed"; connectionId: string; reason: string }
	| RendezvousErrorMessage
);

export type RendezvousErrorCode =
	| "invalid_json"
	| "invalid_message"
	| "unsupported_version"
	| "unknown_message"
	| "backend_offline"
	| "unauthorized_connection"
	| "invalid_ticket"
	| "invalid_pairing";

export interface RendezvousErrorMessage extends RendezvousEnvelope {
	type: "error";
	code: RendezvousErrorCode;
	message: string;
	connectionId?: string;
}

export interface RendezvousDecodeError {
	code: Extract<RendezvousErrorCode, "invalid_json" | "invalid_message" | "unsupported_version" | "unknown_message">;
	message: string;
}

export type RendezvousDecodeResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: RendezvousDecodeError };

export function backendRegistrationPayload(nonce: string): string {
	return `pipane-rendezvous-v${RENDEZVOUS_PROTOCOL_VERSION}\n${nonce}`;
}

export function encodeRendezvousMessage(message: object): string {
	return JSON.stringify(message);
}

export function decodeBackendCommand(raw: string): RendezvousDecodeResult<BackendRendezvousCommand> {
	return decodeCommand(raw, "backend");
}

export function decodeBrowserCommand(raw: string): RendezvousDecodeResult<BrowserRendezvousCommand> {
	return decodeCommand(raw, "browser");
}

export function decodeBackendMessage(raw: string): RendezvousDecodeResult<BackendRendezvousMessage> {
	return decodeServerMessage(raw, "backend");
}

export function decodeBrowserMessage(raw: string): RendezvousDecodeResult<BrowserRendezvousMessage> {
	return decodeServerMessage(raw, "browser");
}

function decodeCommand(raw: string, role: "backend"): RendezvousDecodeResult<BackendRendezvousCommand>;
function decodeCommand(raw: string, role: "browser"): RendezvousDecodeResult<BrowserRendezvousCommand>;
function decodeCommand(
	raw: string,
	role: "backend" | "browser",
): RendezvousDecodeResult<BackendRendezvousCommand | BrowserRendezvousCommand> {
	const envelope = parseEnvelope(raw);
	if (!envelope.ok) return envelope;
	const value = envelope.value;

	switch (value.type) {
		case "register_backend":
			if (role !== "backend") return unknownMessage(value.type);
			if (!isString(value.publicKey) || !isString(value.signature) || !isBackendMetadata(value.metadata)) {
				return invalidMessage("register_backend requires publicKey, signature, and valid metadata");
			}
			break;
		case "open_pairing":
			if (role !== "backend") return unknownMessage(value.type);
			if (!isString(value.pairId) || !isPositiveInteger(value.expiresAt)) {
				return invalidMessage("open_pairing requires pairId and expiresAt");
			}
			break;
		case "confirm_pairing":
			if (role !== "backend") return unknownMessage(value.type);
			if (!isString(value.connectionId)) return invalidMessage("confirm_pairing requires connectionId");
			break;
		case "connect_backend":
			if (role !== "browser") return unknownMessage(value.type);
			if (!isString(value.backendId) || !isString(value.ticket)) {
				return invalidMessage("connect_backend requires backendId and ticket");
			}
			break;
		case "signal":
			if (!isString(value.connectionId) || !isIceSignal(value.signal)) {
				return invalidMessage("signal requires connectionId and a valid ICE signal");
			}
			break;
		case "connection_binding":
			if (role !== "backend") return unknownMessage(value.type);
			if (!isString(value.connectionId) || !isBackendIdentityBinding(value.binding)) {
				return invalidMessage("connection_binding requires connectionId and a valid binding");
			}
			break;
		case "close_connection":
			if (!isString(value.connectionId) || !isOptionalString(value.reason)) {
				return invalidMessage("close_connection requires connectionId and an optional reason");
			}
			break;
		default:
			return unknownMessage(value.type);
	}
	return { ok: true, value: value as BackendRendezvousCommand | BrowserRendezvousCommand };
}

function decodeServerMessage(raw: string, role: "backend"): RendezvousDecodeResult<BackendRendezvousMessage>;
function decodeServerMessage(raw: string, role: "browser"): RendezvousDecodeResult<BrowserRendezvousMessage>;
function decodeServerMessage(
	raw: string,
	role: "backend" | "browser",
): RendezvousDecodeResult<BackendRendezvousMessage | BrowserRendezvousMessage> {
	const envelope = parseEnvelope(raw);
	if (!envelope.ok) return envelope;
	const value = envelope.value;

	switch (value.type) {
		case "challenge":
			if (role !== "backend" || !isString(value.nonce)) return invalidMessage("invalid backend challenge");
			break;
		case "registered":
			if (role !== "backend" || !isString(value.backendId) || !isString(value.ticketPublicKey) || !isIceServers(value.iceServers)) {
				return invalidMessage("invalid backend registration");
			}
			break;
		case "pairing_opened":
			if (role !== "backend" || !isString(value.pairId) || !isPositiveInteger(value.expiresAt)) {
				return invalidMessage("invalid pairing acknowledgement");
			}
			break;
		case "pairing_confirmed":
			if (role !== "backend"
				|| !isString(value.connectionId)
				|| !isString(value.pairId)
				|| !isString(value.accountId)
				|| !isString(value.deviceId)) {
				return invalidMessage("invalid pairing confirmation");
			}
			break;
		case "connection_request":
			if (role !== "backend" || !isString(value.connectionId) || !isString(value.ticket) || !isIceServers(value.iceServers)) {
				return invalidMessage("invalid connection request");
			}
			break;
		case "backend_connected":
			if (role !== "browser" || !isString(value.backendId) || !isString(value.connectionId)) {
				return invalidMessage("invalid browser connection acknowledgement");
			}
			break;
		case "signal":
			if (!isString(value.connectionId) || !isIceSignal(value.signal)) return invalidMessage("invalid ICE signal");
			break;
		case "connection_binding":
			if (role !== "browser" || !isString(value.connectionId) || !isBackendIdentityBinding(value.binding)) {
				return invalidMessage("invalid backend identity binding");
			}
			break;
		case "connection_closed":
			if (!isString(value.connectionId) || !isString(value.reason)) return invalidMessage("invalid connection closure");
			break;
		case "authorization_revoked":
			if (role !== "backend" || !isString(value.accountId) || !isOptionalString(value.deviceId)) {
				return invalidMessage("invalid authorization revocation");
			}
			break;
		case "error":
			if (!isErrorCode(value.code) || !isString(value.message) || !isOptionalString(value.connectionId)) {
				return invalidMessage("invalid rendezvous error");
			}
			break;
		default:
			return unknownMessage(value.type);
	}
	return { ok: true, value: value as BackendRendezvousMessage | BrowserRendezvousMessage };
}

function parseEnvelope(raw: string): RendezvousDecodeResult<Record<string, any>> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, error: { code: "invalid_json", message: "Message is not valid JSON" } };
	}
	if (!isRecord(value) || !isString(value.type)) return invalidMessage("Message must be an object with a type");
	if (value.protocolVersion !== RENDEZVOUS_PROTOCOL_VERSION) {
		return {
			ok: false,
			error: {
				code: "unsupported_version",
				message: `Unsupported rendezvous protocol version: ${String(value.protocolVersion)}`,
			},
		};
	}
	return { ok: true, value };
}

function isBackendMetadata(value: unknown): value is BackendRegistrationMetadata {
	return isRecord(value)
		&& isOptionalString(value.name)
		&& isString(value.softwareVersion)
		&& Array.isArray(value.protocolVersions)
		&& value.protocolVersions.length > 0
		&& value.protocolVersions.every((version) => Number.isSafeInteger(version) && version > 0);
}

function isIceSignal(value: unknown): value is IceSignal {
	if (!isRecord(value) || !isString(value.kind)) return false;
	if (value.kind === "description") {
		return (value.type === "offer" || value.type === "answer") && isString(value.sdp);
	}
	if (value.kind === "candidate") {
		return isString(value.candidate)
			&& (value.sdpMid === null || isString(value.sdpMid))
			&& (value.sdpMLineIndex === null || (Number.isSafeInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0));
	}
	return false;
}

function isBackendIdentityBinding(value: unknown): value is BackendIdentityBinding {
	return isRecord(value)
		&& value.version === 1
		&& isString(value.backendId)
		&& isString(value.publicKey)
		&& isString(value.connectionId)
		&& isString(value.offerSha256)
		&& isString(value.answerSha256)
		&& isString(value.dtlsFingerprint)
		&& isPositiveInteger(value.expiresAt)
		&& isString(value.signature);
}

function isIceServers(value: unknown): value is IceServerConfiguration[] {
	return Array.isArray(value) && value.every((server) => isRecord(server)
		&& (isString(server.urls) || (Array.isArray(server.urls) && server.urls.length > 0 && server.urls.every(isString)))
		&& isOptionalString(server.username)
		&& isOptionalString(server.credential));
}

function isErrorCode(value: unknown): value is RendezvousErrorCode {
	return value === "invalid_json"
		|| value === "invalid_message"
		|| value === "unsupported_version"
		|| value === "unknown_message"
		|| value === "backend_offline"
		|| value === "unauthorized_connection"
		|| value === "invalid_ticket"
		|| value === "invalid_pairing";
}

function invalidMessage(message: string): RendezvousDecodeResult<never> {
	return { ok: false, error: { code: "invalid_message", message } };
}

function unknownMessage(type: unknown): RendezvousDecodeResult<never> {
	return { ok: false, error: { code: "unknown_message", message: `Unknown rendezvous message: ${String(type)}` } };
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || isString(value);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

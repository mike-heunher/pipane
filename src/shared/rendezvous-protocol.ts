export const RENDEZVOUS_PROTOCOL_VERSION = 1 as const;

export type RendezvousRole = "backend" | "browser";

export function rendezvousWebSocketUrl(baseUrl: string, role: RendezvousRole): string {
	const url = new URL(baseUrl);
	if (url.protocol === "http:") url.protocol = "ws:";
	else if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`Unsupported rendezvous URL protocol: ${url.protocol}`);
	}
	url.pathname = `/v1/rendezvous/${role}`;
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
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "close_connection"; connectionId: string; reason?: string }
);

export type BackendRendezvousMessage = RendezvousEnvelope & (
	| { type: "challenge"; nonce: string }
	| { type: "registered"; backendId: string }
	| { type: "connection_request"; connectionId: string }
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "connection_closed"; connectionId: string; reason: string }
	| RendezvousErrorMessage
);

export type BrowserRendezvousCommand = RendezvousEnvelope & (
	| { type: "connect_backend"; backendId: string }
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "close_connection"; connectionId: string; reason?: string }
);

export type BrowserRendezvousMessage = RendezvousEnvelope & (
	| { type: "backend_connected"; backendId: string; connectionId: string }
	| { type: "signal"; connectionId: string; signal: IceSignal }
	| { type: "connection_closed"; connectionId: string; reason: string }
	| RendezvousErrorMessage
);

export type RendezvousErrorCode =
	| "invalid_json"
	| "invalid_message"
	| "unsupported_version"
	| "unknown_message"
	| "backend_offline"
	| "unauthorized_connection";

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
			return { ok: true, value: value as BackendRendezvousCommand };
		case "connect_backend":
			if (role !== "browser") return unknownMessage(value.type);
			if (!isString(value.backendId)) return invalidMessage("connect_backend requires backendId");
			return { ok: true, value: value as BrowserRendezvousCommand };
		case "signal":
			if (!isString(value.connectionId) || !isIceSignal(value.signal)) {
				return invalidMessage("signal requires connectionId and a valid ICE signal");
			}
			return { ok: true, value: value as BackendRendezvousCommand | BrowserRendezvousCommand };
		case "close_connection":
			if (!isString(value.connectionId) || !isOptionalString(value.reason)) {
				return invalidMessage("close_connection requires connectionId and an optional reason");
			}
			return { ok: true, value: value as BackendRendezvousCommand | BrowserRendezvousCommand };
		default:
			return unknownMessage(value.type);
	}
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
			if (role !== "backend" || !isString(value.backendId)) return invalidMessage("invalid backend registration");
			break;
		case "connection_request":
			if (role !== "backend" || !isString(value.connectionId)) return invalidMessage("invalid connection request");
			break;
		case "backend_connected":
			if (role !== "browser" || !isString(value.backendId) || !isString(value.connectionId)) {
				return invalidMessage("invalid browser connection acknowledgement");
			}
			break;
		case "signal":
			if (!isString(value.connectionId) || !isIceSignal(value.signal)) return invalidMessage("invalid ICE signal");
			break;
		case "connection_closed":
			if (!isString(value.connectionId) || !isString(value.reason)) return invalidMessage("invalid connection closure");
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

function isErrorCode(value: unknown): value is RendezvousErrorCode {
	return value === "invalid_json"
		|| value === "invalid_message"
		|| value === "unsupported_version"
		|| value === "unknown_message"
		|| value === "backend_offline"
		|| value === "unauthorized_connection";
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
	return value === undefined || typeof value === "string";
}

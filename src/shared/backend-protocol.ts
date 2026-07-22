import type { UpdateTarget } from "./updates.js";

/** Semantic hidden-backend request protocol carried beside application v1 frames. */
export const BACKEND_PROTOCOL_VERSION = 2 as const;
export const BACKEND_PROTOCOL_MAX_FRAME_BYTES = 3 * 1024 * 1024;

export type BackendMethod =
	| "backend.capabilities"
	| "sessions.list"
	| "sessions.delete"
	| "sessions.forkMessages"
	| "sessions.raw"
	| "files.read"
	| "files.upload.create"
	| "files.upload.append"
	| "files.upload.complete"
	| "host.browse"
	| "host.mkdir"
	| "settings.get"
	| "settings.validate"
	| "settings.patch"
	| "settings.save"
	| "updates.get"
	| "updates.run";

export interface BackendMethodParams {
	"backend.capabilities": Record<string, never>;
	"sessions.list": Record<string, never>;
	"sessions.delete": { sessionPath: string };
	"sessions.forkMessages": { sessionPath: string };
	"sessions.raw": { sessionPath: string };
	"files.read": { sessionPath: string; path: string };
	"files.upload.create": { fileName: string; mimeType: string; size: number };
	"files.upload.append": { uploadId: string; offset: number; data: string };
	"files.upload.complete": { uploadId: string };
	"host.browse": { path: string };
	"host.mkdir": { parentPath: string; name: string };
	"settings.get": Record<string, never>;
	"settings.validate": { content: string };
	"settings.patch": { patch: Record<string, unknown> };
	"settings.save": { content: string };
	"updates.get": Record<string, never>;
	"updates.run": { target: UpdateTarget };
}

export type BackendRequestFrame = {
	[Method in BackendMethod]: {
		v: typeof BACKEND_PROTOCOL_VERSION;
		kind: "request";
		id: string;
		method: Method;
		params: BackendMethodParams[Method];
	};
}[BackendMethod];

export type BackendErrorCode =
	| "invalid_json"
	| "invalid_request"
	| "unsupported_version"
	| "unknown_method"
	| "not_found"
	| "forbidden"
	| "conflict"
	| "internal_error";

export interface BackendApiErrorPayload {
	code: BackendErrorCode;
	message: string;
	details?: unknown;
}

export type BackendResponseFrame = {
	v: typeof BACKEND_PROTOCOL_VERSION;
	kind: "response";
	id: string;
	method: string;
} & (
	| { success: true; result: unknown }
	| { success: false; error: BackendApiErrorPayload }
);

export interface BackendEventFrame {
	v: typeof BACKEND_PROTOCOL_VERSION;
	kind: "event";
	cursor: string;
	type: string;
	data: unknown;
}

export type BackendFrame = BackendRequestFrame | BackendResponseFrame | BackendEventFrame;

export type BackendProtocolDecodeResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: BackendApiErrorPayload; requestId: string | null; method: string };

export function encodeBackendFrame(frame: BackendFrame): string {
	return JSON.stringify(frame);
}

export function decodeBackendRequest(raw: string): BackendProtocolDecodeResult<BackendRequestFrame> {
	const envelope = parseEnvelope(raw);
	if (!envelope.ok) return envelope;
	const value = envelope.value;
	const requestId = typeof value.id === "string" ? value.id : null;
	const method = typeof value.method === "string" ? value.method : "";
	if (value.kind !== "request" || !isNonEmptyString(value.id) || !isNonEmptyString(value.method) || !isRecord(value.params)) {
		return invalid("invalid_request", "Backend request envelope is malformed", requestId, method);
	}
	if (!isBackendMethod(value.method)) {
		return invalid("unknown_method", `Unknown backend method: ${value.method}`, value.id, value.method);
	}
	if (!validateParams(value.method, value.params)) {
		return invalid("invalid_request", `Invalid parameters for ${value.method}`, value.id, value.method);
	}
	return { ok: true, value: value as unknown as BackendRequestFrame };
}

export function decodeBackendResponse(raw: string): BackendProtocolDecodeResult<BackendResponseFrame> {
	const envelope = parseEnvelope(raw);
	if (!envelope.ok) return envelope;
	const value = envelope.value;
	const requestId = typeof value.id === "string" ? value.id : null;
	const method = typeof value.method === "string" ? value.method : "";
	if (value.kind !== "response" || !isNonEmptyString(value.id) || !isNonEmptyString(value.method) || typeof value.success !== "boolean") {
		return invalid("invalid_request", "Backend response envelope is malformed", requestId, method);
	}
	if (value.success) {
		if (!("result" in value)) return invalid("invalid_request", "Successful response is missing result", value.id, value.method);
	} else if (!isApiError(value.error)) {
		return invalid("invalid_request", "Failed response is missing a valid error", value.id, value.method);
	}
	return { ok: true, value: value as unknown as BackendResponseFrame };
}

export function isBackendProtocolFrame(raw: string): boolean {
	// `encodeBackendFrame` emits the version first. Keep v1 streaming frames on
	// their hot path without parsing large snapshots twice.
	const prefix = raw.slice(0, 128);
	return /"v"\s*:\s*2(?:\s*[,}])/u.test(prefix)
		&& /"kind"\s*:\s*"(?:request|response|event)"/u.test(prefix);
}

function parseEnvelope(raw: string): BackendProtocolDecodeResult<Record<string, unknown>> {
	if (new TextEncoder().encode(raw).byteLength > BACKEND_PROTOCOL_MAX_FRAME_BYTES) {
		return invalid("invalid_request", "Backend frame exceeds the size limit", null, "");
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return invalid("invalid_json", "Backend frame is not valid JSON", null, "");
	}
	if (!isRecord(value)) return invalid("invalid_request", "Backend frame must be an object", null, "");
	if (value.v !== BACKEND_PROTOCOL_VERSION) {
		return invalid("unsupported_version", `Unsupported backend protocol version: ${String(value.v)}`, null, "");
	}
	return { ok: true, value };
}

function validateParams(method: BackendMethod, params: Record<string, unknown>): boolean {
	switch (method) {
		case "backend.capabilities":
		case "sessions.list":
		case "settings.get":
		case "updates.get":
			return hasOnlyKeys(params, []);
		case "sessions.delete":
		case "sessions.forkMessages":
		case "sessions.raw":
			return hasOnlyKeys(params, ["sessionPath"]) && isNonEmptyString(params.sessionPath);
		case "files.read":
			return hasOnlyKeys(params, ["sessionPath", "path"])
				&& isNonEmptyString(params.sessionPath)
				&& isNonEmptyString(params.path);
		case "files.upload.create":
			return hasOnlyKeys(params, ["fileName", "mimeType", "size"])
				&& isNonEmptyString(params.fileName)
				&& isNonEmptyString(params.mimeType)
				&& Number.isSafeInteger(params.size)
				&& (params.size as number) >= 0;
		case "files.upload.append":
			return hasOnlyKeys(params, ["uploadId", "offset", "data"])
				&& isNonEmptyString(params.uploadId)
				&& Number.isSafeInteger(params.offset)
				&& (params.offset as number) >= 0
				&& isNonEmptyString(params.data);
		case "files.upload.complete":
			return hasOnlyKeys(params, ["uploadId"]) && isNonEmptyString(params.uploadId);
		case "host.browse":
			return hasOnlyKeys(params, ["path"]) && typeof params.path === "string";
		case "host.mkdir":
			return hasOnlyKeys(params, ["parentPath", "name"])
				&& isNonEmptyString(params.parentPath)
				&& isNonEmptyString(params.name);
		case "settings.validate":
		case "settings.save":
			return hasOnlyKeys(params, ["content"]) && typeof params.content === "string";
		case "settings.patch":
			return hasOnlyKeys(params, ["patch"]) && isRecord(params.patch);
		case "updates.run":
			return hasOnlyKeys(params, ["target"])
				&& (params.target === "pipane" || params.target === "pi" || params.target === "extensions");
	}
}

function isBackendMethod(value: string): value is BackendMethod {
	return [
		"backend.capabilities",
		"sessions.list",
		"sessions.delete",
		"sessions.forkMessages",
		"sessions.raw",
		"files.read",
		"files.upload.create",
		"files.upload.append",
		"files.upload.complete",
		"host.browse",
		"host.mkdir",
		"settings.get",
		"settings.validate",
		"settings.patch",
		"settings.save",
		"updates.get",
		"updates.run",
	].includes(value);
}

function isApiError(value: unknown): value is BackendApiErrorPayload {
	return isRecord(value)
		&& isBackendErrorCode(value.code)
		&& isNonEmptyString(value.message);
}

function isBackendErrorCode(value: unknown): value is BackendErrorCode {
	return typeof value === "string" && [
		"invalid_json",
		"invalid_request",
		"unsupported_version",
		"unknown_method",
		"not_found",
		"forbidden",
		"conflict",
		"internal_error",
	].includes(value);
}

function invalid(
	code: BackendErrorCode,
	message: string,
	requestId: string | null,
	method: string,
): BackendProtocolDecodeResult<never> {
	return { ok: false, error: { code, message }, requestId, method };
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

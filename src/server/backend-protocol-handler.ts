import type { BackendApi } from "../shared/backend-api.js";
import {
	BACKEND_PROTOCOL_VERSION,
	decodeBackendRequest,
	encodeBackendFrame,
	type BackendApiErrorPayload,
	type BackendRequestFrame,
	type BackendResponseFrame,
} from "../shared/backend-protocol.js";
import { FRAME_CONNECTION_OPEN, type ServerFrameConnection } from "./frame-connection.js";
import { LocalBackendApiError } from "./local-backend-api.js";

const MAX_COMPLETED_REQUESTS = 128;
const MAX_CACHED_RESPONSE_BYTES = 256 * 1024;
const MAX_ACTIVE_REQUESTS = 64;

/** Device-scoped idempotent semantic dispatcher shared across carrier reconnects. */
export class BackendProtocolHandler {
	private readonly completed = new Map<string, string>();
	private readonly active = new Map<string, Promise<string>>();

	constructor(private readonly api: BackendApi) {}

	accept(connection: ServerFrameConnection, deviceId = "anonymous"): void {
		connection.on("message", (frame) => {
			const raw = frame.toString();
			const decoded = decodeBackendRequest(raw);
			if (!decoded.ok) {
				this.send(connection, {
					v: BACKEND_PROTOCOL_VERSION,
					kind: "response",
					id: decoded.requestId ?? "invalid",
					method: decoded.method || "unknown",
					success: false,
					error: decoded.error,
				});
				return;
			}
			const request = decoded.value;
			const cacheKey = `${deviceId}:${request.id}`;
			const prior = this.completed.get(cacheKey);
			if (prior) {
				if (connection.readyState === FRAME_CONNECTION_OPEN) connection.send(prior);
				return;
			}
			let operation = this.active.get(cacheKey);
			if (!operation) {
				if (this.active.size >= MAX_ACTIVE_REQUESTS) {
					this.send(connection, failure(request, {
						code: "conflict",
						message: "Too many backend requests are active",
					}));
					return;
				}
				operation = this.execute(request, cacheKey);
				this.active.set(cacheKey, operation);
			}
			void operation.then((encoded) => {
				if (connection.readyState === FRAME_CONNECTION_OPEN) connection.send(encoded);
			});
		});
	}

	private async execute(request: BackendRequestFrame, cacheKey: string): Promise<string> {
		let response: BackendResponseFrame;
		try {
			response = {
				v: BACKEND_PROTOCOL_VERSION,
				kind: "response",
				id: request.id,
				method: request.method,
				success: true,
				result: await this.dispatch(request),
			};
		} catch (error) {
			response = failure(request, toApiError(error));
		}
		const encoded = encodeBackendFrame(response);
		remember(this.completed, cacheKey, encoded);
		this.active.delete(cacheKey);
		return encoded;
	}

	private async dispatch(request: BackendRequestFrame): Promise<unknown> {
		switch (request.method) {
			case "backend.capabilities":
				if (!this.api.getCapabilities) throw new Error("Backend capabilities are unavailable");
				return this.api.getCapabilities();
			case "sessions.list": return this.api.listSessions();
			case "sessions.delete": return this.api.deleteSession(request.params.sessionPath).then(() => ({}));
			case "sessions.forkMessages": return this.api.listForkMessages(request.params.sessionPath);
			case "sessions.raw": return this.api.getRawSession(request.params.sessionPath);
			case "files.read": return this.api.getFileContent(request.params.sessionPath, request.params.path);
			case "host.browse": return this.api.browseDirectory(request.params.path);
			case "settings.get": return this.api.getLocalSettings();
			case "settings.validate": return this.api.validateLocalSettings(request.params.content);
			case "settings.patch": return this.api.patchLocalSettings(request.params.patch);
			case "settings.save": return this.api.saveLocalSettings(request.params.content);
			case "updates.get": return this.api.getUpdates();
			case "updates.run": return this.api.runUpdate(request.params.target);
		}
	}

	private send(connection: ServerFrameConnection, response: BackendResponseFrame): void {
		if (connection.readyState === FRAME_CONNECTION_OPEN) connection.send(encodeBackendFrame(response));
	}
}

function failure(request: Pick<BackendRequestFrame, "id" | "method">, error: BackendApiErrorPayload): BackendResponseFrame {
	return {
		v: BACKEND_PROTOCOL_VERSION,
		kind: "response",
		id: request.id,
		method: request.method,
		success: false,
		error,
	};
}

function toApiError(error: unknown): BackendApiErrorPayload {
	if (error instanceof LocalBackendApiError) return { code: error.code, message: error.message };
	return {
		code: "internal_error",
		message: error instanceof Error ? error.message : String(error),
	};
}

function remember(cache: Map<string, string>, id: string, response: string): void {
	if (Buffer.byteLength(response) > MAX_CACHED_RESPONSE_BYTES) return;
	cache.set(id, response);
	if (cache.size <= MAX_COMPLETED_REQUESTS) return;
	const oldest = cache.keys().next().value;
	if (oldest) cache.delete(oldest);
}

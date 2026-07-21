import type {
	BackendApi,
	BackendCapabilities,
	DirectoryListing,
	FileContentResponse,
	LocalSettingsReadResponse,
	LocalSettingsValidationResponse,
	SessionInfoDTO,
} from "../shared/backend-api.js";
import type { FrameTransport } from "./frame-transport.js";
import type { UpdateRunResponse, UpdateSnapshot, UpdateTarget } from "../shared/updates.js";
import {
	BACKEND_PROTOCOL_VERSION,
	decodeBackendResponse,
	encodeBackendFrame,
	isBackendProtocolFrame,
	type BackendApiErrorPayload,
	type BackendMethod,
	type BackendMethodParams,
} from "../shared/backend-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const UPDATE_REQUEST_TIMEOUT_MS = 10 * 60_000;

interface PendingRequest {
	method: BackendMethod;
	encodedFrame: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export class DataChannelBackendApiError extends Error {
	constructor(readonly payload: BackendApiErrorPayload) {
		super(payload.message);
		this.name = "DataChannelBackendApiError";
	}
}

/** Correlated semantic v2 API over the same authenticated DataChannel as v1 events. */
export class DataChannelBackendApi implements BackendApi {
	private requestId = 0;
	private readonly pending = new Map<string, PendingRequest>();

	constructor(
		private readonly transport: FrameTransport,
		private readonly backendId: string,
		private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	) {
		transport.onFrame((raw) => this.handleFrame(raw));
		transport.onConnectionChange(({ connected, reconnected }) => {
			if (!connected || !reconnected) return;
			for (const pending of this.pending.values()) {
				try { this.transport.send(pending.encodedFrame); } catch { /* next reconnect or timeout settles it */ }
			}
		});
	}

	async getCapabilities(): Promise<BackendCapabilities> {
		const value = await this.request("backend.capabilities", {});
		if (!isRecord(value)
			|| value.backendId !== this.backendId
			|| value.semanticProtocolVersion !== BACKEND_PROTOCOL_VERSION
			|| !isPositiveIntegerArray(value.applicationProtocolVersions)
			|| !isStringArray(value.features)) {
			throw new Error("Backend returned invalid capabilities");
		}
		return value as unknown as BackendCapabilities;
	}

	async listSessions(): Promise<SessionInfoDTO[]> {
		const value = await this.request("sessions.list", {});
		if (!Array.isArray(value) || !value.every(isSessionInfo)) throw new Error("Backend returned an invalid session list");
		return value.map((session) => ({ ...session, backendId: this.backendId }));
	}

	async deleteSession(sessionPath: string): Promise<void> {
		await this.request("sessions.delete", { sessionPath });
	}

	async listForkMessages(sessionPath: string): Promise<Array<{ entryId: string; text: string }>> {
		const value = await this.request("sessions.forkMessages", { sessionPath });
		if (!Array.isArray(value) || !value.every((item) => isRecord(item) && isString(item.entryId) && isString(item.text))) {
			throw new Error("Backend returned invalid fork messages");
		}
		return value as Array<{ entryId: string; text: string }>;
	}

	async browseDirectory(path: string): Promise<DirectoryListing> {
		const value = await this.request("host.browse", { path });
		if (!isRecord(value) || !isString(value.path) || !Array.isArray(value.dirs)
			|| !value.dirs.every((item) => isRecord(item) && isString(item.name) && isString(item.path))) {
			throw new Error("Backend returned an invalid directory listing");
		}
		return value as unknown as DirectoryListing;
	}

	async getRawSession(sessionPath: string): Promise<string> {
		const value = await this.request("sessions.raw", { sessionPath });
		if (!isString(value)) throw new Error("Backend returned invalid raw session content");
		return value;
	}

	async getFileContent(sessionPath: string, path: string): Promise<FileContentResponse> {
		const value = await this.request("files.read", { sessionPath, path });
		if (!isRecord(value) || !isString(value.path) || !isString(value.content)) {
			throw new Error("Backend returned invalid file content");
		}
		return value as unknown as FileContentResponse;
	}

	async getLocalSettings(): Promise<LocalSettingsReadResponse> {
		const value = await this.request("settings.get", {});
		if (!isRecord(value) || !isString(value.path) || typeof value.exists !== "boolean"
			|| !isStringArray(value.errors) || !isString(value.formatted) || !("settings" in value)) {
			throw new Error("Backend returned invalid local settings");
		}
		return value as unknown as LocalSettingsReadResponse;
	}

	validateLocalSettings(content: string): Promise<LocalSettingsValidationResponse> {
		return this.settingsMutation("settings.validate", { content });
	}

	patchLocalSettings(patch: Record<string, unknown>): Promise<LocalSettingsValidationResponse> {
		return this.settingsMutation("settings.patch", { patch });
	}

	saveLocalSettings(content: string): Promise<LocalSettingsValidationResponse> {
		return this.settingsMutation("settings.save", { content });
	}

	async getUpdates(): Promise<UpdateSnapshot> {
		const value = await this.request("updates.get", {});
		if (!isRecord(value) || !isString(value.checkedAt) || !Array.isArray(value.notices)) {
			throw new Error("Backend returned an invalid update snapshot");
		}
		return value as unknown as UpdateSnapshot;
	}

	async runUpdate(target: UpdateTarget): Promise<UpdateRunResponse> {
		const value = await this.request("updates.run", { target }, UPDATE_REQUEST_TIMEOUT_MS);
		if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.snapshot)) {
			throw new Error("Backend returned an invalid update result");
		}
		return value as unknown as UpdateRunResponse;
	}

	private async settingsMutation<Method extends "settings.validate" | "settings.patch" | "settings.save">(
		method: Method,
		params: BackendMethodParams[Method],
	): Promise<LocalSettingsValidationResponse> {
		const value = await this.request(method, params);
		if (!isRecord(value) || typeof value.valid !== "boolean" || !isStringArray(value.errors)
			|| (value.formatted !== undefined && !isString(value.formatted))) {
			throw new Error("Backend returned an invalid settings response");
		}
		return value as unknown as LocalSettingsValidationResponse;
	}

	private request<Method extends BackendMethod>(
		method: Method,
		params: BackendMethodParams[Method],
		timeoutMs = this.requestTimeoutMs,
	): Promise<unknown> {
		if (!this.transport.isConnected) return Promise.reject(new Error("Backend transport is not connected"));
		const id = `api_${++this.requestId}_${crypto.randomUUID()}`;
		return new Promise((resolve, reject) => {
			const encodedFrame = encodeBackendFrame({
				v: BACKEND_PROTOCOL_VERSION,
				kind: "request",
				id,
				method,
				params,
			} as any);
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Backend request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { method, encodedFrame, resolve, reject, timer });
			try {
				this.transport.send(encodedFrame);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleFrame(raw: string): void {
		if (!isBackendProtocolFrame(raw)) return;
		const decoded = decodeBackendResponse(raw);
		if (!decoded.ok) return;
		const response = decoded.value;
		const pending = this.pending.get(response.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(response.id);
		if (response.method !== pending.method) {
			pending.reject(new Error(`Backend response method mismatch: expected ${pending.method}, received ${response.method}`));
			return;
		}
		if (response.success) pending.resolve(response.result);
		else pending.reject(new DataChannelBackendApiError(response.error));
	}
}

function isSessionInfo(value: unknown): value is SessionInfoDTO {
	return isRecord(value)
		&& isString(value.id)
		&& isString(value.path)
		&& isString(value.cwd)
		&& isString(value.created)
		&& isString(value.modified)
		&& Number.isSafeInteger(value.messageCount)
		&& isString(value.firstMessage);
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === "string"; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
function isPositiveIntegerArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((item) => Number.isSafeInteger(item) && item > 0);
}

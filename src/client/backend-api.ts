import type { UpdateRunResponse, UpdateSnapshot, UpdateTarget } from "../shared/updates.js";
import type {
	BackendApi,
	DirectoryListing,
	FileContentResponse,
	LocalSettingsReadResponse,
	LocalSettingsValidationResponse,
	SessionInfoDTO,
} from "../shared/backend-api.js";

export type {
	BackendApi,
	BackendCapabilities,
	DirectoryEntry,
	DirectoryListing,
	FileContentResponse,
	LocalSettingsReadResponse,
	LocalSettingsValidationResponse,
	SessionInfoDTO,
	SessionRef,
} from "../shared/backend-api.js";

export interface HttpBackendApiOptions {
	fetch?: typeof globalThis.fetch;
}

export class BackendApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "BackendApiError";
	}
}

/** Current same-origin HTTP implementation of the backend request surface. */
export class HttpBackendApi implements BackendApi {
	private readonly fetch: typeof globalThis.fetch;

	constructor(options: HttpBackendApiOptions = {}) {
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	listSessions(): Promise<SessionInfoDTO[]> {
		return this.requestJson("/api/sessions");
	}

	async deleteSession(sessionPath: string): Promise<void> {
		await this.requestJson("/api/sessions", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: sessionPath }),
		});
	}

	async listForkMessages(sessionPath: string): Promise<Array<{ entryId: string; text: string }>> {
		const data = await this.requestJson<{ messages?: Array<{ entryId: string; text: string }> }>(
			`/api/sessions/fork-messages?path=${encodeURIComponent(sessionPath)}`,
		);
		return data.messages ?? [];
	}

	browseDirectory(path: string): Promise<DirectoryListing> {
		return this.requestJson(`/api/browse?path=${encodeURIComponent(path)}`);
	}

	async getRawSession(sessionPath: string): Promise<string> {
		const response = await this.fetch(`/api/sessions/raw?path=${encodeURIComponent(sessionPath)}`);
		if (!response.ok) throw await this.toError(response, "Failed to load raw session");
		return response.text();
	}

	getFileContent(sessionPath: string, path: string): Promise<FileContentResponse> {
		const query = new URLSearchParams({ sessionPath, path });
		return this.requestJson(`/api/files/content?${query}`, { cache: "no-store" });
	}

	getLocalSettings(): Promise<LocalSettingsReadResponse> {
		return this.requestJson("/api/settings/local");
	}

	validateLocalSettings(content: string): Promise<LocalSettingsValidationResponse> {
		return this.requestValidation("/api/settings/local/validate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		});
	}

	patchLocalSettings(patch: Record<string, unknown>): Promise<LocalSettingsValidationResponse> {
		return this.requestValidation("/api/settings/local", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
	}

	saveLocalSettings(content: string): Promise<LocalSettingsValidationResponse> {
		return this.requestValidation("/api/settings/local", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		});
	}

	getUpdates(): Promise<UpdateSnapshot> {
		return this.requestJson("/api/updates", { cache: "no-store" });
	}

	runUpdate(target: UpdateTarget): Promise<UpdateRunResponse> {
		return this.requestJson(`/api/updates/${target}`, {
			method: "POST",
			headers: { "X-Pipane-Action": "update" },
		});
	}

	private async requestValidation(
		path: string,
		init: RequestInit,
	): Promise<LocalSettingsValidationResponse> {
		const response = await this.fetch(path, init);
		const data = await this.readJson(response);
		if (!response.ok && typeof data?.valid !== "boolean") {
			throw this.errorFromPayload(response, data, "Settings request failed");
		}
		return data as LocalSettingsValidationResponse;
	}

	private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
		const response = init ? await this.fetch(path, init) : await this.fetch(path);
		const data = await this.readJson(response);
		if (!response.ok) throw this.errorFromPayload(response, data, `Backend request failed (${response.status})`);
		return data as T;
	}

	private async readJson(response: Response): Promise<any> {
		return response.json().catch(() => ({}));
	}

	private async toError(response: Response, fallback: string): Promise<BackendApiError> {
		const data = await this.readJson(response);
		return this.errorFromPayload(response, data, fallback);
	}

	private errorFromPayload(response: Response, data: any, fallback: string): BackendApiError {
		const errors = Array.isArray(data?.errors) ? data.errors.filter((item: unknown) => typeof item === "string") : [];
		const message = typeof data?.error === "string"
			? data.error
			: errors.length > 0
				? errors.join("\n")
				: fallback;
		return new BackendApiError(message, response.status, data);
	}
}

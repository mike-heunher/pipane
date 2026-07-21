import { existsSync, readFileSync, readdirSync, realpathSync, statSync, watchFile } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import { WS_PROTOCOL_VERSION } from "../shared/ws-protocol.js";
import type {
	BackendApi,
	BackendCapabilities,
	DirectoryListing,
	FileContentResponse,
	LocalSettingsReadResponse,
	LocalSettingsValidationResponse,
	SessionInfoDTO,
} from "../shared/backend-api.js";
import { conversationMentionsFile } from "./conversation-file-access.js";
import { LocalSettingsStore } from "./local-settings.js";
import { SessionIndex } from "./session-index.js";
import { getSessionCwd } from "./session-cwd.js";
import { SessionPathError, SessionPathGuard } from "./session-path.js";
import type { UpdateApiManager } from "./update-api.js";

const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;
const watchedSettingsPaths = new Set<string>();

export class LocalBackendApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: "invalid_request" | "not_found" | "forbidden" | "conflict" | "internal_error",
	) {
		super(message);
		this.name = "LocalBackendApiError";
	}
}

export interface LocalBackendApiOptions {
	localSettingsStore?: LocalSettingsStore;
	sessionPaths?: SessionPathGuard;
	backendId?: string | (() => string | undefined);
	updateManager?: UpdateApiManager;
	onLocalSettingsReloaded?: () => void;
	runSessionMutation?: (
		sessionPath: string,
		operation: string,
		mutation: () => Promise<void>,
	) => Promise<void>;
}

/** One semantic implementation shared by local HTTP and authenticated DataChannels. */
export class LocalBackendApi implements BackendApi {
	readonly localSettingsStore: LocalSettingsStore;
	private readonly sessionPaths: SessionPathGuard;
	private readonly backendId: () => string | undefined;
	private readonly updateManager?: UpdateApiManager;
	private readonly onLocalSettingsReloaded?: () => void;
	private readonly runSessionMutation?: LocalBackendApiOptions["runSessionMutation"];
	private readonly sessionIndex: SessionIndex;

	constructor(options: LocalBackendApiOptions = {}) {
		this.localSettingsStore = options.localSettingsStore ?? new LocalSettingsStore();
		this.sessionPaths = options.sessionPaths ?? new SessionPathGuard();
		const configuredBackendId = options.backendId;
		this.backendId = typeof configuredBackendId === "function" ? configuredBackendId : () => configuredBackendId;
		this.updateManager = options.updateManager;
		this.onLocalSettingsReloaded = options.onLocalSettingsReloaded;
		this.runSessionMutation = options.runSessionMutation;
		this.sessionIndex = new SessionIndex({
			cwdDisplayFormatter: (cwd) => this.localSettingsStore.formatCwdTitle(cwd),
		});
		this.startLocalSettingsWatcher();
	}

	async getCapabilities(): Promise<BackendCapabilities> {
		const backendId = this.backendId();
		if (!backendId) throw new LocalBackendApiError("Backend identity is unavailable", 503, "conflict");
		return {
			backendId,
			semanticProtocolVersion: BACKEND_PROTOCOL_VERSION,
			applicationProtocolVersions: [WS_PROTOCOL_VERSION],
			features: [
				"sessions",
				"host-browse",
				"file-preview",
				"local-settings",
				"updates",
			],
		};
	}

	listSessions(): Promise<SessionInfoDTO[]> {
		return this.sessionIndex.listSessions();
	}

	async deleteSession(sessionPath: string): Promise<void> {
		const resolved = this.resolveSession(sessionPath);
		const remove = () => unlink(resolved);
		if (this.runSessionMutation) await this.runSessionMutation(resolved, "delete session", remove);
		else await remove();
	}

	async listForkMessages(sessionPath: string): Promise<Array<{ entryId: string; text: string }>> {
		const content = readFileSync(this.resolveSession(sessionPath), "utf8");
		const entries = parseSessionEntries(content);
		const messages: Array<{ entryId: string; text: string }> = [];
		for (const entry of entries) {
			if ((entry as any).type !== "message") continue;
			const message = (entry as any).message;
			if (!message || message.role !== "user") continue;
			const text = typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("")
					: "";
			if (text && (entry as any).id) messages.push({ entryId: (entry as any).id, text });
		}
		return messages;
	}

	browseDirectory(requestedPath: string): Promise<DirectoryListing> {
		const resolved = path.resolve((requestedPath || process.env.HOME || "/").replace(/^~/, process.env.HOME || "/"));
		if (!existsSync(resolved)) throw new LocalBackendApiError("Path not found", 404, "not_found");
		const dirs = readdirSync(resolved, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
			.sort((left, right) => left.name.localeCompare(right.name));
		return Promise.resolve({ path: resolved, dirs });
	}

	getRawSession(sessionPath: string): Promise<string> {
		return Promise.resolve(readFileSync(this.resolveSession(sessionPath), "utf8"));
	}

	getFileContent(sessionPath: string, requestedPath: string): Promise<FileContentResponse> {
		const resolvedSession = this.resolveSession(sessionPath);
		const sessionCwd = getSessionCwd(resolvedSession);
		if (!sessionCwd) throw new LocalBackendApiError("Session has no working directory", 400, "invalid_request");
		const root = this.realpath(path.resolve(sessionCwd.replace(/^~/, process.env.HOME || "/")));
		const requested = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(root, requestedPath);
		const resolved = this.realpath(requested);
		if (!isPathInside(root, resolved) && !conversationMentionsFile({
			sessionPath: resolvedSession,
			sessionCwd,
			rawRequestPath: requestedPath,
			requestedPath: requested,
			resolvedPath: resolved,
		})) {
			throw new LocalBackendApiError(
				"File is outside the session working directory and was not mentioned in the conversation",
				403,
				"forbidden",
			);
		}
		const stat = statSync(resolved);
		if (!stat.isFile()) throw new LocalBackendApiError("Path is not a file", 400, "invalid_request");
		if (stat.size > MAX_PREVIEW_FILE_BYTES) throw new LocalBackendApiError("File is too large to preview", 413, "invalid_request");
		const bytes = readFileSync(resolved);
		if (bytes.includes(0)) throw new LocalBackendApiError("Binary files cannot be previewed", 415, "invalid_request");
		return Promise.resolve({ path: resolved, content: bytes.toString("utf8") });
	}

	getLocalSettings(): Promise<LocalSettingsReadResponse> {
		return Promise.resolve(this.localSettingsStore.read());
	}

	validateLocalSettings(content: string): Promise<LocalSettingsValidationResponse> {
		return Promise.resolve(this.localSettingsStore.validate(content));
	}

	async patchLocalSettings(patch: Record<string, unknown>): Promise<LocalSettingsValidationResponse> {
		const result = this.localSettingsStore.patch(patch);
		if (result.valid) await this.settingsChanged();
		return result;
	}

	async saveLocalSettings(content: string): Promise<LocalSettingsValidationResponse> {
		const result = this.localSettingsStore.save(content);
		if (result.valid) await this.settingsChanged();
		return result;
	}

	async getUpdates() {
		if (!this.updateManager) throw new LocalBackendApiError("Update service is unavailable", 503, "conflict");
		return this.updateManager.check();
	}

	async runUpdate(target: Parameters<BackendApi["runUpdate"]>[0]) {
		if (!this.updateManager) throw new LocalBackendApiError("Update service is unavailable", 503, "conflict");
		const result = await this.updateManager.run(target);
		return { result, snapshot: this.updateManager.currentSnapshot };
	}

	private resolveSession(sessionPath: string): string {
		try {
			return this.sessionPaths.resolveExisting(sessionPath);
		} catch (error) {
			if (error instanceof SessionPathError) {
				throw new LocalBackendApiError(
					error.message,
					error.code === "not_found" ? 404 : 400,
					error.code === "not_found" ? "not_found" : "invalid_request",
				);
			}
			throw error;
		}
	}

	private realpath(candidate: string): string {
		try {
			return realpathSync(candidate);
		} catch (error: any) {
			if (error?.code === "ENOENT") throw new LocalBackendApiError("File not found", 404, "not_found");
			throw error;
		}
	}

	private async settingsChanged(): Promise<void> {
		await this.sessionIndex.invalidateAll();
		this.onLocalSettingsReloaded?.();
	}

	private startLocalSettingsWatcher(): void {
		const settingsPath = this.localSettingsStore.path;
		if (watchedSettingsPaths.has(settingsPath)) return;
		watchedSettingsPaths.add(settingsPath);
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		watchFile(settingsPath, { interval: 500 }, () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				if (!this.localSettingsStore.reloadFromDiskIfValid()) return;
				void this.settingsChanged();
			}, 150);
		});
	}
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

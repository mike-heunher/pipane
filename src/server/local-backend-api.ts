import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, watchFile } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { MAX_UPLOAD_FILE_BYTES } from "../shared/backend-api.js";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import { WS_PROTOCOL_VERSION, type InlineWireImage } from "../shared/ws-protocol.js";
import type {
	BackendApi,
	BackendCapabilities,
	DirectoryEntry,
	DirectoryListing,
	FileContentResponse,
	FileUploadChunk,
	FileUploadChunkResponse,
	FileUploadMetadata,
	FileUploadResponse,
	FileUploadSession,
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
const MAX_UPLOAD_CHUNK_BYTES = 256 * 1024;
const MAX_ACTIVE_UPLOADS = 32;
const MAX_COMPLETED_UPLOADS = 256;
const watchedSettingsPaths = new Set<string>();

interface ActiveUploadChunk {
	length: number;
	digest: string;
	operation: Promise<void>;
}

interface ActiveFileUpload extends FileUploadMetadata {
	path: string;
	received: number;
	chunks: Map<number, ActiveUploadChunk>;
}

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
	uploadDirectory?: string;
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
	private readonly uploadDirectory: string;
	private readonly updateManager?: UpdateApiManager;
	private readonly onLocalSettingsReloaded?: () => void;
	private readonly runSessionMutation?: LocalBackendApiOptions["runSessionMutation"];
	private readonly sessionIndex: SessionIndex;
	private readonly uploads = new Map<string, ActiveFileUpload>();
	/** Exact completed upload paths eligible for server-side image materialization. */
	private readonly completedUploads = new Map<string, FileUploadResponse>();

	constructor(options: LocalBackendApiOptions = {}) {
		this.localSettingsStore = options.localSettingsStore ?? new LocalSettingsStore();
		this.sessionPaths = options.sessionPaths ?? new SessionPathGuard();
		const configuredBackendId = options.backendId;
		this.backendId = typeof configuredBackendId === "function" ? configuredBackendId : () => configuredBackendId;
		this.uploadDirectory = path.resolve(options.uploadDirectory ?? os.tmpdir());
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
				"host-mkdir",
				"file-preview",
				"file-upload",
				"local-settings",
				"updates",
			],
		};
	}

	listSessions(): Promise<SessionInfoDTO[]> {
		return this.sessionIndex.listSessions();
	}

	async deleteSession(sessionPath: string): Promise<void> {
		let resolved: string;
		try {
			resolved = this.resolveSession(sessionPath);
		} catch (error) {
			// DELETE is idempotent; a stale catalog or another browser may already
			// have removed a valid, confined session path.
			if (error instanceof LocalBackendApiError && error.code === "not_found") return;
			throw error;
		}
		const remove = () => unlink(resolved);
		try {
			if (this.runSessionMutation) await this.runSessionMutation(resolved, "delete session", remove);
			else await remove();
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
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
		const resolved = resolveHostPath(requestedPath);
		if (!existsSync(resolved)) throw new LocalBackendApiError("Path not found", 404, "not_found");
		const dirs = readdirSync(resolved, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
			.sort((left, right) => left.name.localeCompare(right.name));
		return Promise.resolve({ path: resolved, dirs });
	}

	async createDirectory(parentPath: string, name: string): Promise<DirectoryEntry> {
		if (!name.trim() || name === "." || name === ".." || name.includes("/") || name.includes("\0") || Buffer.byteLength(name) > 255) {
			throw new LocalBackendApiError("Folder name is invalid", 400, "invalid_request");
		}
		const resolvedParent = resolveHostPath(parentPath);
		if (!existsSync(resolvedParent)) throw new LocalBackendApiError("Parent folder not found", 404, "not_found");
		if (!statSync(resolvedParent).isDirectory()) {
			throw new LocalBackendApiError("Parent path is not a folder", 400, "invalid_request");
		}

		const directoryPath = path.join(resolvedParent, name);
		try {
			await mkdir(directoryPath);
		} catch (error: any) {
			if (error?.code === "EEXIST") throw new LocalBackendApiError("A folder with that name already exists", 409, "conflict");
			if (error?.code === "ENOENT") throw new LocalBackendApiError("Parent folder not found", 404, "not_found");
			if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
				throw new LocalBackendApiError("Cannot create a folder here", 403, "forbidden");
			}
			throw error;
		}
		return { name, path: directoryPath };
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

	async createFileUpload(metadata: FileUploadMetadata): Promise<FileUploadSession> {
		if (!metadata || typeof metadata.fileName !== "string" || metadata.fileName.length === 0) {
			throw new LocalBackendApiError("Upload filename is required", 400, "invalid_request");
		}
		if (typeof metadata.mimeType !== "string" || metadata.mimeType.length === 0 || metadata.mimeType.length > 255) {
			throw new LocalBackendApiError("Upload MIME type is invalid", 400, "invalid_request");
		}
		if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_UPLOAD_FILE_BYTES) {
			throw new LocalBackendApiError(
				`Upload exceeds the ${Math.round(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)}MB size limit`,
				413,
				"invalid_request",
			);
		}
		if (this.uploads.size >= MAX_ACTIVE_UPLOADS) {
			throw new LocalBackendApiError("Too many file uploads are active", 409, "conflict");
		}

		await mkdir(this.uploadDirectory, { recursive: true, mode: 0o700 });
		const directory = await mkdtemp(path.join(this.uploadDirectory, "pipane-upload-"));
		const fileName = safeUploadFileName(metadata.fileName);
		const uploadPath = path.join(directory, fileName);
		try {
			const file = await open(uploadPath, "wx", 0o600);
			try {
				await file.truncate(metadata.size);
			} finally {
				await file.close();
			}
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}

		const uploadId = randomUUID();
		this.uploads.set(uploadId, {
			fileName,
			mimeType: metadata.mimeType,
			size: metadata.size,
			path: uploadPath,
			received: 0,
			chunks: new Map(),
		});
		return { uploadId };
	}

	async appendFileUpload(chunk: FileUploadChunk): Promise<FileUploadChunkResponse> {
		const upload = this.uploads.get(chunk.uploadId);
		if (!upload) throw new LocalBackendApiError("File upload was not found", 404, "not_found");
		if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0) {
			throw new LocalBackendApiError("Upload chunk offset is invalid", 400, "invalid_request");
		}
		const bytes = decodeUploadChunk(chunk.data);
		if (bytes.length === 0 || bytes.length > MAX_UPLOAD_CHUNK_BYTES) {
			throw new LocalBackendApiError("Upload chunk size is invalid", 413, "invalid_request");
		}
		const end = chunk.offset + bytes.length;
		if (end > upload.size) {
			throw new LocalBackendApiError("Upload chunk exceeds the declared file size", 400, "invalid_request");
		}

		const digest = createHash("sha256").update(bytes).digest("hex");
		const prior = upload.chunks.get(chunk.offset);
		if (prior) {
			if (prior.length !== bytes.length || prior.digest !== digest) {
				throw new LocalBackendApiError("Upload chunk conflicts with existing data", 409, "conflict");
			}
			await prior.operation;
			return { nextOffset: end };
		}
		for (const [existingOffset, existing] of upload.chunks) {
			if (chunk.offset < existingOffset + existing.length && existingOffset < end) {
				throw new LocalBackendApiError("Upload chunk overlaps existing data", 409, "conflict");
			}
		}

		const operation = writeUploadChunk(upload.path, chunk.offset, bytes).then(() => {
			upload.received += bytes.length;
		});
		upload.chunks.set(chunk.offset, { length: bytes.length, digest, operation });
		try {
			await operation;
		} catch (error) {
			upload.chunks.delete(chunk.offset);
			throw error;
		}
		return { nextOffset: end };
	}

	async completeFileUpload(uploadId: string): Promise<FileUploadResponse> {
		const upload = this.uploads.get(uploadId);
		if (!upload) throw new LocalBackendApiError("File upload was not found", 404, "not_found");
		await Promise.all([...upload.chunks.values()].map((chunk) => chunk.operation));
		if (upload.received !== upload.size) {
			throw new LocalBackendApiError(
				`File upload is incomplete (${upload.received} of ${upload.size} bytes received)`,
				409,
				"conflict",
			);
		}
		this.uploads.delete(uploadId);
		const completed = {
			path: upload.path,
			fileName: upload.fileName,
			mimeType: upload.mimeType,
			size: upload.size,
		};
		this.completedUploads.set(completed.path, completed);
		while (this.completedUploads.size > MAX_COMPLETED_UPLOADS) {
			const oldestPath = this.completedUploads.keys().next().value;
			if (typeof oldestPath !== "string") break;
			this.completedUploads.delete(oldestPath);
		}
		return completed;
	}

	/** Read only an exact file path produced by this server's completed upload flow. */
	async materializeUploadedImage(uploadedPath: string, mimeType: string): Promise<InlineWireImage> {
		const upload = this.completedUploads.get(uploadedPath);
		if (!upload) throw new LocalBackendApiError("Uploaded image was not found", 404, "not_found");
		if (!mimeType.startsWith("image/") || upload.mimeType !== mimeType) {
			throw new LocalBackendApiError("Uploaded image MIME type does not match", 400, "invalid_request");
		}
		const bytes = await readFile(upload.path);
		if (bytes.length !== upload.size) {
			throw new LocalBackendApiError("Uploaded image size changed", 409, "conflict");
		}
		return { type: "image", data: bytes.toString("base64"), mimeType: upload.mimeType };
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

function resolveHostPath(requestedPath: string): string {
	return path.resolve((requestedPath || process.env.HOME || "/").replace(/^~/, process.env.HOME || "/"));
}

function safeUploadFileName(fileName: string): string {
	const baseName = path.basename(fileName.replaceAll("\\", "/"))
		.replace(/[\u0000-\u001f\u007f]/gu, "_")
		.trim();
	if (!baseName || baseName === "." || baseName === "..") return "upload.bin";

	const extension = truncateUtf8(path.extname(baseName), 40);
	const stem = truncateUtf8(baseName.slice(0, Math.max(0, baseName.length - path.extname(baseName).length)), 200 - Buffer.byteLength(extension));
	return `${stem || "upload"}${extension}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
	const characters = Array.from(value);
	while (characters.length > 0 && Buffer.byteLength(characters.join("")) > maxBytes) characters.pop();
	return characters.join("");
}

function decodeUploadChunk(data: unknown): Buffer {
	if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
		throw new LocalBackendApiError("Upload chunk is not valid base64", 400, "invalid_request");
	}
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const expectedBytes = (data.length / 4) * 3 - padding;
	const bytes = Buffer.from(data, "base64");
	if (bytes.length !== expectedBytes) {
		throw new LocalBackendApiError("Upload chunk is not valid base64", 400, "invalid_request");
	}
	return bytes;
}

async function writeUploadChunk(uploadPath: string, offset: number, bytes: Buffer): Promise<void> {
	const file = await open(uploadPath, "r+");
	try {
		let written = 0;
		while (written < bytes.length) {
			const result = await file.write(bytes, written, bytes.length - written, offset + written);
			if (result.bytesWritten <= 0) throw new Error("Failed to write uploaded file chunk");
			written += result.bytesWritten;
		}
	} finally {
		await file.close();
	}
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

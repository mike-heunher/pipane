import type { UpdateRunResponse, UpdateSnapshot, UpdateTarget } from "./updates.js";

export interface SessionRef {
	backendId: string;
	path: string;
}

export const UPLOADED_IMAGE_PROMPT_FEATURE = "uploaded-image-prompt";
export const CONTENT_ADDRESSED_SESSION_SYNC_FEATURE = "content-addressed-session-sync";

export interface BackendCapabilities {
	backendId: string;
	semanticProtocolVersion: number;
	applicationProtocolVersions: number[];
	features: string[];
}

export interface SessionInfoDTO {
	id: string;
	/** Present for remote semantic responses; local same-origin sessions are implicitly scoped. */
	backendId?: string;
	path: string;
	cwd: string;
	cwdDisplay?: string;
	worktreeName?: string;
	name?: string;
	created: string;
	modified: string;
	/** ISO timestamp of the most recent user input prompt, if any. */
	lastUserPromptTime?: string;
	messageCount: number;
	firstMessage: string;
}

export interface DirectoryEntry {
	name: string;
	path: string;
}

export interface DirectoryListing {
	path: string;
	dirs: DirectoryEntry[];
}

export interface LocalSettingsReadResponse {
	path: string;
	exists: boolean;
	errors: string[];
	settings: any;
	formatted: string;
}

export interface LocalSettingsValidationResponse {
	valid: boolean;
	errors: string[];
	formatted?: string;
}

export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;

export interface FileContentResponse {
	path: string;
	content: string;
}

export interface FileUploadMetadata {
	fileName: string;
	mimeType: string;
	size: number;
}

export interface FileUploadSession {
	uploadId: string;
}

export interface FileUploadChunk {
	uploadId: string;
	offset: number;
	data: string;
}

export interface FileUploadChunkResponse {
	nextOffset: number;
}

export interface FileUploadResponse extends FileUploadMetadata {
	path: string;
}

/** Semantic request surface independent of HTTP or DataChannel transport. */
export interface BackendApi {
	getCapabilities?(): Promise<BackendCapabilities>;
	listSessions(): Promise<SessionInfoDTO[]>;
	deleteSession(sessionPath: string): Promise<void>;
	listForkMessages(sessionPath: string): Promise<Array<{ entryId: string; text: string }>>;
	browseDirectory(path: string): Promise<DirectoryListing>;
	createDirectory(parentPath: string, name: string): Promise<DirectoryEntry>;
	getRawSession(sessionPath: string): Promise<string>;
	getFileContent(sessionPath: string, path: string): Promise<FileContentResponse>;
	createFileUpload(metadata: FileUploadMetadata): Promise<FileUploadSession>;
	appendFileUpload(chunk: FileUploadChunk): Promise<FileUploadChunkResponse>;
	completeFileUpload(uploadId: string): Promise<FileUploadResponse>;
	getLocalSettings(): Promise<LocalSettingsReadResponse>;
	validateLocalSettings(content: string): Promise<LocalSettingsValidationResponse>;
	patchLocalSettings(patch: Record<string, unknown>): Promise<LocalSettingsValidationResponse>;
	saveLocalSettings(content: string): Promise<LocalSettingsValidationResponse>;
	getUpdates(): Promise<UpdateSnapshot>;
	runUpdate(target: UpdateTarget): Promise<UpdateRunResponse>;
}

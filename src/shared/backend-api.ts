import type { UpdateRunResponse, UpdateSnapshot, UpdateTarget } from "./updates.js";

export interface SessionRef {
	backendId: string;
	path: string;
}

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

export interface FileContentResponse {
	path: string;
	content: string;
}

/** Semantic request surface independent of HTTP or DataChannel transport. */
export interface BackendApi {
	getCapabilities?(): Promise<BackendCapabilities>;
	listSessions(): Promise<SessionInfoDTO[]>;
	deleteSession(sessionPath: string): Promise<void>;
	listForkMessages(sessionPath: string): Promise<Array<{ entryId: string; text: string }>>;
	browseDirectory(path: string): Promise<DirectoryListing>;
	getRawSession(sessionPath: string): Promise<string>;
	getFileContent(sessionPath: string, path: string): Promise<FileContentResponse>;
	getLocalSettings(): Promise<LocalSettingsReadResponse>;
	validateLocalSettings(content: string): Promise<LocalSettingsValidationResponse>;
	patchLocalSettings(patch: Record<string, unknown>): Promise<LocalSettingsValidationResponse>;
	saveLocalSettings(content: string): Promise<LocalSettingsValidationResponse>;
	getUpdates(): Promise<UpdateSnapshot>;
	runUpdate(target: UpdateTarget): Promise<UpdateRunResponse>;
}

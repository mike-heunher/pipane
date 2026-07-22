import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCallTimings } from "../shared/tool-runtime.js";
import type { SlashCommandInfo } from "../shared/ws-protocol.js";
import type { ThinkingLevelValue } from "../shared/thinking-levels.js";
import type { BackendApi, SessionInfoDTO } from "./backend-api.js";
import type { ConnectionDiagnostics } from "./frame-transport.js";
import type { AuthorizedBackendDescriptor } from "../shared/trust-protocol.js";

export type { SessionInfoDTO } from "./backend-api.js";

export type SessionStatus = "virtual" | "detached" | "attached";

export interface BackendClientState {
	model: any;
	thinkingLevel: ThinkingLevelValue;
	messages: AgentMessage[];
	isStreaming: boolean;
	error?: string;
}

export interface PiInstallRequiredInfo {
	command: string;
	installable: boolean;
	installing: boolean;
	message: string;
}

/**
 * Carrier-neutral contract consumed by the browser application.
 *
 * The current implementation uses HTTP plus WebSocket. A remote implementation
 * can use a WebRTC DataChannel without changing components or application state.
 */
export interface WorkspaceBackendState extends AuthorizedBackendDescriptor {
	connected: boolean;
	reconnecting: boolean;
	error?: string;
}

export interface BackendClient extends BackendApi {
	readonly state: BackendClientState;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly sessionName: string | undefined;
	readonly sessionStatus: SessionStatus;
	readonly isConnected: boolean;
	readonly isReconnecting: boolean;
	readonly pendingToolCallIds: ReadonlySet<string>;
	readonly toolCallTimings: Readonly<ToolCallTimings>;
	readonly steeringQueue: readonly string[];
	readonly extensionStatuses: ReadonlyMap<string, string>;
	readonly cwd: string | undefined;
	readonly optimisticSessions: SessionInfoDTO[];
	readonly virtualSessionInfo: SessionInfoDTO | undefined;
	/** Present for the account-wide remote workspace; absent for a local backend. */
	readonly activeBackendId?: string;
	readonly workspaceBackends?: readonly WorkspaceBackendState[];

	connect(endpoint: string): Promise<void>;
	disconnect(): void;
	getConnectionDiagnostics?(): Promise<ConnectionDiagnostics | undefined>;
	onConnectionChange(fn: (connected: boolean) => void): () => void;
	onExtensionStatusChange(fn: () => void): () => void;
	onGlobalStatusChange(fn: () => void): () => void;
	onSteeringQueueChange(fn: () => void): () => void;
	onSessionChange(fn: () => void): () => void;
	onContentChange(fn: () => void): () => void;
	onStatusChange(fn: () => void): () => void;
	onSessionsChanged(fn: (file: string) => void): () => void;
	onPiInstallRequired(fn: (info: PiInstallRequiredInfo) => void): () => void;
	/** Account-wide backend/session catalog changes. */
	onWorkspaceChange?(fn: () => void): () => void;

	getSessionStatus(sessionPath: string, backendId?: string): "running" | "done" | undefined;
	deleteSession(sessionPath: string, backendId?: string): Promise<void>;
	browseDirectory(path: string, backendId?: string): ReturnType<BackendApi["browseDirectory"]>;
	createDirectory(parentPath: string, name: string, backendId?: string): ReturnType<BackendApi["createDirectory"]>;
	reportError(error: unknown, prefix?: string): void;
	fetchAvailableModels(): Promise<any[]>;
	installPi(): Promise<void>;
	loadDefaultModel(): Promise<void>;
	setCwd(cwd: string): void;
	prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void>;
	fetchCommands(): Promise<SlashCommandInfo[]>;
	abort(): void;
	hardKill(): void;
	steer(message: AgentMessage): void;
	removeSteering(index: number): void;
	setModel(model: Model<any>): void;
	setThinkingLevel(level: ThinkingLevelValue): void;
	getForkMessages(): Promise<Array<{ entryId: string; text: string }>>;
	fork(entryId: string): Promise<{ text: string; cancelled: boolean; newSessionPath: string | null }>;
	forkAndPrompt(text: string, images?: ImageContent[]): Promise<void>;
	switchSession(sessionPath: string, cwd?: string, backendId?: string): Promise<void>;
	newSession(cwd?: string, backendId?: string): Promise<void>;
	/** Pause or restore full session snapshots while retaining host-level status/catalog events. */
	setSessionSubscriptionActive?(active: boolean): Promise<void>;
	activateBackend?(backendId: string): Promise<void>;
	getBackendConnectionDiagnostics?(backendId: string): Promise<ConnectionDiagnostics | undefined>;
	removeBackend?(backendId: string): Promise<void>;
}

export type SessionPickerBackendClient = Pick<
	BackendClient,
	| "sessionId"
	| "sessionStatus"
	| "optimisticSessions"
	| "virtualSessionInfo"
	| "getSessionStatus"
	| "onGlobalStatusChange"
	| "onSessionChange"
	| "onSessionsChanged"
	| "onStatusChange"
	| "onWorkspaceChange"
	| "activeBackendId"
	| "workspaceBackends"
	| "activateBackend"
	| "getBackendConnectionDiagnostics"
	| "removeBackend"
	| "listSessions"
	| "switchSession"
	| "newSession"
	| "deleteSession"
	| "browseDirectory"
	| "createDirectory"
>;

export type ForkBackendClient = Pick<BackendClient, "getForkMessages" | "fork">;

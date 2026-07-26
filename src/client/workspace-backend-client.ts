import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AuthorizedBackendDescriptor } from "../shared/trust-protocol.js";
import type { WireImage } from "../shared/ws-protocol.js";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import type { SlashCommandInfo } from "../shared/ws-protocol.js";
import type { ThinkingLevelValue } from "../shared/thinking-levels.js";
import type { UpdateTarget } from "../shared/updates.js";
import type {
	BackendClient,
	BackendClientState,
	PiInstallRequiredInfo,
	SessionInfoDTO,
	SessionStatus,
	WorkspaceBackendState,
} from "./backend-client.js";
import type {
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
} from "./backend-api.js";
import type { ConnectionDiagnostics } from "./frame-transport.js";
import type { ToolCallTimings } from "../shared/tool-runtime.js";
import type { UpdateRunResponse, UpdateSnapshot } from "../shared/updates.js";

interface WorkspaceBackendManager {
	getClient(backendId: string): BackendClient;
	revokeBackend(backendId: string): Promise<void>;
}

interface BackendContext {
	descriptor: AuthorizedBackendDescriptor;
	client?: BackendClient;
	sessions: SessionInfoDTO[];
	error?: string;
	initializing?: Promise<void>;
	initialized: boolean;
	unsubscribers: Array<() => void>;
}

const EMPTY_STATE: BackendClientState = {
	model: undefined,
	thinkingLevel: "off",
	messages: [],
	isStreaming: false,
};

/**
 * Account-wide browser workspace.
 *
 * Each host retains its existing isolated BackendClient. This facade merges only
 * session metadata/status while delegating the conversation surface to one
 * active host at a time, so inactive hosts never stream conversation history.
 */
export class WorkspaceBackendClient implements BackendClient {
	private readonly contexts = new Map<string, BackendContext>();
	private activeId: string;
	private endpoint = "webrtc";
	private connectedOnce = false;

	private readonly connectionListeners = new Set<(connected: boolean) => void>();
	private readonly extensionStatusListeners = new Set<() => void>();
	private readonly globalStatusListeners = new Set<() => void>();
	private readonly steeringQueueListeners = new Set<() => void>();
	private readonly sessionListeners = new Set<() => void>();
	private readonly contentListeners = new Set<() => void>();
	private readonly statusListeners = new Set<() => void>();
	private readonly sessionsChangedListeners = new Set<(file: string) => void>();
	private readonly piInstallRequiredListeners = new Set<(info: PiInstallRequiredInfo) => void>();
	private readonly workspaceListeners = new Set<() => void>();

	constructor(
		descriptors: readonly AuthorizedBackendDescriptor[],
		private readonly manager: WorkspaceBackendManager,
		initialBackendId?: string,
	) {
		if (descriptors.length === 0) throw new Error("No authorized backends are available");
		for (const descriptor of descriptors) {
			this.contexts.set(descriptor.backendId, {
				descriptor: { ...descriptor, protocolVersions: [...descriptor.protocolVersions] },
				sessions: [],
				...(!this.isCompatible(descriptor) ? { error: `Update required for semantic protocol v${BACKEND_PROTOCOL_VERSION}` } : {}),
				initialized: false,
				unsubscribers: [],
			});
		}
		this.activeId = this.chooseInitialBackend(initialBackendId);
		this.ensureClient(this.requireContext(this.activeId));
	}

	get state(): BackendClientState { return this.activeClient?.state ?? EMPTY_STATE; }
	get sessionId(): string { return this.activeClient?.sessionId ?? ""; }
	get sessionFile(): string | undefined { return this.activeClient?.sessionFile; }
	get sessionName(): string | undefined { return this.activeClient?.sessionName; }
	get sessionStatus(): SessionStatus { return this.activeClient?.sessionStatus ?? "virtual"; }
	get isConnected(): boolean { return this.activeClient?.isConnected ?? false; }
	get isReconnecting(): boolean { return this.activeClient?.isReconnecting ?? false; }
	get pendingToolCallIds(): ReadonlySet<string> { return this.activeClient?.pendingToolCallIds ?? new Set(); }
	get toolCallTimings(): Readonly<ToolCallTimings> { return this.activeClient?.toolCallTimings ?? {}; }
	get steeringQueue(): readonly string[] { return this.activeClient?.steeringQueue ?? []; }
	get extensionStatuses(): ReadonlyMap<string, string> { return this.activeClient?.extensionStatuses ?? new Map(); }
	get cwd(): string | undefined { return this.activeClient?.cwd; }
	get activeBackendId(): string { return this.activeId; }
	get supportsUploadedImagePrompt(): boolean { return this.activeClient?.supportsUploadedImagePrompt === true; }

	get workspaceBackends(): readonly WorkspaceBackendState[] {
		return [...this.contexts.values()].map((context) => ({
			...context.descriptor,
			protocolVersions: [...context.descriptor.protocolVersions],
			connected: context.client?.isConnected ?? false,
			reconnecting: context.client?.isReconnecting ?? false,
			...(context.error ? { error: context.error } : {}),
		}));
	}

	get optimisticSessions(): SessionInfoDTO[] {
		return [...this.contexts.entries()].flatMap(([backendId, context]) =>
			(context.client?.optimisticSessions ?? []).map((session) => ({ ...session, backendId })),
		);
	}

	get virtualSessionInfo(): SessionInfoDTO | undefined {
		const session = this.activeClient?.virtualSessionInfo;
		return session ? { ...session, backendId: this.activeId } : undefined;
	}

	async connect(endpoint: string): Promise<void> {
		this.endpoint = endpoint;
		const candidates = [...this.contexts.values()].filter((context) => context.descriptor.online && this.isCompatible(context.descriptor));
		if (candidates.length === 0) {
			this.emitWorkspaceChange();
			throw new Error("All authorized backends are offline");
		}
		const attempts = candidates.map(async (context) => {
			const client = this.ensureClient(context);
			try {
				await client.connect(endpoint);
				context.error = undefined;
				await this.refreshContextSessions(context);
				return context;
			} catch (error) {
				context.error = errorMessage(error);
				this.emitWorkspaceChange();
				throw error;
			}
		});
		let firstConnected: BackendContext;
		try {
			firstConnected = await Promise.any(attempts);
		} catch {
			this.emitWorkspaceChange();
			throw new Error("Could not connect to any authorized backend");
		}
		this.connectedOnce = true;
		if (!this.activeClient?.isConnected) this.setActiveBackend(firstConnected.descriptor.backendId);
		this.emitWorkspaceChange();
		// Remaining reachable hosts continue connecting in the background. Their
		// catalog/status events update the sidebar without blocking first paint.
		void Promise.allSettled(attempts);
	}

	disconnect(): void {
		for (const context of this.contexts.values()) context.client?.disconnect();
	}

	onConnectionChange(fn: (connected: boolean) => void): () => void {
		return addListener(this.connectionListeners, fn);
	}
	onExtensionStatusChange(fn: () => void): () => void {
		return addListener(this.extensionStatusListeners, fn);
	}
	onGlobalStatusChange(fn: () => void): () => void {
		return addListener(this.globalStatusListeners, fn);
	}
	onSteeringQueueChange(fn: () => void): () => void {
		return addListener(this.steeringQueueListeners, fn);
	}
	onSessionChange(fn: () => void): () => void {
		return addListener(this.sessionListeners, fn);
	}
	onContentChange(fn: () => void): () => void {
		return addListener(this.contentListeners, fn);
	}
	onStatusChange(fn: () => void): () => void {
		return addListener(this.statusListeners, fn);
	}
	onSessionsChanged(fn: (file: string) => void): () => void {
		return addListener(this.sessionsChangedListeners, fn);
	}
	onPiInstallRequired(fn: (info: PiInstallRequiredInfo) => void): () => void {
		return addListener(this.piInstallRequiredListeners, fn);
	}
	onWorkspaceChange(fn: () => void): () => void {
		return addListener(this.workspaceListeners, fn);
	}

	getSessionStatus(sessionPath: string, backendId = this.activeId): "running" | "done" | undefined {
		return this.contexts.get(backendId)?.client?.getSessionStatus(sessionPath);
	}

	reportError(error: unknown, prefix?: string): void { this.requireActiveClient().reportError(error, prefix); }
	fetchAvailableModels(): Promise<any[]> { return this.requireActiveClient().fetchAvailableModels(); }
	installPi(): Promise<void> { return this.requireActiveClient().installPi(); }
	async loadDefaultModel(): Promise<void> {
		await this.requireActiveClient().loadDefaultModel();
		this.requireContext(this.activeId).initialized = true;
	}
	setCwd(cwd: string): void { this.requireActiveClient().setCwd(cwd); }
	prompt(input: string | AgentMessage | AgentMessage[], images?: WireImage[]): Promise<void> { return this.requireActiveClient().prompt(input, images); }
	fetchCommands(): Promise<SlashCommandInfo[]> { return this.requireActiveClient().fetchCommands(); }
	abort(): void { this.requireActiveClient().abort(); }
	hardKill(): void { this.requireActiveClient().hardKill(); }
	steer(message: AgentMessage): void { this.requireActiveClient().steer(message); }
	removeSteering(index: number): void { this.requireActiveClient().removeSteering(index); }
	setModel(model: Model<any>): void { this.requireActiveClient().setModel(model); }
	setThinkingLevel(level: ThinkingLevelValue): void { this.requireActiveClient().setThinkingLevel(level); }
	getForkMessages(): Promise<Array<{ entryId: string; text: string }>> { return this.requireActiveClient().getForkMessages(); }
	fork(entryId: string): Promise<{ text: string; cancelled: boolean; newSessionPath: string | null }> { return this.requireActiveClient().fork(entryId); }
	forkAndPrompt(text: string, images?: WireImage[]): Promise<void> { return this.requireActiveClient().forkAndPrompt(text, images); }

	async switchSession(sessionPath: string, cwd?: string, backendId = this.activeId): Promise<void> {
		const context = await this.activateContext(backendId, false);
		await this.ensureConversationInitialized(context);
		await this.requireContextClient(context).switchSession(sessionPath, cwd);
	}

	async newSession(cwd?: string, backendId = this.activeId): Promise<void> {
		const context = await this.activateContext(backendId, false);
		await this.ensureConversationInitialized(context);
		await this.requireContextClient(context).newSession(cwd);
	}

	async activateBackend(backendId: string): Promise<void> {
		const context = await this.activateContext(backendId);
		await this.ensureConversationInitialized(context);
	}

	async removeBackend(backendId: string): Promise<void> {
		const context = this.requireContext(backendId);
		await this.manager.revokeBackend(backendId);
		for (const unsubscribe of context.unsubscribers) unsubscribe();
		context.client?.disconnect();
		this.contexts.delete(backendId);
		if (this.contexts.size === 0) {
			this.emitWorkspaceChange();
			return;
		}
		if (this.activeId === backendId) {
			const next = [...this.contexts.values()].find((candidate) => candidate.client?.isConnected)
				?? [...this.contexts.values()].find((candidate) => candidate.descriptor.online)
				?? [...this.contexts.values()][0];
			this.setActiveBackend(next.descriptor.backendId);
		}
		this.emitWorkspaceChange();
	}

	getConnectionDiagnostics(): Promise<ConnectionDiagnostics | undefined> {
		return this.requireActiveClient().getConnectionDiagnostics?.() ?? Promise.resolve(undefined);
	}

	getBackendConnectionDiagnostics(backendId: string): Promise<ConnectionDiagnostics | undefined> {
		const context = this.requireContext(backendId);
		return this.ensureClient(context).getConnectionDiagnostics?.() ?? Promise.resolve(undefined);
	}

	async listSessions(): Promise<SessionInfoDTO[]> {
		return [...this.contexts.entries()].flatMap(([backendId, context]) =>
			context.sessions.map((session) => ({ ...session, backendId })),
		);
	}

	async deleteSession(sessionPath: string, backendId = this.activeId): Promise<void> {
		const context = this.requireContext(backendId);
		const client = this.ensureClient(context);
		if (!client.isConnected) await this.connectContext(context);
		await client.deleteSession(sessionPath);
		context.sessions = context.sessions.filter((session) => session.path !== sessionPath);
		this.emitSessionsChanged(backendId, "");
	}

	async browseDirectory(path: string, backendId = this.activeId): Promise<DirectoryListing> {
		return this.connectedClient(backendId).then((client) => client.browseDirectory(path));
	}

	async createDirectory(parentPath: string, name: string, backendId = this.activeId): Promise<DirectoryEntry> {
		return this.connectedClient(backendId).then((client) => client.createDirectory(parentPath, name));
	}

	listForkMessages(sessionPath: string): Promise<Array<{ entryId: string; text: string }>> { return this.requireActiveClient().listForkMessages(sessionPath); }
	getRawSession(sessionPath: string): Promise<string> { return this.requireActiveClient().getRawSession(sessionPath); }
	getFileContent(sessionPath: string, path: string): Promise<FileContentResponse> { return this.requireActiveClient().getFileContent(sessionPath, path); }
	createFileUpload(metadata: FileUploadMetadata): Promise<FileUploadSession> { return this.requireActiveClient().createFileUpload(metadata); }
	appendFileUpload(chunk: FileUploadChunk): Promise<FileUploadChunkResponse> { return this.requireActiveClient().appendFileUpload(chunk); }
	completeFileUpload(uploadId: string): Promise<FileUploadResponse> { return this.requireActiveClient().completeFileUpload(uploadId); }
	getLocalSettings(): Promise<LocalSettingsReadResponse> { return this.requireActiveClient().getLocalSettings(); }
	validateLocalSettings(content: string): Promise<LocalSettingsValidationResponse> { return this.requireActiveClient().validateLocalSettings(content); }
	patchLocalSettings(patch: Record<string, unknown>): Promise<LocalSettingsValidationResponse> { return this.requireActiveClient().patchLocalSettings(patch); }
	saveLocalSettings(content: string): Promise<LocalSettingsValidationResponse> { return this.requireActiveClient().saveLocalSettings(content); }
	getUpdates(): Promise<UpdateSnapshot> { return this.requireActiveClient().getUpdates(); }
	runUpdate(target: UpdateTarget): Promise<UpdateRunResponse> { return this.requireActiveClient().runUpdate(target); }
	getCapabilities() { return this.requireActiveClient().getCapabilities?.() ?? Promise.reject(new Error("Backend capabilities are unavailable")); }

	private get activeClient(): BackendClient | undefined {
		return this.contexts.get(this.activeId)?.client;
	}

	private chooseInitialBackend(requested?: string): string {
		const compatible = [...this.contexts.values()].filter((context) => this.isCompatible(context.descriptor));
		if (compatible.length === 0) throw new Error(`No authorized backend supports semantic protocol v${BACKEND_PROTOCOL_VERSION}`);
		if (requested && compatible.some((context) => context.descriptor.backendId === requested)) return requested;
		return compatible.find((context) => context.descriptor.online)?.descriptor.backendId
			?? compatible[0].descriptor.backendId;
	}

	private isCompatible(descriptor: AuthorizedBackendDescriptor): boolean {
		return descriptor.protocolVersions.includes(BACKEND_PROTOCOL_VERSION);
	}

	private requireContext(backendId: string): BackendContext {
		const context = this.contexts.get(backendId);
		if (!context) throw new Error("This browser is not authorized for the requested backend");
		return context;
	}

	private requireActiveClient(): BackendClient {
		const client = this.activeClient;
		if (!client) throw new Error("No active backend is available");
		return client;
	}

	private requireContextClient(context: BackendContext): BackendClient {
		return context.client ?? this.ensureClient(context);
	}

	private ensureClient(context: BackendContext): BackendClient {
		if (!this.isCompatible(context.descriptor)) throw new Error(context.error || "Backend update required");
		if (context.client) return context.client;
		const backendId = context.descriptor.backendId;
		const client = this.manager.getClient(backendId);
		context.client = client;
		context.unsubscribers.push(
			client.onConnectionChange((connected) => {
				context.error = connected ? undefined : context.error;
				if (connected && this.connectedOnce) void this.refreshContextSessions(context);
				this.emitWorkspaceChange();
				if (this.activeId === backendId) this.emit(this.connectionListeners, connected);
			}),
			client.onExtensionStatusChange(() => {
				if (this.activeId === backendId) this.emit(this.extensionStatusListeners);
			}),
			client.onGlobalStatusChange(() => {
				this.emit(this.globalStatusListeners);
				this.emitWorkspaceChange();
			}),
			client.onSteeringQueueChange(() => {
				if (this.activeId === backendId) this.emit(this.steeringQueueListeners);
			}),
			client.onSessionChange(() => {
				void this.refreshContextSessions(context);
				if (this.activeId === backendId) this.emit(this.sessionListeners);
			}),
			client.onContentChange(() => {
				if (this.activeId === backendId) this.emit(this.contentListeners);
			}),
			client.onStatusChange(() => {
				if (this.activeId === backendId) this.emit(this.statusListeners);
			}),
			client.onSessionsChanged((file) => {
				void this.refreshContextSessions(context).finally(() => this.emitSessionsChanged(backendId, file));
			}),
			client.onPiInstallRequired((info) => {
				if (this.activeId === backendId) this.emit(this.piInstallRequiredListeners, info);
			}),
		);
		return client;
	}

	private async activateContext(backendId: string, restoreSubscription = true): Promise<BackendContext> {
		const context = this.requireContext(backendId);
		const client = this.ensureClient(context);
		if (!client.isConnected) await this.connectContext(context);
		if (this.activeId !== backendId) {
			await this.activeClient?.setSessionSubscriptionActive?.(false);
			this.setActiveBackend(backendId);
			if (restoreSubscription) await client.setSessionSubscriptionActive?.(true);
		}
		return context;
	}

	private async connectContext(context: BackendContext): Promise<void> {
		const client = this.ensureClient(context);
		try {
			await client.connect(this.endpoint);
			context.error = undefined;
			await this.refreshContextSessions(context);
		} catch (error) {
			context.error = errorMessage(error);
			this.emitWorkspaceChange();
			throw error;
		}
	}

	private async connectedClient(backendId: string): Promise<BackendClient> {
		const context = this.requireContext(backendId);
		const client = this.ensureClient(context);
		if (!client.isConnected) await this.connectContext(context);
		return client;
	}

	private async ensureConversationInitialized(context: BackendContext): Promise<void> {
		if (context.initialized) return;
		if (context.initializing) return context.initializing;
		const client = this.requireContextClient(context);
		context.initializing = (async () => {
			try {
				await client.fetchAvailableModels();
			} catch {
				// Compact session model metadata remains a valid fallback.
			}
			await client.loadDefaultModel();
			context.initialized = true;
		})().finally(() => { context.initializing = undefined; });
		return context.initializing;
	}

	private async refreshContextSessions(context: BackendContext): Promise<void> {
		const client = context.client;
		if (!client?.isConnected) return;
		try {
			context.sessions = await client.listSessions();
			context.error = undefined;
			this.emitWorkspaceChange();
		} catch (error) {
			context.error = errorMessage(error);
			this.emitWorkspaceChange();
		}
	}

	private setActiveBackend(backendId: string): void {
		this.activeId = backendId;
		if (this.connectedOnce && window.location.pathname.startsWith("/backend/")) {
			window.history.replaceState(null, "", "/");
		}
		this.emitWorkspaceChange();
		this.emit(this.connectionListeners, this.isConnected);
		this.emit(this.sessionListeners);
		this.emit(this.contentListeners);
		this.emit(this.statusListeners);
		this.emit(this.extensionStatusListeners);
		this.emit(this.steeringQueueListeners);
		this.emit(this.sessionsChangedListeners, "__local_settings__");
	}

	private emitSessionsChanged(_backendId: string, file: string): void {
		this.emit(this.sessionsChangedListeners, file);
		this.emitWorkspaceChange();
	}

	private emitWorkspaceChange(): void {
		this.emit(this.workspaceListeners);
	}

	private emit<T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T): void {
		for (const listener of listeners) listener(...args);
	}
}

function addListener<T extends unknown[]>(listeners: Set<(...args: T) => void>, listener: (...args: T) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

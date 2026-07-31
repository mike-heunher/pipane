import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SyncOp } from "./jsonl-sync.js";
import type { CompactModelRef, ThinkingLevelValue } from "./thinking-levels.js";
import type { ToolCallTimings } from "./tool-runtime.js";

/** Increment when a breaking WebSocket wire change is introduced. */
export const WS_PROTOCOL_VERSION = 1 as const;
export const MAX_KNOWN_SESSION_MESSAGE_HASHES = 4_096;

export type SessionRuntimeStatus = "running" | "done";
export type SessionRuntimeStatuses = Record<string, SessionRuntimeStatus>;
export type ExtensionStatuses = Record<string, string>;
export type ProviderUsageStatuses = Record<string, string>;

export interface WireModel extends Record<string, unknown> {
	provider: string;
	id?: string;
	modelId?: string;
}

export interface InlineWireImage {
	type: "image";
	data: string;
	mimeType: string;
	uploadedPath?: never;
}

export interface UploadedWireImage {
	type: "image";
	uploadedPath: string;
	mimeType: string;
	data?: never;
}

export type WireImage = InlineWireImage | UploadedWireImage;

export interface SlashCommandInfo extends Record<string, unknown> {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	/** Current Pi versions expose provenance here; legacy fields remain accepted. */
	sourceInfo?: Record<string, unknown>;
	location?: string;
	path?: string;
}

export interface SessionStats {
	sessionFile: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

interface CommandEnvelope {
	protocolVersion: typeof WS_PROTOCOL_VERSION;
	id: string;
}

interface SessionCommand {
	sessionPath: string;
}

interface IdempotentCommand {
	/** Stable browser-generated identity retained across carrier reconnects. */
	operationId?: string;
}

export type ClientCommand = CommandEnvelope & (
	| { type: "install_pi" }
	| ({
		type: "subscribe_session";
		/** Exact authoritative state previously cached by this browser. */
		cachedStateHash?: string;
		/** Content hashes for cached materialized display messages. */
		knownMessageHashes?: string[];
	} & SessionCommand)
	| ({
		type: "prompt";
		message: string;
		cwd?: string;
		model: CompactModelRef;
		thinkingLevel?: ThinkingLevelValue;
		controlRevision?: number;
		images?: WireImage[];
	} & SessionCommand & IdempotentCommand)
	| ({ type: "steer"; message: string } & SessionCommand & IdempotentCommand)
	| ({ type: "remove_steering"; index: number } & SessionCommand)
	| ({ type: "abort" } & SessionCommand)
	| ({ type: "hard_kill" } & SessionCommand)
	| ({ type: "compact"; customInstructions?: string } & SessionCommand)
	| { type: "get_available_models" }
	| { type: "get_default_model" }
	| { type: "get_session_statuses" }
	| ({ type: "get_session_stats" } & SessionCommand)
	| ({ type: "fork"; entryId: string } & SessionCommand)
	| ({
		type: "fork_prompt";
		message: string;
		model: CompactModelRef;
		thinkingLevel?: ThinkingLevelValue;
		controlRevision?: number;
		images?: WireImage[];
	} & SessionCommand & IdempotentCommand)
	| ({ type: "set_session_name"; name: string } & SessionCommand)
	| { type: "get_commands"; sessionPath?: string; cwd?: string }
	| { type: "reload_processes" }
);

export type ClientCommandType = ClientCommand["type"];
export type ClientCommandPayload = ClientCommand extends infer Command
	? Command extends ClientCommand
		? Omit<Command, "protocolVersion" | "id">
		: never
	: never;

export interface CommandResponseDataMap {
	install_pi: Record<string, never>;
	subscribe_session: Record<string, never>;
	prompt: { newSessionPath: string };
	steer: Record<string, never>;
	remove_steering: Record<string, never>;
	abort: Record<string, never>;
	hard_kill: { killed: boolean; reason?: "signal_failed" | "not_attached" };
	compact: Record<string, unknown>;
	get_available_models: { models: WireModel[] };
	get_default_model: { model: WireModel | null; thinkingLevel: ThinkingLevelValue };
	get_session_statuses: { statuses: SessionRuntimeStatuses };
	get_session_stats: SessionStats;
	fork: { text: string; cancelled: boolean; newSessionPath: string | null };
	fork_prompt: { newSessionPath: string };
	set_session_name: Record<string, never>;
	get_commands: { commands: SlashCommandInfo[] };
	reload_processes: { killed: number; draining: number };
}

export type CommandResponseData<Type extends ClientCommandType> = CommandResponseDataMap[Type];

interface ServerEnvelope {
	protocolVersion: typeof WS_PROTOCOL_VERSION;
}

export type SuccessResponseMessage = {
	[Type in ClientCommandType]: ServerEnvelope & {
		type: "response";
		id: string;
		command: Type;
		success: true;
		data: CommandResponseData<Type>;
	};
}[ClientCommandType];

export type ProtocolErrorCode =
	| "invalid_json"
	| "invalid_message"
	| "unsupported_version"
	| "unknown_command"
	| "unknown_message"
	| "command_failed";

export type ErrorResponseMessage = ServerEnvelope & {
	type: "response";
	id: string | null;
	command: string;
	success: false;
	code: ProtocolErrorCode;
	error: string;
};

export type ResponseMessage = SuccessResponseMessage | ErrorResponseMessage;

export interface WireSessionState {
	messages: AgentMessage[];
	isStreaming: boolean;
	pendingToolCalls: string[];
	toolCallTimings: ToolCallTimings;
	model: CompactModelRef | null;
	thinkingLevel: ThinkingLevelValue;
	steeringQueue: string[];
	error?: string;
}

export type WireSessionStateMetadata = Omit<WireSessionState, "messages">;

export interface ContentAddressedMessage {
	hash: string;
	message: AgentMessage;
}

export type InitialSessionSyncOp =
	| {
		op: "content";
		hash: string;
		/** Authoritative display order; duplicate hashes are allowed. */
		messageHashes: string[];
		/** Bodies absent from the browser's declared cache. */
		messages: ContentAddressedMessage[];
		state: WireSessionStateMetadata;
	}
	| {
		op: "not_modified";
		hash: string;
	};

export type SessionSyncMessage = ServerEnvelope & {
	type: "session_sync";
	sessionPath: string;
	/** Monotonic revision of the authoritative state for this session. */
	revision: number;
} & (SyncOp | InitialSessionSyncOp);

export type InitMessage = ServerEnvelope & {
	type: "init";
	sessionStatuses: SessionRuntimeStatuses;
	steeringQueues: Record<string, string[]>;
	providerUsageStatuses: ProviderUsageStatuses;
};

export type PiInstallRequiredMessage = ServerEnvelope & {
	type: "pi_install_required";
	command: string;
	installable: boolean;
	installing: boolean;
	message: string;
};

export type SessionStatusChangeMessage = ServerEnvelope & {
	type: "session_status_change";
	sessionPath: string;
	status: SessionRuntimeStatus;
};

export type ProviderUsageMessage = ServerEnvelope & {
	type: "provider_usage";
	statuses: ProviderUsageStatuses;
};

export type ExtensionStatusMessage = ServerEnvelope & {
	type: "extension_status";
	sessionPath: string;
	statuses: ExtensionStatuses;
};

export type ControlStateMessage = ServerEnvelope & {
	type: "control_state";
	sessionPath: string;
	controlRevision?: number;
	model: WireModel;
	thinkingLevel: ThinkingLevelValue;
};

export type SessionAttachedMessage = ServerEnvelope & {
	type: "session_attached";
	sessionPath: string;
	cwd?: string;
	firstMessage?: string;
};

export type SessionsChangedMessage = ServerEnvelope & {
	type: "sessions_changed";
	file: string;
};

export type ServerMessage =
	| ResponseMessage
	| InitMessage
	| PiInstallRequiredMessage
	| SessionStatusChangeMessage
	| ProviderUsageMessage
	| ExtensionStatusMessage
	| SessionSyncMessage
	| ControlStateMessage
	| SessionAttachedMessage
	| SessionsChangedMessage;

export type ServerMessagePayload = ServerMessage extends infer Message
	? Message extends ServerMessage
		? Omit<Message, "protocolVersion">
		: never
	: never;

export interface ProtocolDecodeError {
	code: Exclude<ProtocolErrorCode, "command_failed">;
	message: string;
	requestId: string | null;
	command: string;
}

export type ProtocolDecodeResult<Value> =
	| { ok: true; value: Value }
	| { ok: false; error: ProtocolDecodeError };

class ValidationFailure extends Error {
	readonly code: ProtocolDecodeError["code"];

	constructor(code: ProtocolDecodeError["code"], path: string, message: string) {
		super(`${path}: ${message}`);
		this.code = code;
	}
}

function fail(
	path: string,
	message: string,
	code: ProtocolDecodeError["code"] = "invalid_message",
): never {
	throw new ValidationFailure(code, path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) fail(path, "expected an object");
	return value;
}

function string(value: unknown, path: string, allowEmpty = true): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		fail(path, allowEmpty ? "expected a string" : "expected a non-empty string");
	}
	return value;
}

function optionalString(value: unknown, path: string): string | undefined {
	return value === undefined ? undefined : string(value, path);
}

function optionalOperationId(value: unknown, path: string): void {
	if (value === undefined) return;
	const operationId = string(value, path, false);
	if (operationId.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(operationId)) {
		fail(path, "expected at most 128 URL-safe characters");
	}
}

function contentHash(value: unknown, path: string): string {
	const hash = string(value, path, false);
	if (!/^[a-f0-9]{64}$/u.test(hash)) fail(path, "expected a lowercase SHA-256 hash");
	return hash;
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "expected a boolean");
	return value;
}

function integer(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		fail(path, "expected a non-negative safe integer");
	}
	return value as number;
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
	return value;
}

function array(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) fail(path, "expected an array");
	return value;
}

function stringArray(value: unknown, path: string): string[] {
	return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}

function stringRecord(value: unknown, path: string): Record<string, string> {
	const source = record(value, path);
	for (const [key, item] of Object.entries(source)) string(item, `${path}.${key}`);
	return source as Record<string, string>;
}

function statusRecord(value: unknown, path: string): SessionRuntimeStatuses {
	const source = record(value, path);
	for (const [key, item] of Object.entries(source)) {
		if (item !== "running" && item !== "done") fail(`${path}.${key}`, "expected 'running' or 'done'");
	}
	return source as SessionRuntimeStatuses;
}

function queuesRecord(value: unknown, path: string): Record<string, string[]> {
	const source = record(value, path);
	for (const [key, item] of Object.entries(source)) stringArray(item, `${path}.${key}`);
	return source as Record<string, string[]>;
}

function thinkingLevel(value: unknown, path: string): ThinkingLevelValue {
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))) {
		fail(path, "expected a supported thinking level");
	}
	return value as ThinkingLevelValue;
}

function compactModel(value: unknown, path: string): CompactModelRef {
	const model = record(value, path);
	string(model.provider, `${path}.provider`, false);
	string(model.modelId, `${path}.modelId`, false);
	return model as unknown as CompactModelRef;
}

function wireModel(value: unknown, path: string): WireModel {
	const model = record(value, path);
	string(model.provider, `${path}.provider`, false);
	const id = optionalString(model.id, `${path}.id`);
	const modelId = optionalString(model.modelId, `${path}.modelId`);
	if (!id && !modelId) fail(path, "expected id or modelId");
	return model as WireModel;
}

function images(value: unknown, path: string): WireImage[] {
	return array(value, path).map((item, index) => {
		const imagePath = `${path}[${index}]`;
		const image = record(item, imagePath);
		if (image.type !== "image") fail(`${imagePath}.type`, "expected 'image'");
		string(image.mimeType, `${imagePath}.mimeType`, false);
		const hasData = image.data !== undefined;
		const hasUploadedPath = image.uploadedPath !== undefined;
		if (hasData === hasUploadedPath) fail(imagePath, "expected exactly one of data or uploadedPath");
		if (hasData) string(image.data, `${imagePath}.data`);
		else string(image.uploadedPath, `${imagePath}.uploadedPath`, false);
		return image as unknown as WireImage;
	});
}

function optionalCommandFields(command: Record<string, unknown>, path: string): void {
	if (command.thinkingLevel !== undefined) thinkingLevel(command.thinkingLevel, `${path}.thinkingLevel`);
	if (command.controlRevision !== undefined) integer(command.controlRevision, `${path}.controlRevision`);
	if (command.images !== undefined) images(command.images, `${path}.images`);
}

function validateVersion(message: Record<string, unknown>, path: string): void {
	if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
		const actual = message.protocolVersion === undefined ? "missing" : JSON.stringify(message.protocolVersion);
		fail(
			`${path}.protocolVersion`,
			`unsupported protocol version ${actual}; expected ${WS_PROTOCOL_VERSION}`,
			"unsupported_version",
		);
	}
}

function decodeJson(raw: string): ProtocolDecodeResult<unknown> {
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "invalid_json",
				message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				requestId: null,
				command: "parse",
			},
		};
	}
}

function decodeFailure(value: unknown, failure: unknown, fallbackCommand: string): ProtocolDecodeResult<never> {
	const source = isRecord(value) ? value : undefined;
	const requestId = typeof source?.id === "string" ? source.id : null;
	const command = typeof source?.type === "string" ? source.type : fallbackCommand;
	const validation = failure instanceof ValidationFailure
		? failure
		: new ValidationFailure("invalid_message", "$", failure instanceof Error ? failure.message : String(failure));
	return {
		ok: false,
		error: {
			code: validation.code,
			message: validation.message,
			requestId,
			command,
		},
	};
}

export function decodeClientCommand(raw: string): ProtocolDecodeResult<ClientCommand> {
	const parsed = decodeJson(raw);
	if (!parsed.ok) return parsed;
	const value = parsed.value;
	try {
		const command = record(value, "$command");
		validateVersion(command, "$command");
		string(command.id, "$command.id", false);
		const type = string(command.type, "$command.type", false);
		const sessionPath = () => string(command.sessionPath, "$command.sessionPath");

		switch (type) {
			case "install_pi":
			case "get_available_models":
			case "get_default_model":
			case "get_session_statuses":
			case "reload_processes":
				break;
			case "get_commands":
				optionalString(command.sessionPath, "$command.sessionPath");
				optionalString(command.cwd, "$command.cwd");
				break;
			case "subscribe_session":
				sessionPath();
				if (command.cachedStateHash !== undefined) contentHash(command.cachedStateHash, "$command.cachedStateHash");
				if (command.knownMessageHashes !== undefined) {
					const hashes = array(command.knownMessageHashes, "$command.knownMessageHashes")
						.map((hash, index) => contentHash(hash, `$command.knownMessageHashes[${index}]`));
					if (hashes.length > MAX_KNOWN_SESSION_MESSAGE_HASHES) {
						fail("$command.knownMessageHashes", `expected at most ${MAX_KNOWN_SESSION_MESSAGE_HASHES} hashes`);
					}
				}
				break;
			case "abort":
			case "hard_kill":
			case "get_session_stats":
				sessionPath();
				break;
			case "prompt":
				sessionPath();
				string(command.message, "$command.message");
				optionalString(command.cwd, "$command.cwd");
				compactModel(command.model, "$command.model");
				optionalCommandFields(command, "$command");
				optionalOperationId(command.operationId, "$command.operationId");
				break;
			case "steer":
				sessionPath();
				string(command.message, "$command.message");
				optionalOperationId(command.operationId, "$command.operationId");
				break;
			case "remove_steering":
				sessionPath();
				integer(command.index, "$command.index");
				break;
			case "compact":
				sessionPath();
				optionalString(command.customInstructions, "$command.customInstructions");
				break;
			case "fork":
				sessionPath();
				string(command.entryId, "$command.entryId", false);
				break;
			case "fork_prompt":
				sessionPath();
				string(command.message, "$command.message");
				compactModel(command.model, "$command.model");
				optionalCommandFields(command, "$command");
				optionalOperationId(command.operationId, "$command.operationId");
				break;
			case "set_session_name":
				sessionPath();
				string(command.name, "$command.name");
				break;
			default:
				fail("$command.type", `unknown command '${type}'`, "unknown_command");
		}
		return { ok: true, value: command as unknown as ClientCommand };
	} catch (error) {
		return decodeFailure(value, error, "unknown");
	}
}

function validateSlashCommands(value: unknown, path: string): void {
	array(value, path).forEach((item, index) => {
		const command = record(item, `${path}[${index}]`);
		string(command.name, `${path}[${index}].name`, false);
		optionalString(command.description, `${path}[${index}].description`);
		if (!["extension", "prompt", "skill"].includes(String(command.source))) {
			fail(`${path}[${index}].source`, "expected extension, prompt, or skill");
		}
		if (command.sourceInfo !== undefined) record(command.sourceInfo, `${path}[${index}].sourceInfo`);
		optionalString(command.location, `${path}[${index}].location`);
		optionalString(command.path, `${path}[${index}].path`);
	});
}

function validateSessionStats(value: unknown, path: string): void {
	const stats = record(value, path);
	string(stats.sessionFile, `${path}.sessionFile`, false);
	string(stats.sessionId, `${path}.sessionId`, false);
	for (const field of ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages"] as const) {
		integer(stats[field], `${path}.${field}`);
	}
	const tokens = record(stats.tokens, `${path}.tokens`);
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		integer(tokens[field], `${path}.tokens.${field}`);
	}
	if (finiteNumber(stats.cost, `${path}.cost`) < 0) fail(`${path}.cost`, "expected a non-negative number");
	if (stats.contextUsage !== undefined) {
		const context = record(stats.contextUsage, `${path}.contextUsage`);
		if (context.tokens !== null) integer(context.tokens, `${path}.contextUsage.tokens`);
		integer(context.contextWindow, `${path}.contextUsage.contextWindow`);
		if (context.percent !== null && finiteNumber(context.percent, `${path}.contextUsage.percent`) < 0) {
			fail(`${path}.contextUsage.percent`, "expected a non-negative number or null");
		}
	}
}

function validateSuccessData(command: ClientCommandType, value: unknown, path: string): void {
	const data = record(value, path);
	switch (command) {
		case "install_pi":
		case "subscribe_session":
		case "steer":
		case "remove_steering":
		case "abort":
		case "set_session_name":
			break;
		case "prompt":
		case "fork_prompt":
			string(data.newSessionPath, `${path}.newSessionPath`, false);
			break;
		case "hard_kill":
			boolean(data.killed, `${path}.killed`);
			if (data.reason !== undefined && data.reason !== "signal_failed" && data.reason !== "not_attached") {
				fail(`${path}.reason`, "expected signal_failed or not_attached");
			}
			break;
		case "compact":
			break;
		case "get_available_models":
			array(data.models, `${path}.models`).forEach((model, index) => wireModel(model, `${path}.models[${index}]`));
			break;
		case "get_default_model":
			if (data.model !== null) wireModel(data.model, `${path}.model`);
			thinkingLevel(data.thinkingLevel, `${path}.thinkingLevel`);
			break;
		case "get_session_statuses":
			statusRecord(data.statuses, `${path}.statuses`);
			break;
		case "get_session_stats":
			validateSessionStats(data, path);
			break;
		case "fork":
			string(data.text, `${path}.text`);
			boolean(data.cancelled, `${path}.cancelled`);
			if (data.newSessionPath !== null) string(data.newSessionPath, `${path}.newSessionPath`, false);
			break;
		case "get_commands":
			validateSlashCommands(data.commands, `${path}.commands`);
			break;
		case "reload_processes":
			integer(data.killed, `${path}.killed`);
			integer(data.draining, `${path}.draining`);
			break;
	}
}

const CLIENT_COMMAND_TYPES = new Set<ClientCommandType>([
	"install_pi",
	"subscribe_session",
	"prompt",
	"steer",
	"remove_steering",
	"abort",
	"hard_kill",
	"compact",
	"get_available_models",
	"get_default_model",
	"get_session_statuses",
	"get_session_stats",
	"fork",
	"fork_prompt",
	"set_session_name",
	"get_commands",
	"reload_processes",
]);

function clientCommandType(value: unknown, path: string): ClientCommandType {
	const type = string(value, path, false);
	if (!CLIENT_COMMAND_TYPES.has(type as ClientCommandType)) fail(path, `unknown response command '${type}'`, "unknown_message");
	return type as ClientCommandType;
}

function validateSessionStateMetadata(value: unknown, path: string): void {
	const state = record(value, path);
	boolean(state.isStreaming, `${path}.isStreaming`);
	stringArray(state.pendingToolCalls, `${path}.pendingToolCalls`);
	const timings = record(state.toolCallTimings, `${path}.toolCallTimings`);
	for (const [toolCallId, value] of Object.entries(timings)) {
		const timing = record(value, `${path}.toolCallTimings.${toolCallId}`);
		finiteNumber(timing.startedAt, `${path}.toolCallTimings.${toolCallId}.startedAt`);
		if (timing.completedAt !== undefined) finiteNumber(timing.completedAt, `${path}.toolCallTimings.${toolCallId}.completedAt`);
	}
	if (state.model !== null) compactModel(state.model, `${path}.model`);
	thinkingLevel(state.thinkingLevel, `${path}.thinkingLevel`);
	stringArray(state.steeringQueue, `${path}.steeringQueue`);
	optionalString(state.error, `${path}.error`);
}

function validatePatches(value: unknown, path: string): void {
	array(value, path).forEach((item, index) => {
		const patch = record(item, `${path}[${index}]`);
		integer(patch.offset, `${path}[${index}].offset`);
		integer(patch.deleteCount, `${path}[${index}].deleteCount`);
		string(patch.insert, `${path}[${index}].insert`);
	});
}

export function decodeServerMessage(raw: string): ProtocolDecodeResult<ServerMessage> {
	const parsed = decodeJson(raw);
	if (!parsed.ok) return parsed;
	const value = parsed.value;
	try {
		const message = record(value, "$message");
		validateVersion(message, "$message");
		const type = string(message.type, "$message.type", false);
		switch (type) {
			case "response": {
				const success = boolean(message.success, "$message.success");
				if (success) {
					string(message.id, "$message.id", false);
					const command = clientCommandType(message.command, "$message.command");
					validateSuccessData(command, message.data, "$message.data");
				} else {
					if (message.id !== null) string(message.id, "$message.id", false);
					string(message.command, "$message.command", false);
					string(message.error, "$message.error", false);
					if (!["invalid_json", "invalid_message", "unsupported_version", "unknown_command", "unknown_message", "command_failed"].includes(String(message.code))) {
						fail("$message.code", "expected a protocol error code");
					}
				}
				break;
			}
			case "init":
				statusRecord(message.sessionStatuses, "$message.sessionStatuses");
				queuesRecord(message.steeringQueues, "$message.steeringQueues");
				stringRecord(message.providerUsageStatuses, "$message.providerUsageStatuses");
				break;
			case "pi_install_required":
				string(message.command, "$message.command", false);
				boolean(message.installable, "$message.installable");
				boolean(message.installing, "$message.installing");
				string(message.message, "$message.message", false);
				break;
			case "session_status_change":
				string(message.sessionPath, "$message.sessionPath", false);
				if (message.status !== "running" && message.status !== "done") fail("$message.status", "expected running or done");
				break;
			case "provider_usage":
				stringRecord(message.statuses, "$message.statuses");
				break;
			case "extension_status":
				string(message.sessionPath, "$message.sessionPath", false);
				stringRecord(message.statuses, "$message.statuses");
				break;
			case "session_sync":
				string(message.sessionPath, "$message.sessionPath", false);
				integer(message.revision, "$message.revision");
				string(message.hash, "$message.hash", false);
				if (message.op === "full") {
					string(message.data, "$message.data");
				} else if (message.op === "delta") {
					string(message.baseHash, "$message.baseHash", false);
					validatePatches(message.patches, "$message.patches");
				} else if (message.op === "content") {
					array(message.messageHashes, "$message.messageHashes")
						.forEach((hash, index) => contentHash(hash, `$message.messageHashes[${index}]`));
					array(message.messages, "$message.messages").forEach((item, index) => {
						const body = record(item, `$message.messages[${index}]`);
						contentHash(body.hash, `$message.messages[${index}].hash`);
						const materialized = record(body.message, `$message.messages[${index}].message`);
						string(materialized.role, `$message.messages[${index}].message.role`, false);
					});
					validateSessionStateMetadata(message.state, "$message.state");
				} else if (message.op !== "not_modified") {
					fail("$message.op", "expected full, delta, content, or not_modified");
				}
				break;
			case "control_state":
				string(message.sessionPath, "$message.sessionPath", false);
				if (message.controlRevision !== undefined) integer(message.controlRevision, "$message.controlRevision");
				wireModel(message.model, "$message.model");
				thinkingLevel(message.thinkingLevel, "$message.thinkingLevel");
				break;
			case "session_attached":
				string(message.sessionPath, "$message.sessionPath", false);
				optionalString(message.cwd, "$message.cwd");
				optionalString(message.firstMessage, "$message.firstMessage");
				break;
			case "sessions_changed":
				string(message.file, "$message.file");
				break;
			default:
				fail("$message.type", `unknown server message '${type}'`, "unknown_message");
		}
		return { ok: true, value: message as unknown as ServerMessage };
	} catch (error) {
		return decodeFailure(value, error, "unknown");
	}
}

export function decodeSessionStateJson(raw: string): ProtocolDecodeResult<WireSessionState> {
	const parsed = decodeJson(raw);
	if (!parsed.ok) return parsed;
	const value = parsed.value;
	try {
		const state = record(value, "$session");
		array(state.messages, "$session.messages").forEach((item, index) => {
			const message = record(item, `$session.messages[${index}]`);
			string(message.role, `$session.messages[${index}].role`, false);
		});
		validateSessionStateMetadata(state, "$session");
		return { ok: true, value: state as unknown as WireSessionState };
	} catch (error) {
		return decodeFailure(value, error, "session_sync");
	}
}

export function encodeClientCommand(payload: ClientCommandPayload, id: string): string {
	return JSON.stringify({ protocolVersion: WS_PROTOCOL_VERSION, id, ...payload });
}

export function encodeServerMessage(payload: ServerMessagePayload): string {
	return JSON.stringify({ protocolVersion: WS_PROTOCOL_VERSION, ...payload });
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled protocol variant: ${JSON.stringify(value)}`);
}

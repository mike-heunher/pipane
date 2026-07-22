import { StringDecoder } from "node:string_decoder";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";

const SUPPORTED_COMMAND_TYPES = [
	"prompt",
	"steer",
	"abort",
	"new_session",
	"get_state",
	"set_model",
	"get_available_models",
	"set_thinking_level",
	"compact",
	"get_session_stats",
	"switch_session",
	"fork",
	"set_session_name",
	"get_commands",
] as const;

export type PiRpcCommandType = (typeof SUPPORTED_COMMAND_TYPES)[number];
export type PiRpcCommand = Extract<RpcCommand, { type: PiRpcCommandType }>;
export type PiRpcCommandPayload = PiRpcCommand extends infer Command
	? Command extends PiRpcCommand
		? Omit<Command, "id">
		: never
	: never;

export type PiRpcFailureResponse = Extract<RpcResponse, { success: false }>;
export type PiRpcSuccessResponse<Type extends PiRpcCommandType> =
	Type extends PiRpcCommandType
		? Extract<RpcResponse, { success: true; command: Type }>
		: never;
export type PiRpcResponse<Type extends PiRpcCommandType = PiRpcCommandType> =
	| PiRpcSuccessResponse<Type>
	| PiRpcFailureResponse;

export interface PiRpcExtensionErrorEvent {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

export type PiRpcEvent = AgentSessionEvent | RpcExtensionUIRequest | PiRpcExtensionErrorEvent;
export type PiRpcIncomingMessage = PiRpcResponse | PiRpcEvent;

export interface PiRpcDecodeError {
	message: string;
	line: string;
}

export type PiRpcDecodeResult =
	| { ok: true; value: PiRpcIncomingMessage }
	| { ok: false; error: PiRpcDecodeError };

class ValidationFailure extends Error {
	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
	}
}

function fail(path: string, message: string): never {
	throw new ValidationFailure(path, message);
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

function optionalString(value: unknown, path: string): void {
	if (value !== undefined) string(value, path);
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "expected a boolean");
	return value;
}

function integer(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, "expected a non-negative safe integer");
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

function stringArray(value: unknown, path: string): void {
	array(value, path).forEach((item, index) => string(item, `${path}[${index}]`));
}

function thinkingLevel(value: unknown, path: string): void {
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))) {
		fail(path, "expected a supported thinking level");
	}
}

function model(value: unknown, path: string): void {
	const source = record(value, path);
	string(source.provider, `${path}.provider`, false);
	string(source.id, `${path}.id`, false);
}

function agentMessage(value: unknown, path: string): void {
	const message = record(value, path);
	string(message.role, `${path}.role`, false);
}

function validateState(value: unknown, path: string): void {
	const state = record(value, path);
	if (state.model !== undefined && state.model !== null) model(state.model, `${path}.model`);
	thinkingLevel(state.thinkingLevel, `${path}.thinkingLevel`);
	boolean(state.isStreaming, `${path}.isStreaming`);
	boolean(state.isCompacting, `${path}.isCompacting`);
	if (state.steeringMode !== "all" && state.steeringMode !== "one-at-a-time") {
		fail(`${path}.steeringMode`, "expected all or one-at-a-time");
	}
	if (state.followUpMode !== "all" && state.followUpMode !== "one-at-a-time") {
		fail(`${path}.followUpMode`, "expected all or one-at-a-time");
	}
	optionalString(state.sessionFile, `${path}.sessionFile`);
	string(state.sessionId, `${path}.sessionId`);
	optionalString(state.sessionName, `${path}.sessionName`);
	boolean(state.autoCompactionEnabled, `${path}.autoCompactionEnabled`);
	integer(state.messageCount, `${path}.messageCount`);
	integer(state.pendingMessageCount, `${path}.pendingMessageCount`);
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
	});
}

function validateSessionStats(value: unknown, path: string): void {
	const stats = record(value, path);
	optionalString(stats.sessionFile, `${path}.sessionFile`);
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

const SUPPORTED_COMMAND_SET = new Set<string>(SUPPORTED_COMMAND_TYPES);

function commandType(value: unknown, path: string): PiRpcCommandType {
	const type = string(value, path, false);
	if (!SUPPORTED_COMMAND_SET.has(type)) fail(path, `unexpected command '${type}'`);
	return type as PiRpcCommandType;
}

function validateResponse(value: Record<string, unknown>): PiRpcResponse {
	string(value.id, "$rpc.id", false);
	const command = commandType(value.command, "$rpc.command");
	const success = boolean(value.success, "$rpc.success");
	if (!success) {
		string(value.error, "$rpc.error", false);
		return value as unknown as PiRpcFailureResponse;
	}

	switch (command) {
		case "prompt":
		case "steer":
		case "abort":
		case "set_thinking_level":
		case "set_session_name":
			break;
		case "new_session":
		case "switch_session": {
			const data = record(value.data, "$rpc.data");
			boolean(data.cancelled, "$rpc.data.cancelled");
			break;
		}
		case "get_state":
			validateState(value.data, "$rpc.data");
			break;
		case "set_model":
			model(value.data, "$rpc.data");
			break;
		case "get_available_models": {
			const data = record(value.data, "$rpc.data");
			array(data.models, "$rpc.data.models").forEach((item, index) => model(item, `$rpc.data.models[${index}]`));
			break;
		}
		case "compact":
			record(value.data, "$rpc.data");
			break;
		case "get_session_stats":
			validateSessionStats(value.data, "$rpc.data");
			break;
		case "fork": {
			const data = record(value.data, "$rpc.data");
			string(data.text, "$rpc.data.text");
			boolean(data.cancelled, "$rpc.data.cancelled");
			break;
		}
		case "get_commands": {
			const data = record(value.data, "$rpc.data");
			validateSlashCommands(data.commands, "$rpc.data.commands");
			break;
		}
	}
	return value as unknown as PiRpcResponse;
}

function validateExtensionUiRequest(value: Record<string, unknown>): RpcExtensionUIRequest {
	string(value.id, "$rpc.id", false);
	const method = string(value.method, "$rpc.method", false);
	switch (method) {
		case "select":
			string(value.title, "$rpc.title");
			stringArray(value.options, "$rpc.options");
			if (value.timeout !== undefined) integer(value.timeout, "$rpc.timeout");
			break;
		case "confirm":
			string(value.title, "$rpc.title");
			string(value.message, "$rpc.message");
			if (value.timeout !== undefined) integer(value.timeout, "$rpc.timeout");
			break;
		case "input":
			string(value.title, "$rpc.title");
			optionalString(value.placeholder, "$rpc.placeholder");
			if (value.timeout !== undefined) integer(value.timeout, "$rpc.timeout");
			break;
		case "editor":
			string(value.title, "$rpc.title");
			optionalString(value.prefill, "$rpc.prefill");
			break;
		case "notify":
			string(value.message, "$rpc.message");
			if (value.notifyType !== undefined && !["info", "warning", "error"].includes(String(value.notifyType))) {
				fail("$rpc.notifyType", "expected info, warning, or error");
			}
			break;
		case "setStatus":
			string(value.statusKey, "$rpc.statusKey", false);
			optionalString(value.statusText, "$rpc.statusText");
			break;
		case "setWidget":
			string(value.widgetKey, "$rpc.widgetKey", false);
			if (value.widgetLines !== undefined) stringArray(value.widgetLines, "$rpc.widgetLines");
			if (value.widgetPlacement !== undefined && value.widgetPlacement !== "aboveEditor" && value.widgetPlacement !== "belowEditor") {
				fail("$rpc.widgetPlacement", "expected aboveEditor or belowEditor");
			}
			break;
		case "setTitle":
			string(value.title, "$rpc.title");
			break;
		case "set_editor_text":
			string(value.text, "$rpc.text");
			break;
		default:
			fail("$rpc.method", `unknown extension UI method '${method}'`);
	}
	return value as unknown as RpcExtensionUIRequest;
}

function validateEvent(value: Record<string, unknown>, type: string): PiRpcEvent {
	switch (type) {
		case "agent_start":
		case "agent_settled":
		case "turn_start":
			break;
		case "agent_end":
			array(value.messages, "$rpc.messages").forEach((item, index) => agentMessage(item, `$rpc.messages[${index}]`));
			boolean(value.willRetry, "$rpc.willRetry");
			break;
		case "turn_end":
			agentMessage(value.message, "$rpc.message");
			array(value.toolResults, "$rpc.toolResults").forEach((item, index) => agentMessage(item, `$rpc.toolResults[${index}]`));
			break;
		case "message_start":
		case "message_end":
			agentMessage(value.message, "$rpc.message");
			break;
		case "message_update":
			agentMessage(value.message, "$rpc.message");
			record(value.assistantMessageEvent, "$rpc.assistantMessageEvent");
			break;
		case "tool_execution_start":
			string(value.toolCallId, "$rpc.toolCallId", false);
			string(value.toolName, "$rpc.toolName", false);
			record(value.args, "$rpc.args");
			break;
		case "tool_execution_update":
			string(value.toolCallId, "$rpc.toolCallId", false);
			string(value.toolName, "$rpc.toolName", false);
			record(value.args, "$rpc.args");
			record(value.partialResult, "$rpc.partialResult");
			break;
		case "tool_execution_end":
			string(value.toolCallId, "$rpc.toolCallId", false);
			string(value.toolName, "$rpc.toolName", false);
			record(value.result, "$rpc.result");
			boolean(value.isError, "$rpc.isError");
			break;
		case "queue_update":
			stringArray(value.steering, "$rpc.steering");
			stringArray(value.followUp, "$rpc.followUp");
			break;
		case "compaction_start":
			if (!["manual", "threshold", "overflow"].includes(String(value.reason))) fail("$rpc.reason", "expected a compaction reason");
			break;
		case "compaction_end":
			if (!["manual", "threshold", "overflow"].includes(String(value.reason))) fail("$rpc.reason", "expected a compaction reason");
			if (value.result !== undefined && value.result !== null) record(value.result, "$rpc.result");
			boolean(value.aborted, "$rpc.aborted");
			boolean(value.willRetry, "$rpc.willRetry");
			optionalString(value.errorMessage, "$rpc.errorMessage");
			break;
		case "auto_retry_start":
			integer(value.attempt, "$rpc.attempt");
			integer(value.maxAttempts, "$rpc.maxAttempts");
			integer(value.delayMs, "$rpc.delayMs");
			string(value.errorMessage, "$rpc.errorMessage");
			break;
		case "auto_retry_end":
			boolean(value.success, "$rpc.success");
			integer(value.attempt, "$rpc.attempt");
			optionalString(value.finalError, "$rpc.finalError");
			break;
		case "entry_appended":
			record(value.entry, "$rpc.entry");
			break;
		case "session_info_changed":
			optionalString(value.name, "$rpc.name");
			break;
		case "thinking_level_changed":
			thinkingLevel(value.level, "$rpc.level");
			break;
		case "extension_error":
			string(value.extensionPath, "$rpc.extensionPath");
			string(value.event, "$rpc.event");
			string(value.error, "$rpc.error");
			break;
		default:
			fail("$rpc.type", `unknown event '${type}'`);
	}
	return value as unknown as PiRpcEvent;
}

/** Validate one complete line emitted by Pi RPC before it reaches state mutation. */
export function decodePiRpcLine(line: string): PiRpcDecodeResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch (error) {
		return {
			ok: false,
			error: {
				message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				line,
			},
		};
	}

	try {
		const value = record(parsed, "$rpc");
		const type = string(value.type, "$rpc.type", false);
		if (type === "response") return { ok: true, value: validateResponse(value) };
		if (type === "extension_ui_request") return { ok: true, value: validateExtensionUiRequest(value) };
		return { ok: true, value: validateEvent(value, type) };
	} catch (error) {
		return {
			ok: false,
			error: {
				message: error instanceof Error ? error.message : String(error),
				line,
			},
		};
	}
}

/**
 * Pi RPC is strict JSONL: only LF delimits records. Node readline also splits on
 * U+2028/U+2029, so use this decoder for protocol-compliant framing.
 */
export function attachStrictJsonlReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const consume = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) onLine(line);
		}
	};
	const end = () => {
		buffer += decoder.end();
		if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		buffer = "";
	};
	stream.on("data", consume);
	stream.on("end", end);
	return () => {
		stream.removeListener("data", consume);
		stream.removeListener("end", end);
	};
}

/** Build a correlated command line after static command typing has succeeded. */
export function encodePiRpcCommand(command: PiRpcCommandPayload, id: string): string {
	return `${JSON.stringify({ ...command, id })}\n`;
}

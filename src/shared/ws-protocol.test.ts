import { describe, expect, it } from "vitest";
import {
	WS_PROTOCOL_VERSION,
	decodeClientCommand,
	decodeServerMessage,
	decodeSessionStateJson,
	encodeClientCommand,
	encodeServerMessage,
	type ClientCommandPayload,
	type ServerMessagePayload,
} from "./ws-protocol.js";

const envelope = { protocolVersion: WS_PROTOCOL_VERSION, id: "req-1" };
const model = { provider: "anthropic", modelId: "claude-sonnet" };
const sessionStats = {
	sessionFile: "/sessions/a.jsonl",
	sessionId: "session-a",
	userMessages: 2,
	assistantMessages: 2,
	toolCalls: 1,
	toolResults: 1,
	totalMessages: 6,
	tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, total: 180 },
	cost: 0.012,
	contextUsage: { tokens: 180, contextWindow: 200_000, percent: 0.09 },
};

const clientCommands = [
	{ type: "install_pi" },
	{ type: "subscribe_session", sessionPath: "/sessions/a.jsonl" },
	{ type: "prompt", sessionPath: "/sessions/a.jsonl", message: "hello", model, thinkingLevel: "high", controlRevision: 2 },
	{ type: "steer", sessionPath: "/sessions/a.jsonl", message: "continue" },
	{ type: "remove_steering", sessionPath: "/sessions/a.jsonl", index: 0 },
	{ type: "abort", sessionPath: "/sessions/a.jsonl" },
	{ type: "hard_kill", sessionPath: "/sessions/a.jsonl" },
	{ type: "compact", sessionPath: "/sessions/a.jsonl", customInstructions: "keep decisions" },
	{ type: "get_available_models" },
	{ type: "get_default_model" },
	{ type: "get_session_statuses" },
	{ type: "get_session_stats", sessionPath: "/sessions/a.jsonl" },
	{ type: "fork", sessionPath: "/sessions/a.jsonl", entryId: "entry-1" },
	{ type: "fork_prompt", sessionPath: "/sessions/a.jsonl", message: "branch", model, images: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
	{ type: "set_session_name", sessionPath: "/sessions/a.jsonl", name: "typed-protocol" },
	{ type: "get_commands", sessionPath: "/sessions/a.jsonl", cwd: "/project-a" },
	{ type: "reload_processes" },
] as const;

const successResponses: ServerMessagePayload[] = [
	{ type: "response", id: "req-1", command: "install_pi", success: true, data: {} },
	{ type: "response", id: "req-1", command: "subscribe_session", success: true, data: {} },
	{ type: "response", id: "req-1", command: "prompt", success: true, data: { newSessionPath: "/sessions/a.jsonl" } },
	{ type: "response", id: "req-1", command: "steer", success: true, data: {} },
	{ type: "response", id: "req-1", command: "remove_steering", success: true, data: {} },
	{ type: "response", id: "req-1", command: "abort", success: true, data: {} },
	{ type: "response", id: "req-1", command: "hard_kill", success: true, data: { killed: false, reason: "not_attached" } },
	{ type: "response", id: "req-1", command: "compact", success: true, data: { summary: "done" } },
	{ type: "response", id: "req-1", command: "get_available_models", success: true, data: { models: [{ provider: "anthropic", id: "claude-sonnet" }] } },
	{ type: "response", id: "req-1", command: "get_default_model", success: true, data: { model: null, thinkingLevel: "off" } },
	{ type: "response", id: "req-1", command: "get_session_statuses", success: true, data: { statuses: { "/sessions/a.jsonl": "running" } } },
	{ type: "response", id: "req-1", command: "get_session_stats", success: true, data: sessionStats },
	{ type: "response", id: "req-1", command: "fork", success: true, data: { text: "hello", cancelled: false, newSessionPath: "/sessions/b.jsonl" } },
	{ type: "response", id: "req-1", command: "fork_prompt", success: true, data: { newSessionPath: "/sessions/b.jsonl" } },
	{ type: "response", id: "req-1", command: "set_session_name", success: true, data: {} },
	{ type: "response", id: "req-1", command: "get_commands", success: true, data: { commands: [{ name: "help", source: "extension", sourceInfo: { scope: "project" } }] } },
	{ type: "response", id: "req-1", command: "reload_processes", success: true, data: { killed: 1, draining: 2 } },
];

const serverEvents: ServerMessagePayload[] = [
	{ type: "init", sessionStatuses: {}, steeringQueues: {}, providerUsageStatuses: {} },
	{ type: "pi_install_required", command: "pi", installable: true, installing: false, message: "missing" },
	{ type: "session_status_change", sessionPath: "/sessions/a.jsonl", status: "running" },
	{ type: "provider_usage", statuses: { codex: "codex 20% 5h" } },
	{ type: "extension_status", sessionPath: "/sessions/a.jsonl", statuses: { build: "ready" } },
	{ type: "session_sync", sessionPath: "/sessions/a.jsonl", revision: 3, op: "full", data: "{}", hash: "abc" },
	{ type: "session_sync", sessionPath: "/sessions/a.jsonl", revision: 4, op: "delta", patches: [{ offset: 1, deleteCount: 0, insert: "x" }], baseHash: "abc", hash: "def" },
	{ type: "control_state", sessionPath: "/sessions/a.jsonl", controlRevision: 2, model: { provider: "anthropic", id: "claude-sonnet" }, thinkingLevel: "high" },
	{ type: "session_attached", sessionPath: "/sessions/a.jsonl", cwd: "/project", firstMessage: "hello" },
	{ type: "sessions_changed", file: "/sessions/a.jsonl" },
];

describe("WebSocket protocol contract", () => {
	it("validates every supported client command", () => {
		for (const command of clientCommands) {
			const result = decodeClientCommand(JSON.stringify({ ...envelope, ...command }));
			expect(result, command.type).toMatchObject({ ok: true, value: { type: command.type, id: "req-1" } });
		}
	});

	it("returns useful client-boundary errors", () => {
		expect(decodeClientCommand("{"))
			.toMatchObject({ ok: false, error: { code: "invalid_json", command: "parse" } });
		expect(decodeClientCommand(JSON.stringify({ ...envelope, type: "nope" })))
			.toMatchObject({ ok: false, error: { code: "unknown_command", requestId: "req-1" } });
		expect(decodeClientCommand(JSON.stringify({ ...envelope, type: "prompt", sessionPath: "x", message: "hi" })))
			.toMatchObject({ ok: false, error: { code: "invalid_message", message: expect.stringContaining("$command.model") } });
		expect(decodeClientCommand(JSON.stringify({ ...envelope, type: "get_session_stats" })))
			.toMatchObject({ ok: false, error: { code: "invalid_message", message: expect.stringContaining("sessionPath") } });
		expect(decodeClientCommand(JSON.stringify({ ...envelope, protocolVersion: 999, type: "abort", sessionPath: "x" })))
			.toMatchObject({ ok: false, error: { code: "unsupported_version", requestId: "req-1" } });
	});

	it("validates every server event and success response", () => {
		for (const message of [...serverEvents, ...successResponses]) {
			const result = decodeServerMessage(encodeServerMessage(message));
			expect(result, message.type).toMatchObject({ ok: true, value: { type: message.type } });
		}
	});

	it("validates the authoritative state carried by session sync", () => {
		const state = {
			messages: [{ role: "user", content: "hello" }],
			isStreaming: false,
			pendingToolCalls: [],
			toolCallTimings: {},
			model,
			thinkingLevel: "high",
			steeringQueue: [],
		};
		expect(decodeSessionStateJson(JSON.stringify(state))).toMatchObject({
			ok: true,
			value: { messages: [{ role: "user" }], thinkingLevel: "high" },
		});
		expect(decodeSessionStateJson(JSON.stringify({ ...state, pendingToolCalls: [7] })))
			.toMatchObject({ ok: false, error: { message: expect.stringContaining("pendingToolCalls[0]") } });
	});

	it("validates correlated protocol failures", () => {
		const error: ServerMessagePayload = {
			type: "response",
			id: "req-1",
			command: "prompt",
			success: false,
			code: "command_failed",
			error: "provider unavailable",
		};
		expect(decodeServerMessage(encodeServerMessage(error))).toMatchObject({
			ok: true,
			value: { id: "req-1", success: false, code: "command_failed" },
		});
	});

	it("rejects malformed, unknown, and version-mismatched server messages", () => {
		expect(decodeServerMessage("not-json")).toMatchObject({ ok: false, error: { code: "invalid_json" } });
		expect(decodeServerMessage(JSON.stringify({ protocolVersion: WS_PROTOCOL_VERSION, type: "mystery" })))
			.toMatchObject({ ok: false, error: { code: "unknown_message" } });
		expect(decodeServerMessage(JSON.stringify({ protocolVersion: 2, type: "init" })))
			.toMatchObject({ ok: false, error: { code: "unsupported_version" } });
		expect(decodeServerMessage(JSON.stringify({
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "session_sync",
			sessionPath: "/sessions/a.jsonl",
			revision: -1,
			op: "full",
			data: "{}",
			hash: "abc",
		}))).toMatchObject({ ok: false, error: { message: expect.stringContaining("revision") } });
	});

	it("encoders attach the current version and correlation id", () => {
		const command = JSON.parse(encodeClientCommand(
			{ type: "abort", sessionPath: "/sessions/a.jsonl" } satisfies ClientCommandPayload,
			"req-9",
		));
		expect(command).toMatchObject({
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "req-9",
			type: "abort",
		});
	});
});

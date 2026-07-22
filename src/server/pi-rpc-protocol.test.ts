/** @vitest-environment node */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	attachStrictJsonlReader,
	decodePiRpcLine,
	encodePiRpcCommand,
} from "./pi-rpc-protocol.js";

const state = {
	model: { provider: "anthropic", id: "claude-sonnet" },
	thinkingLevel: "high",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	sessionFile: "/sessions/a.jsonl",
	sessionId: "session-a",
	autoCompactionEnabled: true,
	messageCount: 2,
	pendingMessageCount: 0,
};

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

const responses = [
	{ type: "response", id: "1", command: "prompt", success: true },
	{ type: "response", id: "1", command: "steer", success: true },
	{ type: "response", id: "1", command: "abort", success: true },
	{ type: "response", id: "1", command: "new_session", success: true, data: { cancelled: false } },
	{ type: "response", id: "1", command: "get_state", success: true, data: state },
	{ type: "response", id: "1", command: "set_model", success: true, data: state.model },
	{ type: "response", id: "1", command: "get_available_models", success: true, data: { models: [state.model] } },
	{ type: "response", id: "1", command: "set_thinking_level", success: true },
	{ type: "response", id: "1", command: "compact", success: true, data: { summary: "compact" } },
	{ type: "response", id: "1", command: "get_session_stats", success: true, data: sessionStats },
	{ type: "response", id: "1", command: "switch_session", success: true, data: { cancelled: false } },
	{ type: "response", id: "1", command: "fork", success: true, data: { text: "hello", cancelled: false } },
	{ type: "response", id: "1", command: "set_session_name", success: true },
	{ type: "response", id: "1", command: "get_commands", success: true, data: { commands: [{ name: "help", source: "extension", sourceInfo: { origin: "extension" } }] } },
	{ type: "response", id: "1", command: "get_state", success: false, error: "not ready" },
];

const events = [
	{ type: "agent_start" },
	{ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false },
	{ type: "agent_settled" },
	{ type: "turn_start" },
	{ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] },
	{ type: "message_start", message: { role: "assistant", content: [] } },
	{ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "start" } },
	{ type: "message_end", message: { role: "assistant", content: [] } },
	{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a" } },
	{ type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "a" }, partialResult: { content: [] } },
	{ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [] }, isError: false },
	{ type: "queue_update", steering: ["continue"], followUp: [] },
	{ type: "compaction_start", reason: "manual" },
	{ type: "compaction_end", reason: "manual", result: { summary: "done" }, aborted: false, willRetry: false },
	{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "busy" },
	{ type: "auto_retry_end", success: true, attempt: 1 },
	{ type: "entry_appended", entry: { type: "message", id: "entry-1" } },
	{ type: "session_info_changed", name: "named" },
	{ type: "thinking_level_changed", level: "high" },
	{ type: "extension_error", extensionPath: "/ext.ts", event: "tool_call", error: "boom" },
];

const extensionUiRequests = [
	{ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["A"] },
	{ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Sure?", message: "Confirm" },
	{ type: "extension_ui_request", id: "ui-1", method: "input", title: "Value", placeholder: "text" },
	{ type: "extension_ui_request", id: "ui-1", method: "editor", title: "Edit", prefill: "text" },
	{ type: "extension_ui_request", id: "ui-1", method: "notify", message: "Done", notifyType: "info" },
	{ type: "extension_ui_request", id: "ui-1", method: "setStatus", statusKey: "usage", statusText: "20%" },
	{ type: "extension_ui_request", id: "ui-1", method: "setWidget", widgetKey: "build", widgetLines: ["ok"], widgetPlacement: "aboveEditor" },
	{ type: "extension_ui_request", id: "ui-1", method: "setTitle", title: "pi" },
	{ type: "extension_ui_request", id: "ui-1", method: "set_editor_text", text: "draft" },
];

describe("Pi RPC protocol contract", () => {
	it("validates every supported response", () => {
		for (const response of responses) {
			expect(decodePiRpcLine(JSON.stringify(response)), response.command)
				.toMatchObject({ ok: true, value: { type: "response", command: response.command } });
		}
	});

	it("validates every supported event and extension UI request", () => {
		for (const event of [...events, ...extensionUiRequests]) {
			expect(decodePiRpcLine(JSON.stringify(event)), event.type)
				.toMatchObject({ ok: true, value: { type: event.type } });
		}
	});

	it("rejects malformed and unknown Pi output before dispatch", () => {
		expect(decodePiRpcLine("{"))
			.toMatchObject({ ok: false, error: { message: expect.stringContaining("Invalid JSON") } });
		expect(decodePiRpcLine(JSON.stringify({ type: "mystery" })))
			.toMatchObject({ ok: false, error: { message: expect.stringContaining("unknown event") } });
		expect(decodePiRpcLine(JSON.stringify({ type: "response", id: "1", command: "get_state", success: true, data: {} })))
			.toMatchObject({ ok: false, error: { message: expect.stringContaining("thinkingLevel") } });
		expect(decodePiRpcLine(JSON.stringify({
			type: "response",
			id: "1",
			command: "get_session_stats",
			success: true,
			data: { ...sessionStats, cost: "free" },
		}))).toMatchObject({ ok: false, error: { message: expect.stringContaining("cost") } });
		expect(decodePiRpcLine(JSON.stringify({ type: "message_update", message: null })))
			.toMatchObject({ ok: false, error: { message: expect.stringContaining("message") } });
	});

	it("frames only on LF and preserves Unicode line separators", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		const stop = attachStrictJsonlReader(stream, (line) => lines.push(line));
		stream.end('{"message":"one\u2028two"}\r\n');
		await new Promise((resolve) => setImmediate(resolve));
		stop();
		expect(lines).toEqual(['{"message":"one\u2028two"}']);
	});

	it("encodes correlated JSONL commands", () => {
		const encoded = encodePiRpcCommand({ type: "get_state" }, "req-7");
		expect(encoded.endsWith("\n")).toBe(true);
		expect(JSON.parse(encoded)).toEqual({ type: "get_state", id: "req-7" });
	});
});

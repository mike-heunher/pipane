/**
 * Mock OpenAI-compatible LLM server for e2e tests.
 *
 * Implements POST /v1/chat/completions with SSE streaming responses.
 * Each scenario is a sequence of SSE chunks the server sends back.
 * The server inspects the last user message to pick the scenario.
 */

import express from "express";
import { createServer, type Server } from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockChunk {
	choices: Array<{
		index?: number;
		delta: {
			role?: string;
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface Scenario {
	/** Match against the last user message text (substring match). */
	match: string | RegExp;
	/** If set, only match when tool results are (or aren't) present in the conversation. */
	hasToolResults?: boolean;
	/** Ordered SSE chunks to stream back. */
	chunks: MockChunk[];
}

// ---------------------------------------------------------------------------
// Helpers for building scenarios
// ---------------------------------------------------------------------------

export function textChunks(text: string): MockChunk[] {
	const words = text.split(" ");
	const chunks: MockChunk[] = [];
	for (const word of words) {
		chunks.push({
			choices: [{ delta: { content: (chunks.length ? " " : "") + word }, finish_reason: null }],
		});
	}
	// Final chunk with finish_reason + usage
	chunks.push({
		choices: [{ delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 100, completion_tokens: words.length, total_tokens: 100 + words.length },
	});
	return chunks;
}

export function toolCallChunks(
	toolCallId: string,
	name: string,
	args: Record<string, any>,
): MockChunk[] {
	const argsStr = JSON.stringify(args);
	return [
		// Start tool call
		{
			choices: [{
				delta: {
					tool_calls: [{
						index: 0,
						id: toolCallId,
						type: "function",
						function: { name, arguments: "" },
					}],
				},
				finish_reason: null,
			}],
		},
		// Stream arguments in one chunk (could be split for more realism)
		{
			choices: [{
				delta: {
					tool_calls: [{
						index: 0,
						function: { arguments: argsStr },
					}],
				},
				finish_reason: null,
			}],
		},
		// Finish
		{
			choices: [{ delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
		},
	];
}

export function toolCallWithTextChunks(
	text: string,
	toolCallId: string,
	name: string,
	args: Record<string, any>,
): MockChunk[] {
	// Text first, then tool call
	const textPart: MockChunk[] = text.split(" ").map((word, i) => ({
		choices: [{ delta: { content: (i ? " " : "") + word }, finish_reason: null }],
	}));
	const argsStr = JSON.stringify(args);
	return [
		...textPart,
		{
			choices: [{
				delta: {
					tool_calls: [{
						index: 0,
						id: toolCallId,
						type: "function",
						function: { name, arguments: "" },
					}],
				},
				finish_reason: null,
			}],
		},
		{
			choices: [{
				delta: {
					tool_calls: [{
						index: 0,
						function: { arguments: argsStr },
					}],
				},
				finish_reason: null,
			}],
		},
		{
			choices: [{ delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
		},
	];
}

// ---------------------------------------------------------------------------
// Default scenarios
// ---------------------------------------------------------------------------

export const defaultScenarios: Scenario[] = [
	{
		// Read a file, then respond
		match: "read the config",
		chunks: toolCallWithTextChunks(
			"I'll read the config file.",
			"call_read_1",
			"read",
			{ path: "config.ts" },
		),
	},
	{
		// After tool result, just respond with text
		match: /./,
		chunks: textChunks("Done! The file has been read successfully."),
	},
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface MockLlmServer {
	server: Server;
	port: number;
	/** Override scenarios at runtime */
	setScenarios(scenarios: Scenario[]): void;
	/** Get call count */
	callCount: number;
	/** Get last request body */
	lastRequest: any;
	close(): Promise<void>;
}

export function createMockLlmServer(
	scenarios: Scenario[] = defaultScenarios,
): Promise<MockLlmServer> {
	return new Promise((resolve) => {
		const app = express();
		app.use(express.json({ limit: "10mb" }));

		let currentScenarios = scenarios;
		let callCount = 0;
		let lastRequest: any = null;

		app.post("/v1/chat/completions", (req, res) => {
			callCount++;
			lastRequest = req.body;

			// Extract last user message text and check for tool results
			const messages: any[] = req.body.messages || [];
			const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
			const hasToolResults = messages.some((m: any) => m.role === "tool");
			let userText = "";
			if (lastUser) {
				if (typeof lastUser.content === "string") {
					userText = lastUser.content;
				} else if (Array.isArray(lastUser.content)) {
					userText = lastUser.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join(" ");
				}
			}

			// Find matching scenario
			const scenario = currentScenarios.find((s) => {
				// Filter by hasToolResults if specified
				if (s.hasToolResults !== undefined && s.hasToolResults !== hasToolResults) return false;
				if (typeof s.match === "string") return userText.includes(s.match);
				return s.match.test(userText);
			});

			if (!scenario) {
				res.status(400).json({ error: `No scenario matches: "${userText}"` });
				return;
			}

			// Stream SSE
			res.setHeader("Content-Type", "text/event-stream");
			res.setHeader("Cache-Control", "no-cache");
			res.setHeader("Connection", "keep-alive");

			const model = req.body.model || "mock-model";
			let i = 0;

			const sendNext = () => {
				if (i >= scenario.chunks.length) {
					res.write("data: [DONE]\n\n");
					res.end();
					return;
				}

				const chunk = scenario.chunks[i++];
				const data = {
					id: `chatcmpl-mock-${callCount}-${i}`,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model,
					...chunk,
				};
				res.write(`data: ${JSON.stringify(data)}\n\n`);

				// Small delay between chunks for realism
				setTimeout(sendNext, 5);
			};

			sendNext();
		});

		// Health check
		app.get("/health", (_req, res) => res.json({ ok: true }));

		const server = createServer(app);
		server.listen(0, () => {
			const port = (server.address() as any).port;
			resolve({
				server,
				port,
				setScenarios: (s: Scenario[]) => { currentScenarios = s; },
				get callCount() { return callCount; },
				get lastRequest() { return lastRequest; },
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

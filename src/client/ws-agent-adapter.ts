/**
 * WebSocket-backed Agent adapter.
 *
 * Implements the same interface as Agent from @mariozechner/pi-agent-core
 * but routes all operations through a WebSocket to the backend server,
 * which manages the pi coding agent via RPC.
 */

import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";

type WsCommand =
	| { type: "prompt"; message: string; images?: ImageContent[] }
	| { type: "prompt_message"; message: AgentMessage }
	| { type: "abort" }
	| { type: "steer"; message: string; images?: ImageContent[] }
	| { type: "follow_up"; message: string; images?: ImageContent[] }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "get_available_models" };

type WsResponse = {
	id: string;
	type: "response";
	command: string;
	success: boolean;
	data?: any;
	error?: string;
};

export class WsAgentAdapter {
	private ws: WebSocket | null = null;
	private listeners = new Set<(e: AgentEvent) => void>();
	private pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();
	private requestId = 0;
	private _runningPromise: Promise<void> | undefined;
	private _resolveRunning: (() => void) | undefined;

	// Dummy fields that AgentInterface checks but we don't need
	streamFn: any = () => {};
	getApiKey: any = undefined;

	private _state: AgentState = {
		systemPrompt: "",
		model: undefined as any,
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(e: AgentEvent) {
		for (const listener of this.listeners) {
			listener(e);
		}
	}

	/**
	 * Connect to the WebSocket server.
	 */
	async connect(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(url);

			this.ws.onopen = () => {
				// Fetch initial state
				this.send({ type: "get_state" }).then((data) => {
					if (data) {
						this._state.model = data.model;
						this._state.thinkingLevel = data.thinkingLevel;
						this._state.isStreaming = data.isStreaming;
					}
					return this.send({ type: "get_messages" });
				}).then((data) => {
					if (data?.messages) {
						this._state.messages = data.messages;
					}
					resolve();
				}).catch(reject);
			};

			this.ws.onerror = (ev) => {
				reject(new Error("WebSocket error"));
			};

			this.ws.onclose = () => {
				this.ws = null;
			};

			this.ws.onmessage = (ev) => {
				this.handleMessage(ev.data);
			};
		});
	}

	private handleMessage(raw: string) {
		let data: any;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}

		// Response to a pending request
		if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			if (data.success) {
				pending.resolve(data.data);
			} else {
				pending.reject(new Error(data.error || "Unknown error"));
			}
			return;
		}

		// Agent event — update local state and emit
		const event = data as AgentEvent;
		this.updateState(event);
		this.emit(event);
	}

	private updateState(event: AgentEvent) {
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._state.error = undefined;
				this._state.streamMessage = null;
				this._runningPromise = new Promise((resolve) => {
					this._resolveRunning = resolve;
				});
				break;

			case "agent_end":
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();
				// Sync messages from the event
				if (event.messages) {
					// agent_end carries final messages array from the RPC side
					// But we've been building up locally, so just mark done
				}
				this._resolveRunning?.();
				this._runningPromise = undefined;
				this._resolveRunning = undefined;
				break;

			case "message_start":
				this._state.streamMessage = event.message;
				break;

			case "message_update":
				this._state.streamMessage = event.message;
				break;

			case "message_end":
				this._state.streamMessage = null;
				this._state.messages = [...this._state.messages, event.message];
				break;

			case "turn_end":
				if (event.message.role === "assistant" && (event.message as any).errorMessage) {
					this._state.error = (event.message as any).errorMessage;
				}
				// Also append tool results
				if (event.toolResults) {
					for (const tr of event.toolResults) {
						this._state.messages = [...this._state.messages, tr];
					}
				}
				break;

			case "tool_execution_start": {
				const s = new Set(this._state.pendingToolCalls);
				s.add(event.toolCallId);
				this._state.pendingToolCalls = s;
				break;
			}

			case "tool_execution_end": {
				const s = new Set(this._state.pendingToolCalls);
				s.delete(event.toolCallId);
				this._state.pendingToolCalls = s;
				break;
			}
		}
	}

	private send(command: WsCommand): Promise<any> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket not connected"));
		}

		const id = `req_${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (data) => {
					clearTimeout(timeout);
					resolve(data);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			this.ws!.send(JSON.stringify({ ...command, id }));
		});
	}

	// =========================================================================
	// Agent interface methods used by ChatPanel / AgentInterface
	// =========================================================================

	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
		if (typeof input === "string") {
			await this.send({ type: "prompt", message: input, images });
		} else if (Array.isArray(input)) {
			// Send first message as prompt
			for (const msg of input) {
				await this.send({ type: "prompt_message", message: msg });
			}
		} else {
			await this.send({ type: "prompt_message", message: input });
		}
	}

	abort() {
		this.send({ type: "abort" }).catch(() => {});
	}

	steer(m: AgentMessage) {
		this.send({ type: "steer", message: typeof m.content === "string" ? m.content : "" }).catch(() => {});
	}

	followUp(m: AgentMessage) {
		this.send({ type: "follow_up", message: typeof m.content === "string" ? m.content : "" }).catch(() => {});
	}

	waitForIdle(): Promise<void> {
		return this._runningPromise ?? Promise.resolve();
	}

	setModel(m: Model<any>) {
		this._state.model = m;
		this.send({ type: "set_model", provider: m.provider, modelId: m.id }).catch(() => {});
	}

	setThinkingLevel(l: ThinkingLevel) {
		this._state.thinkingLevel = l;
		this.send({ type: "set_thinking_level", level: l }).catch(() => {});
	}

	setSystemPrompt(v: string) {
		this._state.systemPrompt = v;
	}

	setTools(t: AgentTool<any>[]) {
		// Tools are managed server-side, this is a no-op
		this._state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		this._state.messages = ms.slice();
	}

	appendMessage(m: AgentMessage) {
		this._state.messages = [...this._state.messages, m];
	}

	clearMessages() {
		this._state.messages = [];
	}

	clearSteeringQueue() {}
	clearFollowUpQueue() {}
	clearAllQueues() {}

	hasQueuedMessages(): boolean {
		return false;
	}

	setSteeringMode(_mode: "all" | "one-at-a-time") {}
	getSteeringMode(): "all" | "one-at-a-time" { return "one-at-a-time"; }
	setFollowUpMode(_mode: "all" | "one-at-a-time") {}
	getFollowUpMode(): "all" | "one-at-a-time" { return "one-at-a-time"; }

	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;
	}
}

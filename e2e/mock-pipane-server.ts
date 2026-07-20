import express from "express";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const CLIENT_DIST = path.resolve(import.meta.dirname, "../dist/client");

export interface MockSessionState {
	messages: any[];
	isStreaming: boolean;
	pendingToolCalls: string[];
	toolCallTimings: Record<string, { startedAt: number; completedAt?: number }>;
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	steeringQueue: string[];
	error?: string;
}

export interface MockPipaneServerOptions {
	sessions: any[];
	states: Record<string, Partial<MockSessionState> | any[]>;
	model?: any;
	sessionStatuses?: Record<string, "running" | "done">;
	settings?: any;
	browse?: { path: string; dirs: Array<{ name: string; path: string }> };
}

function hashState(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

function compactModel(model: any): { provider: string; modelId: string } | null {
	if (!model?.provider) return null;
	const modelId = model.modelId ?? model.id;
	return typeof modelId === "string" ? { provider: model.provider, modelId } : null;
}

function normalizeState(value: Partial<MockSessionState> | any[], model: any): MockSessionState {
	const partial = Array.isArray(value) ? { messages: value } : value;
	return {
		messages: partial.messages ?? [],
		isStreaming: partial.isStreaming ?? false,
		pendingToolCalls: partial.pendingToolCalls ?? [],
		toolCallTimings: partial.toolCallTimings ?? {},
		model: partial.model === undefined ? compactModel(model) : partial.model,
		thinkingLevel: partial.thinkingLevel ?? "off",
		steeringQueue: partial.steeringQueue ?? [],
		...(partial.error ? { error: partial.error } : {}),
	};
}

export class MockPipaneServer {
	readonly server: Server;
	readonly port: number;
	private readonly wss: WebSocketServer;
	private sessions: any[];
	private readonly states: Map<string, MockSessionState>;
	private readonly model: any;
	private readonly sessionStatuses: Record<string, "running" | "done">;
	private client: WebSocket | null = null;

	private constructor(
		server: Server,
		wss: WebSocketServer,
		port: number,
		options: MockPipaneServerOptions,
	) {
		this.server = server;
		this.wss = wss;
		this.port = port;
		this.sessions = [...options.sessions];
		this.model = options.model ?? { provider: "anthropic", id: "claude-sonnet-4-20250514" };
		this.sessionStatuses = { ...(options.sessionStatuses ?? {}) };
		this.states = new Map(
			Object.entries(options.states).map(([sessionPath, state]) => [
				sessionPath,
				normalizeState(state, this.model),
			]),
		);
	}

	static async start(options: MockPipaneServerOptions): Promise<MockPipaneServer> {
		const app = express();
		const server = createServer(app);
		const wss = new WebSocketServer({ server, path: "/ws" });

		let mock: MockPipaneServer | undefined;
		app.use(express.static(CLIENT_DIST));
		app.get("/api/sessions", (_req, res) => res.json(mock?.sessions ?? options.sessions));
		app.get("/api/settings/local", (_req, res) => res.json({
			settings: options.settings ?? {
				appearance: { colorTheme: "gruvbox", darkMode: "light", showTokenUsage: true },
			},
		}));
		app.get("/api/browse", (_req, res) => res.json(options.browse ?? { path: "/tmp", dirs: [] }));

		const port = await new Promise<number>((resolve, reject) => {
			server.listen(0, () => {
				const address = server.address();
				if (!address || typeof address === "string") {
					reject(new Error("Mock pipane server did not bind to a TCP port"));
					return;
				}
				resolve(address.port);
			});
			server.on("error", reject);
		});

		mock = new MockPipaneServer(server, wss, port, options);
		wss.on("connection", (ws) => mock!.handleConnection(ws));
		return mock;
	}

	private handleConnection(ws: WebSocket): void {
		this.client = ws;
		ws.send(JSON.stringify({
			type: "init",
			sessionStatuses: this.sessionStatuses,
			steeringQueues: {},
			providerUsageStatuses: {},
		}));
		ws.on("message", (raw) => this.handleCommand(ws, raw.toString()));
		ws.on("close", () => {
			if (this.client === ws) this.client = null;
		});
	}

	private handleCommand(ws: WebSocket, raw: string): void {
		const command = JSON.parse(raw);
		if (!command.id) return;
		const respond = (data: any = {}) => ws.send(JSON.stringify({
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
			data,
		}));

		switch (command.type) {
			case "get_default_model":
				respond({ model: this.model, thinkingLevel: "off" });
				break;
			case "get_available_models":
				respond({ models: [this.model] });
				break;
			case "get_session_statuses":
				respond({ statuses: this.sessionStatuses });
				break;
			case "subscribe_session":
				if (command.sessionPath) this.sendSessionState(command.sessionPath, undefined, ws);
				respond();
				break;
			default:
				respond();
		}
	}

	setSessions(sessions: any[]): void {
		this.sessions = [...sessions];
	}

	getSessionState(sessionPath: string): MockSessionState {
		return this.states.get(sessionPath) ?? normalizeState([], this.model);
	}

	sendSessionState(
		sessionPath: string,
		patch?: Partial<MockSessionState>,
		target: WebSocket | null = this.client,
	): void {
		const state = patch
			? { ...this.getSessionState(sessionPath), ...patch }
			: this.getSessionState(sessionPath);
		this.states.set(sessionPath, state);
		if (!target || target.readyState !== WebSocket.OPEN) return;
		const data = JSON.stringify(state);
		target.send(JSON.stringify({
			type: "session_sync",
			sessionPath,
			op: "full",
			data,
			hash: hashState(data),
		}));
	}

	sendSessionStatus(sessionPath: string, status: "running" | "done"): void {
		this.sessionStatuses[sessionPath] = status;
		this.send({ type: "session_status_change", sessionPath, status });
	}

	send(payload: any): void {
		if (this.client?.readyState === WebSocket.OPEN) {
			this.client.send(JSON.stringify(payload));
		}
	}

	async close(): Promise<void> {
		for (const client of this.wss.clients) client.terminate();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

export function startMockPipaneServer(options: MockPipaneServerOptions): Promise<MockPipaneServer> {
	return MockPipaneServer.start(options);
}

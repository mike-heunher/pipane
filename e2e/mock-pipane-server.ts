import express from "express";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { UpdateNotice, UpdateTarget } from "../src/shared/updates.js";
import { encodeServerMessage, type ServerMessagePayload } from "../src/shared/ws-protocol.js";

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
	files?: Record<string, string>;
	updates?: UpdateNotice[];
	/** One-shot command failures used by transport recovery tests. */
	disconnectOnCommands?: string[];
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
	private updateNotices: UpdateNotice[];
	private readonly updateRequests: UpdateTarget[] = [];
	private readonly sessionRevisions = new Map<string, number>();
	private readonly disconnectOnCommands: Set<string>;
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
		this.updateNotices = (options.updates ?? []).map((notice) => ({
			...notice,
			...(notice.packages ? { packages: [...notice.packages] } : {}),
		}));
		this.disconnectOnCommands = new Set(options.disconnectOnCommands ?? []);
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
		let uploadSequence = 0;
		const uploads = new Map<string, { fileName: string; mimeType: string; size: number }>();
		app.use(express.json({ limit: "1mb" }));
		app.use(express.static(CLIENT_DIST));
		app.get("/api/sessions", (_req, res) => res.json(mock?.sessions ?? options.sessions));
		app.get("/api/settings/local", (_req, res) => res.json({
			settings: options.settings ?? {
				appearance: { colorTheme: "gruvbox", darkMode: "light", showTokenUsage: true },
			},
		}));
		app.get("/api/browse", (_req, res) => res.json(options.browse ?? { path: "/tmp", dirs: [] }));
		app.get("/api/files/content", (req, res) => {
			const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
			const sessionPath = typeof req.query.sessionPath === "string" ? req.query.sessionPath : "";
			const session = (mock?.sessions ?? options.sessions).find((candidate) => candidate.path === sessionPath);
			const filePath = path.isAbsolute(requestedPath)
				? requestedPath
				: path.resolve(typeof session?.cwd === "string" ? session.cwd : "/", requestedPath);
			const content = options.files?.[filePath];
			if (content === undefined) {
				res.status(404).json({ error: "File not found" });
				return;
			}
			res.json({ path: filePath, content });
		});
		app.post("/api/files/uploads", (req, res) => {
			const uploadId = `mock-${++uploadSequence}`;
			uploads.set(uploadId, {
				fileName: String(req.body.fileName),
				mimeType: String(req.body.mimeType),
				size: Number(req.body.size),
			});
			res.status(201).json({ uploadId });
		});
		app.post("/api/files/uploads/:uploadId/chunks", (req, res) => {
			if (!uploads.has(req.params.uploadId)) {
				res.status(404).json({ error: "Upload not found" });
				return;
			}
			res.json({
				nextOffset: Number(req.body.offset) + Buffer.from(String(req.body.data), "base64").length,
			});
		});
		app.post("/api/files/uploads/:uploadId/complete", (req, res) => {
			const upload = uploads.get(req.params.uploadId);
			if (!upload) {
				res.status(404).json({ error: "Upload not found" });
				return;
			}
			uploads.delete(req.params.uploadId);
			res.json({
				...upload,
				path: path.join("/tmp", `pipane-mock-upload-${req.params.uploadId}`, path.basename(upload.fileName)),
			});
		});
		app.get("/api/updates", (_req, res) => res.json({
			checkedAt: new Date().toISOString(),
			notices: mock?.getUpdateNotices() ?? [],
		}));
		app.post("/api/updates/:target", (req, res) => {
			if (req.get("X-Pipane-Action") !== "update") {
				res.status(400).json({ error: "Missing update action header." });
				return;
			}
			const result = mock?.runUpdate(req.params.target as UpdateTarget);
			if (!result) {
				res.status(409).json({ error: `No ${req.params.target} update is currently available.` });
				return;
			}
			res.json({ result, snapshot: { checkedAt: new Date().toISOString(), notices: mock!.getUpdateNotices() } });
		});

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
		this.sendTo(ws, {
			type: "init",
			sessionStatuses: this.sessionStatuses,
			steeringQueues: {},
			providerUsageStatuses: {},
		});
		ws.on("message", (raw) => this.handleCommand(ws, raw.toString()));
		ws.on("close", () => {
			if (this.client === ws) this.client = null;
		});
	}

	private handleCommand(ws: WebSocket, raw: string): void {
		const command = JSON.parse(raw);
		if (!command.id) return;
		if (this.disconnectOnCommands.delete(command.type)) {
			ws.close(1011, `Mock disconnect during ${command.type}`);
			return;
		}
		const respond = (data: Record<string, unknown> = {}) => this.sendTo(ws, {
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
			data,
		} as ServerMessagePayload);

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
			case "get_commands":
				respond({ commands: [
					{ name: "project-review", description: "Review the current project", source: "prompt", sourceInfo: { scope: "project" } },
					{ name: "skill:search", description: "Search the web", source: "skill", sourceInfo: { scope: "user" } },
				] });
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

	getUpdateNotices(): UpdateNotice[] {
		return this.updateNotices.map((notice) => ({
			...notice,
			...(notice.packages ? { packages: [...notice.packages] } : {}),
		}));
	}

	getUpdateRequests(): UpdateTarget[] {
		return [...this.updateRequests];
	}

	runUpdate(target: UpdateTarget): { target: UpdateTarget; message: string; restartRequired: boolean } | null {
		if (!this.updateNotices.some((notice) => notice.target === target)) return null;
		this.updateRequests.push(target);
		this.updateNotices = this.updateNotices.filter((notice) => notice.target !== target);
		return {
			target,
			message: `${target} update completed.`,
			restartRequired: target === "pipane",
		};
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
		const revision = (this.sessionRevisions.get(sessionPath) ?? 0) + 1;
		this.sessionRevisions.set(sessionPath, revision);
		this.sendTo(target, {
			type: "session_sync",
			sessionPath,
			revision,
			op: "full",
			data,
			hash: hashState(data),
		});
	}

	sendSessionStatus(sessionPath: string, status: "running" | "done"): void {
		this.sessionStatuses[sessionPath] = status;
		this.send({ type: "session_status_change", sessionPath, status });
	}

	private sendTo(target: WebSocket, payload: ServerMessagePayload): void {
		if (target.readyState === WebSocket.OPEN) target.send(encodeServerMessage(payload));
	}

	send(payload: ServerMessagePayload): void {
		if (this.client) this.sendTo(this.client, payload);
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

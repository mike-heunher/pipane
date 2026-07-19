import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SessionJsonl } from "./session-jsonl.js";
import { WsHandler } from "./ws-handler.js";

function makeHandler(sendRpcChecked: ReturnType<typeof vi.fn>) {
	const attachedProcesses = new Map<any, string>();
	const processesBySession = new Map<string, any>();
	const lifecycle = {
		subscribe: vi.fn(),
		clearSteering: vi.fn(),
		enqueueSteering: vi.fn(),
		getAttachedSessionForProcess: vi.fn((proc: any) => attachedProcesses.get(proc)),
		getAttachedProcess: vi.fn((sessionPath: string) => processesBySession.get(sessionPath)),
		detach: vi.fn((sessionPath: string) => {
			const proc = processesBySession.get(sessionPath);
			processesBySession.delete(sessionPath);
			if (proc) attachedProcesses.delete(proc);
			return proc;
		}),
	} as any;
	const poolEventListeners = new Set<(proc: any, event: any) => void>();
	const pool = {
		sendRpcChecked,
		sendRpc: vi.fn(async () => ({ success: true })),
		getAllProcesses: vi.fn(() => []),
		totalProcesses: 0,
		subscribeEvents: vi.fn((listener: (proc: any, event: any) => void) => {
			poolEventListeners.add(listener);
			return () => poolEventListeners.delete(listener);
		}),
	} as any;
	const emitProcessEvent = (proc: any, event: any) => {
		for (const listener of poolEventListeners) listener(proc, event);
	};
	const handler = new WsHandler({
		lifecycle,
		pool,
		defaultCwd: "/tmp",
		piLaunch: { command: "pi", baseArgs: [] },
		ensurePool: vi.fn(),
		isRequestAuthorized: () => true,
	});
	return {
		handler: handler as any,
		lifecycle,
		pool,
		emitProcessEvent,
		attachProcess: (proc: any, sessionPath: string) => {
			attachedProcesses.set(proc, sessionPath);
			processesBySession.set(sessionPath, proc);
		},
	};
}

function attachEmptySession(handler: any, sessionPath: string) {
	handler.attachedSessions.set(sessionPath, new SessionJsonl({
		messages: [],
		model: { provider: "anthropic", modelId: "old-model" },
		thinkingLevel: "off",
	}));
}

describe("WsHandler control state reconciliation", () => {
	it("applies model and thinking sequentially and publishes pi's effective clamp", async () => {
		const calls: any[] = [];
		const sendRpcChecked = vi.fn(async (_proc: any, command: any) => {
			calls.push(command);
			if (command.type === "get_state" && calls.filter(c => c.type === "get_state").length === 1) {
				return { success: true, data: { model: { provider: "anthropic", id: "old-model" }, thinkingLevel: "off" } };
			}
			if (command.type === "get_state") {
				return {
					success: true,
					data: {
						model: { provider: "deepseek", id: "deepseek-v4", reasoning: true },
						thinkingLevel: "high",
					},
				};
			}
			return { success: true };
		});
		const { handler } = makeHandler(sendRpcChecked);
		const sessionPath = "/tmp/session.jsonl";
		attachEmptySession(handler, sessionPath);
		const sent: any[] = [];
		const ws = { readyState: WebSocket.OPEN, send: (raw: string) => sent.push(JSON.parse(raw)) } as any;

		await handler.applyRequestedControlState({}, sessionPath, ws, {
			model: { provider: "deepseek", modelId: "deepseek-v4" },
			thinkingLevel: "medium",
			controlRevision: 7,
		});

		expect(calls.map(c => c.type)).toEqual([
			"get_state", "set_model", "set_thinking_level", "get_state",
		]);
		expect(handler.attachedSessions.get(sessionPath).toState()).toMatchObject({
			model: { provider: "deepseek", modelId: "deepseek-v4" },
			thinkingLevel: "high",
		});
		expect(sent).toContainEqual(expect.objectContaining({
			type: "control_state",
			sessionPath,
			controlRevision: 7,
			thinkingLevel: "high",
		}));
	});

	it("does not redundantly set an already-active model", async () => {
		const sendRpcChecked = vi.fn(async (_proc: any, command: any) => {
			if (command.type === "get_state") {
				return {
					success: true,
					data: { model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "high" },
				};
			}
			return { success: true };
		});
		const { handler } = makeHandler(sendRpcChecked);
		const sessionPath = "/tmp/session.jsonl";
		attachEmptySession(handler, sessionPath);
		const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;

		await handler.applyRequestedControlState({}, sessionPath, ws, {
			model: { provider: "openai", modelId: "gpt-5" },
			thinkingLevel: "high",
			controlRevision: 1,
		});

		expect(sendRpcChecked.mock.calls.map((call: any[]) => call[1].type)).toEqual([
			"get_state", "set_thinking_level", "get_state",
		]);
	});

	it("atomically reserves an acquired process before yielding it", async () => {
		const { handler, pool } = makeHandler(vi.fn());
		const proc = { id: 8, process: { exitCode: null } } as any;
		pool.acquire = vi.fn(() => proc);

		await expect(handler.acquireProcess("/tmp")).resolves.toBe(proc);
		expect(handler.busyProcesses.has(proc)).toBe(true);
	});

	it("routes a raced prompt to steering when the session is already attached", async () => {
		const { handler, pool, lifecycle, attachProcess } = makeHandler(vi.fn());
		const sessionPath = "/tmp/running-session.jsonl";
		const proc = { id: 9 } as any;
		attachProcess(proc, sessionPath);
		const sent: any[] = [];
		const ws = { readyState: WebSocket.OPEN, send: (raw: string) => sent.push(JSON.parse(raw)) } as any;

		await handler.handlePrompt(ws, "req_2", { sessionPath, message: "continue" });

		expect(lifecycle.enqueueSteering).toHaveBeenCalledWith(sessionPath, "continue");
		expect(pool.sendRpc).toHaveBeenCalledWith(proc, { type: "steer", message: "continue" });
		expect(sent).toContainEqual(expect.objectContaining({ id: "req_2", command: "steer", success: true }));
	});

	it("rejects a second owner while a session turn is still starting", async () => {
		const { handler } = makeHandler(vi.fn());
		const sessionPath = "/tmp/starting-session.jsonl";
		handler.activePromptSessions.add(sessionPath);
		const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;

		await expect(handler.handlePrompt(ws, "req_3", { sessionPath, message: "race" }))
			.rejects.toThrow("already starting");
	});

	it("cleans attached snapshots and listeners when a process exits", () => {
		const { handler, lifecycle, attachProcess } = makeHandler(vi.fn());
		const sessionPath = "/tmp/pipane-crashed-session-does-not-exist.jsonl";
		const proc = { id: 10, process: { exitCode: 1 }, rl: { removeListener: vi.fn() } } as any;
		attachEmptySession(handler, sessionPath);
		attachProcess(proc, sessionPath);
		handler.busyProcesses.add(proc);
		handler.procEventCleanup.set(proc, vi.fn());
		const sent: any[] = [];
		const ws = { readyState: WebSocket.OPEN, send: (raw: string) => sent.push(JSON.parse(raw)) } as any;
		handler.clients.set(ws, { subscribedSession: sessionPath, lastVersion: 0, lastJson: "", lastHash: "" });

		handler.handleProcessExit(proc);

		expect(handler.attachedSessions.has(sessionPath)).toBe(false);
		expect(handler.busyProcesses.has(proc)).toBe(false);
		expect(handler.procEventCleanup.has(proc)).toBe(false);
		expect(lifecycle.detach).toHaveBeenCalledWith(sessionPath);
		const snapshot = sent.find((message) => message.type === "session_sync");
		expect(JSON.parse(snapshot.data).model).toBeNull();
	});

	it("releases a synchronously handled extension input from authoritative idle state", async () => {
		const sendRpcChecked = vi.fn(async () => ({ success: true, data: { isStreaming: false } }));
		const { handler } = makeHandler(sendRpcChecked);
		const child = new EventEmitter() as any;
		child.exitCode = null;
		const never = new Promise<void>(() => {});
		const proc = { id: 11, process: child } as any;
		const observer = {
			started: never,
			ended: never,
			settled: never,
			hasStarted: () => false,
			hasSettled: () => false,
		};

		await expect(handler.waitForPromptSettlement(proc, observer)).resolves.toBeUndefined();
		expect(sendRpcChecked).toHaveBeenCalledTimes(1);
	});

	it("waits for agent_settled when state is streaming before agent_start delivery", async () => {
		const sendRpcChecked = vi.fn(async () => ({ success: true, data: { isStreaming: true } }));
		const { handler } = makeHandler(sendRpcChecked);
		const child = new EventEmitter() as any;
		child.exitCode = null;
		const proc = { id: 13, process: child } as any;
		const never = new Promise<void>(() => {});
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
		const observer = {
			started: never,
			ended: never,
			settled,
			hasStarted: () => false,
			hasSettled: () => false,
		};
		let finished = false;
		const waiting = handler.waitForPromptSettlement(proc, observer).then(() => { finished = true; });
		await Promise.resolve();
		await Promise.resolve();
		expect(finished).toBe(false);
		resolveSettled();
		await waiting;
		expect(finished).toBe(true);
	});

	it("rejects cancelled session replacements before attaching", async () => {
		const sendRpcChecked = vi.fn(async () => ({ success: true, data: { cancelled: true } }));
		const { handler } = makeHandler(sendRpcChecked);
		const proc = { id: 14 } as any;

		await expect(handler.replacePiSession(
			proc,
			{ type: "switch_session", sessionPath: "/tmp/target.jsonl" },
			"switch_session",
		)).rejects.toThrow("was cancelled");
	});

	it("rejects settlement promptly when the pi process exits", async () => {
		const sendRpcChecked = vi.fn(async () => ({ success: true, data: { isStreaming: true } }));
		const { handler } = makeHandler(sendRpcChecked);
		const child = new EventEmitter() as any;
		child.exitCode = null;
		const proc = { id: 12, process: child } as any;
		const never = new Promise<void>(() => {});
		const observer = {
			started: Promise.resolve(),
			ended: never,
			settled: never,
			hasStarted: () => true,
			hasSettled: () => false,
		};

		const waiting = handler.waitForPromptSettlement(proc, observer);
		queueMicrotask(() => {
			child.exitCode = 1;
			child.emit("exit", 1);
		});
		await expect(waiting).rejects.toThrow("exited before the turn settled");
	});

	it("does not release on agent_end before final get_state", () => {
		const { handler, lifecycle, emitProcessEvent } = makeHandler(vi.fn());
		const sessionPath = "/tmp/session.jsonl";
		attachEmptySession(handler, sessionPath);
		const release = vi.fn();
		handler.releaseProcess = release;
		const proc = { id: 1 } as any;
		const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;

		handler.setupTurnEventForwarding(proc, sessionPath, ws, "turn_1");
		emitProcessEvent(proc, { type: "agent_end" });

		expect(lifecycle.clearSteering).toHaveBeenCalledWith(sessionPath);
		expect(release).not.toHaveBeenCalled();
	});

	it("observes the full run through agent_settled", async () => {
		const { handler, emitProcessEvent } = makeHandler(vi.fn());
		const sessionPath = "/tmp/session.jsonl";
		attachEmptySession(handler, sessionPath);
		const proc = { id: 2 } as any;
		const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
		const observer = handler.setupTurnEventForwarding(proc, sessionPath, ws, "turn_2");
		let settled = false;
		observer.settled.then(() => { settled = true; });

		emitProcessEvent(proc, { type: "agent_start" });
		await observer.started;
		expect(observer.hasStarted()).toBe(true);
		emitProcessEvent(proc, { type: "agent_end" });
		await Promise.resolve();
		expect(settled).toBe(false);
		emitProcessEvent(proc, { type: "agent_settled" });
		await observer.settled;
		expect(settled).toBe(true);
	});
});

describe("WsHandler extension statuses", () => {
	it("normalizes, broadcasts, and clears complete status snapshots", () => {
		const { handler, emitProcessEvent, attachProcess } = makeHandler(vi.fn());
		const sessionPath = "/tmp/session.jsonl";
		const proc = { id: 1 } as any;
		attachProcess(proc, sessionPath);

		const sent: any[] = [];
		const subscribed = {
			readyState: WebSocket.OPEN,
			send: (raw: string) => sent.push(JSON.parse(raw)),
		} as any;
		const other = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
		handler.clients.set(subscribed, { subscribedSession: sessionPath });
		handler.clients.set(other, { subscribedSession: "/tmp/other.jsonl" });

		emitProcessEvent(proc, {
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "provider-usage",
			statusText: "\u001b[39m codex\t25%\n5h",
		});

		expect(sent.at(-1)).toEqual({
			type: "extension_status",
			sessionPath,
			statuses: { "provider-usage": "codex 25% 5h" },
		});
		expect(JSON.parse(other.send.mock.calls[0][0])).toEqual({
			type: "provider_usage",
			statuses: { codex: "codex 25% 5h" },
		});

		emitProcessEvent(proc, {
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "provider-usage",
		});
		expect(sent.at(-1).statuses).toEqual({});
	});

	it("replays the authoritative snapshot when a client subscribes", () => {
		const { handler } = makeHandler(vi.fn());
		const sessionPath = "/tmp/replay-session.jsonl";
		attachEmptySession(handler, sessionPath);
		handler.extensionStatusesBySession.set(sessionPath, new Map([
			["provider-usage", "claude 18% 5h"],
		]));
		const sent: any[] = [];
		const ws = {
			readyState: WebSocket.OPEN,
			send: (raw: string) => sent.push(JSON.parse(raw)),
		} as any;
		handler.clients.set(ws, {
			subscribedSession: null,
			lastVersion: 0,
			lastJson: "",
			lastHash: "",
		});

		handler.handleSubscribeSession(ws, "subscribe-1", { sessionPath });

		expect(sent).toContainEqual({
			type: "extension_status",
			sessionPath,
			statuses: { "provider-usage": "claude 18% 5h" },
		});
	});

	it("captures provider usage from unattached prewarm processes and broadcasts it globally", () => {
		const { handler, emitProcessEvent } = makeHandler(vi.fn());
		const sent: any[] = [];
		const ws = {
			readyState: WebSocket.OPEN,
			send: (raw: string) => sent.push(JSON.parse(raw)),
		} as any;
		handler.clients.set(ws, { subscribedSession: null });

		emitProcessEvent({ id: 20 } as any, {
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "provider-usage",
			statusText: "\u001b[39m claude 18% 5h 42% 7d",
		});

		expect(handler.makeProviderUsageMessage()).toEqual({
			type: "provider_usage",
			statuses: { anthropic: "claude 18% 5h 42% 7d" },
		});
		expect(sent).toContainEqual(handler.makeProviderUsageMessage());
		expect(handler.extensionStatusesBySession.size).toBe(0);

		emitProcessEvent({ id: 21 } as any, {
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "provider-usage",
			statusText: "checking",
		});
		expect(handler.makeProviderUsageMessage().statuses).toEqual({
			anthropic: "claude 18% 5h 42% 7d",
		});
	});

	it("ignores prewarm session statuses and commits only an explicit pending capture", () => {
		const { handler, emitProcessEvent, attachProcess } = makeHandler(vi.fn());
		const sessionPath = "/tmp/new-session.jsonl";
		const proc = { id: 2 } as any;
		const status = (statusText: string) => ({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "provider-usage",
			statusText,
		});

		emitProcessEvent(proc, status("stale prewarm status"));
		expect(handler.extensionStatusesBySession.size).toBe(0);

		handler.beginPendingExtensionStatusCapture(proc);
		emitProcessEvent(proc, status("codex 10% 5h"));
		attachProcess(proc, sessionPath);
		handler.commitPendingExtensionStatuses(proc, sessionPath);

		expect(handler.makeExtensionStatusMessage(sessionPath)).toEqual({
			type: "extension_status",
			sessionPath,
			statuses: { "provider-usage": "codex 10% 5h" },
		});
	});
});

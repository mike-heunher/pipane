import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SessionJsonl } from "./session-jsonl.js";
import { SessionRegistry } from "./session-registry.js";
import { COMPACT_RPC_TIMEOUT_MS } from "../shared/rpc-timeouts.js";
import { WS_PROTOCOL_VERSION } from "../shared/ws-protocol.js";
import { WsHandler } from "./ws-handler.js";
import { SessionPathGuard } from "./session-path.js";

function makeHandler(overrides: Record<string, any> = {}) {
	const registry = new SessionRegistry();
	const {
		sessionPaths = {
			resolveExisting: (value: unknown) => value,
			resolvePending: (value: unknown) => value,
			createPath: (filename: string) => path.join("/tmp", filename),
		},
		...poolOverrides
	} = overrides;
	const poolEventListeners = new Set<(proc: any, event: any) => void>();
	const pool = {
		sendRpcChecked: vi.fn(async () => ({ success: true, data: {} })),
		sendRpc: vi.fn(async () => ({ success: true, data: {} })),
		getAllProcesses: vi.fn(() => []),
		totalProcesses: 0,
		isLeased: vi.fn(() => false),
		isDecommissioning: vi.fn(() => false),
		forceKill: vi.fn(() => true),
		decommissionAll: vi.fn(() => ({ killed: 0, draining: 0 })),
		acquireAny: vi.fn(() => null),
		acquire: vi.fn(() => null),
		evictIdleDifferentCwd: vi.fn(() => null),
		getRecentStderr: vi.fn(() => []),
		subscribeEvents: vi.fn((listener: (proc: any, event: any) => void) => {
			poolEventListeners.add(listener);
			return () => poolEventListeners.delete(listener);
		}),
		...poolOverrides,
	} as any;
	const ensurePool = vi.fn();
	const handler = new WsHandler({
		registry,
		pool,
		sessionPaths,
		defaultCwd: "/tmp",
		piLaunch: { command: "pi", baseArgs: [] },
		ensurePool,
		isRequestAuthorized: () => true,
	}) as any;
	handler.piAvailable = true;
	return {
		handler,
		registry,
		pool,
		ensurePool,
		emitProcessEvent: (proc: any, event: any) => {
			for (const listener of poolEventListeners) listener(proc, event);
		},
	};
}

function attachActor(registry: SessionRegistry, sessionPath: string, proc: any) {
	const actor = registry.get(sessionPath);
	const release = vi.fn();
	actor.attach({ process: proc, release } as any, new SessionJsonl({
		messages: [],
		model: { provider: "anthropic", modelId: "old-model" },
		thinkingLevel: "off",
	}));
	return { actor, release };
}

function makeWs() {
	const sent: any[] = [];
	return {
		ws: { readyState: WebSocket.OPEN, send: (raw: string) => sent.push(JSON.parse(raw)) } as any,
		sent,
	};
}

describe("WsHandler protocol boundary", () => {
	it("returns structured errors for malformed JSON, unknown commands, and version mismatches", async () => {
		const { handler } = makeHandler();
		const { ws, sent } = makeWs();

		await handler.handleMessage(ws, "{");
		await handler.handleMessage(ws, JSON.stringify({
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "unknown-1",
			type: "unknown_command",
		}));
		await handler.handleMessage(ws, JSON.stringify({
			protocolVersion: 99,
			id: "version-1",
			type: "get_session_statuses",
		}));

		expect(sent).toEqual(expect.arrayContaining([
			expect.objectContaining({
				protocolVersion: WS_PROTOCOL_VERSION,
				id: null,
				code: "invalid_json",
			}),
			expect.objectContaining({ id: "unknown-1", code: "unknown_command" }),
			expect.objectContaining({ id: "version-1", code: "unsupported_version" }),
		]));
	});

	it("publishes monotonic revisions for changed session snapshots", () => {
		const { handler } = makeHandler();
		const { ws, sent } = makeWs();
		const sessionPath = "/tmp/revision.jsonl";
		handler.clients.set(ws, {
			subscribedSession: sessionPath,
			lastVersion: 0,
			lastJson: "",
			lastHash: "",
		});

		handler.pushSnapshotToSubscribers(sessionPath, "one", "hash-one");
		handler.pushSnapshotToSubscribers(sessionPath, "two", "hash-two");
		handler.pushSnapshotToSubscribers(sessionPath, "two", "hash-two");

		expect(sent.filter((message) => message.type === "session_sync").map((message) => message.revision))
			.toEqual([1, 2, 2]);
	});

	it("rejects invalid fields before command dispatch", async () => {
		const { handler, pool } = makeHandler();
		const { ws, sent } = makeWs();
		await handler.handleMessage(ws, JSON.stringify({
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "prompt-1",
			type: "prompt",
			sessionPath: "/tmp/a.jsonl",
			message: "hello",
		}));

		expect(sent).toContainEqual(expect.objectContaining({
			id: "prompt-1",
			code: "invalid_message",
			error: expect.stringContaining("$command.model"),
		}));
		expect(pool.sendRpc).not.toHaveBeenCalled();
	});
});

describe("WsHandler actor orchestration", () => {
	it("applies model and thinking sequentially and publishes the effective clamp", async () => {
		const calls: any[] = [];
		const sendRpcChecked = vi.fn(async (_proc: any, command: any) => {
			calls.push(command);
			if (command.type === "get_state" && calls.filter((item) => item.type === "get_state").length === 1) {
				return { success: true, data: { model: { provider: "anthropic", id: "old-model" }, thinkingLevel: "off" } };
			}
			if (command.type === "get_state") {
				return { success: true, data: { model: { provider: "deepseek", id: "deepseek-v4" }, thinkingLevel: "high" } };
			}
			return { success: true };
		});
		const { handler, registry } = makeHandler({ sendRpcChecked });
		const proc = { id: 1 };
		const { actor } = attachActor(registry, "/tmp/session.jsonl", proc);
		const { ws, sent } = makeWs();

		await handler.applyRequestedControlState(proc, actor, ws, {
			model: { provider: "deepseek", modelId: "deepseek-v4" },
			thinkingLevel: "medium",
			controlRevision: 7,
		});

		expect(calls.map((call) => call.type)).toEqual([
			"get_state", "set_model", "set_thinking_level", "get_state",
		]);
		expect(actor.session?.toState()).toMatchObject({
			model: { provider: "deepseek", modelId: "deepseek-v4" },
			thinkingLevel: "high",
		});
		expect(sent).toContainEqual(expect.objectContaining({
			type: "control_state",
			controlRevision: 7,
			thinkingLevel: "high",
		}));
	});

	it("routes a prompt arriving during a turn to steering", async () => {
		const sendRpc = vi.fn(async () => ({ success: true }));
		const { handler, registry } = makeHandler({ sendRpc });
		const proc = { id: 2 };
		const { actor } = attachActor(registry, "/tmp/running.jsonl", proc);
		actor.beginTurn();
		const { ws, sent } = makeWs();

		await handler.handlePrompt(ws, {
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "req_1",
			type: "prompt",
			sessionPath: actor.sessionPath,
			message: "continue",
		});

		expect(sendRpc).toHaveBeenCalledWith(proc, { type: "steer", message: "continue" });
		expect(actor.steeringQueue).toEqual(["continue"]);
		expect(sent).toContainEqual(expect.objectContaining({ command: "prompt", success: true }));
	});

	it("serializes raced prompt starts so the second becomes steering", async () => {
		let acceptPrompt!: () => void;
		const promptAccepted = new Promise<void>((resolve) => { acceptPrompt = resolve; });
		const sendRpc = vi.fn(async (_proc: any, command: any) => {
			if (command.type === "prompt") await promptAccepted;
			return { success: true, data: {} };
		});
		const sendRpcChecked = vi.fn(async () => ({
			success: true,
			data: {
				model: { provider: "anthropic", id: "model" },
				thinkingLevel: "off",
				isStreaming: false,
			},
		}));
		const { handler, registry } = makeHandler({ sendRpc, sendRpcChecked });
		const actor = registry.get("/tmp/raced.jsonl");
		const proc = { id: 22 };
		handler.acquireForActor = vi.fn(async () => {
			actor.attach({ process: proc, release: vi.fn() } as any, new SessionJsonl({
				messages: [], model: { provider: "anthropic", modelId: "model" }, thinkingLevel: "off",
			}));
			return proc;
		});
		const first = makeWs();
		const second = makeWs();
		const command = {
			sessionPath: actor.sessionPath,
			model: { provider: "anthropic", modelId: "model" },
			thinkingLevel: "off",
		};

		const firstRun = handler.handlePrompt(first.ws, {
			...command,
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "first",
			type: "prompt",
			message: "first prompt",
		});
		while (!sendRpc.mock.calls.some((call: any[]) => call[1].type === "prompt")) await Promise.resolve();
		const secondRun = handler.handlePrompt(second.ws, {
			...command,
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "second",
			type: "prompt",
			message: "second prompt",
		});
		acceptPrompt();
		await Promise.all([firstRun, secondRun]);

		expect(sendRpc.mock.calls.filter((call: any[]) => call[1].type === "prompt")).toHaveLength(1);
		expect(sendRpc).toHaveBeenCalledWith(proc, { type: "steer", message: "second prompt" });
		expect(second.sent).toContainEqual(expect.objectContaining({ command: "prompt", success: true }));
	});

	it("hard-kills and releases the actor-owned process", async () => {
		const forceKill = vi.fn(() => true);
		const { handler, registry, ensurePool } = makeHandler({ forceKill });
		const proc = { id: 23 };
		const { actor, release } = attachActor(registry, "/tmp/hard-kill.jsonl", proc);
		actor.beginTurn();
		const { ws, sent } = makeWs();

		await handler.handleHardKill(ws, {
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "req_kill",
			type: "hard_kill",
			sessionPath: actor.sessionPath,
		});

		expect(forceKill).toHaveBeenCalledWith(proc);
		expect(actor.phase).toBe("detached");
		expect(release).toHaveBeenCalledOnce();
		expect(ensurePool).toHaveBeenCalledOnce();
		expect(sent).toContainEqual(expect.objectContaining({
			id: "req_kill",
			command: "hard_kill",
			data: { killed: true },
		}));
	});

	it("reports attached session paths in debug state", () => {
		const proc = {
			id: 24,
			cwd: "/tmp",
			process: { pid: 42, exitCode: null },
			pendingRequests: new Map(),
		};
		const { handler, registry } = makeHandler({
			getAllProcesses: vi.fn(() => [proc]),
			totalProcesses: 1,
		});
		attachActor(registry, "/tmp/debug.jsonl", proc);

		expect(handler.getDebugState()).toMatchObject({
			attachedSessionCount: 1,
			attachedSessionPaths: ["/tmp/debug.jsonl"],
		});
	});

	it("rejects compact while a turn is active", async () => {
		const { handler, registry, pool } = makeHandler();
		const { actor } = attachActor(registry, "/tmp/running.jsonl", { id: 3 });
		actor.beginTurn();
		const { ws } = makeWs();

		await expect(handler.handleCompact(ws, {
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "req_2",
			type: "compact",
			sessionPath: actor.sessionPath,
		}))
			.rejects.toThrow("Cannot compact while session turn is starting");
		expect(pool.sendRpc).not.toHaveBeenCalled();
	});

	it("keeps the compact RPC pending for long-running summarization", async () => {
		const sendRpc = vi.fn(async () => ({ success: true, data: { tokensBefore: 375137 } }));
		const { handler, registry } = makeHandler({ sendRpc });
		const proc = { id: 30 };
		const { actor, release } = attachActor(registry, "/tmp/compact.jsonl", proc);
		const { ws, sent } = makeWs();

		await handler.handleCompact(ws, {
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "req_compact",
			type: "compact",
			sessionPath: actor.sessionPath,
		});

		expect(sendRpc).toHaveBeenCalledWith(
			proc,
			{ type: "compact", customInstructions: undefined },
			COMPACT_RPC_TIMEOUT_MS,
		);
		expect(COMPACT_RPC_TIMEOUT_MS).toBeGreaterThan(55_000);
		expect(release).toHaveBeenCalledOnce();
		expect(sent).toContainEqual(expect.objectContaining({
			id: "req_compact",
			command: "compact",
			success: true,
		}));
	});

	it("rejects fork-and-prompt while the source session is running", async () => {
		const { handler, registry } = makeHandler();
		const { actor } = attachActor(registry, "/tmp/running-source.jsonl", { id: 31 });
		actor.beginTurn();
		const { ws } = makeWs();

		await expect(handler.handleForkPrompt(ws, {
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "req_fork",
			type: "fork_prompt",
			sessionPath: actor.sessionPath,
			message: "branch now",
		})).rejects.toThrow("Cannot fork and prompt while session turn is starting");
	});

	it("releases actor ownership when a non-turn RPC fails", async () => {
		const sendRpc = vi.fn(async () => { throw new Error("timeout"); });
		const { handler, registry } = makeHandler({ sendRpc });
		const actor = registry.get("/tmp/rename.jsonl");
		const proc = { id: 4 };
		const release = vi.fn();
		handler.acquireForActor = vi.fn(async () => {
			actor.attach({ process: proc, release } as any, new SessionJsonl({ messages: [], model: null, thinkingLevel: "off" }));
			return proc;
		});
		const { ws } = makeWs();

		await expect(handler.handleSetSessionName(ws, {
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "req_3",
			type: "set_session_name",
			sessionPath: actor.sessionPath,
			name: "renamed",
		})).rejects.toThrow("timeout");
		expect(actor.phase).toBe("detached");
		expect(release).toHaveBeenCalledOnce();
	});

	it("settles actor events in order and ignores stale generations", async () => {
		const { handler, registry, emitProcessEvent } = makeHandler();
		const proc = { id: 5 } as any;
		const { actor } = attachActor(registry, "/tmp/events.jsonl", proc);
		const generation = actor.beginTurn();
		const observer = handler.setupTurnEventForwarding(actor, proc, generation, "turn_1");

		emitProcessEvent(proc, { type: "agent_start" });
		await observer.started;
		expect(actor.phase).toBe("running");
		emitProcessEvent(proc, { type: "agent_settled" });
		await observer.settled;
		expect(actor.phase).toBe("settling");

		actor.detach();
		attachActor(registry, actor.sessionPath, proc);
		actor.beginTurn();
		const stale = await actor.applyProcessEvent(proc, generation, { type: "message_start", message: { role: "assistant", content: [] } });
		expect(stale.accepted).toBe(false);
	});

	it("cleans up actor state exactly once when its process exits", async () => {
		const { handler, registry } = makeHandler();
		const child = new EventEmitter() as any;
		child.exitCode = 1;
		const proc = { id: 6, process: child };
		const { actor, release } = attachActor(registry, "/tmp/missing-session.jsonl", proc);

		handler.handleProcessExit(proc);
		await actor.enqueue("barrier", () => undefined);
		handler.handleProcessExit(proc);
		await actor.enqueue("barrier", () => undefined);

		expect(actor.phase).toBe("detached");
		expect(release).toHaveBeenCalledOnce();
		expect(registry.getActorForProcess(proc as any)).toBeUndefined();
	});

	it("waits for agent settlement and rejects promptly on process exit", async () => {
		const sendRpcChecked = vi.fn(async () => ({ success: true, data: { isStreaming: true } }));
		const { handler } = makeHandler({ sendRpcChecked });
		const child = new EventEmitter() as any;
		child.exitCode = null;
		const proc = { id: 7, process: child };
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
});

describe("WsHandler session path confinement", () => {
	function createFixture() {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pipane-ws-path-"));
		const sessionsRoot = path.join(tmpDir, "agent", "sessions");
		mkdirSync(sessionsRoot, { recursive: true });
		const sessionPath = path.join(sessionsRoot, "session.jsonl");
		const outsidePath = path.join(tmpDir, "outside.jsonl");
		const symlinkPath = path.join(sessionsRoot, "escape.jsonl");
		writeFileSync(sessionPath, "");
		writeFileSync(outsidePath, "");
		symlinkSync(outsidePath, symlinkPath);
		return {
			tmpDir,
			sessionsRoot,
			sessionPath,
			outsidePath,
			symlinkPath,
			sessionPaths: new SessionPathGuard(sessionsRoot),
		};
	}

	it("rejects outside and symlink paths before subscribing", () => {
		const fixture = createFixture();
		try {
			const { handler } = makeHandler({ sessionPaths: fixture.sessionPaths });
			const { ws } = makeWs();
			handler.clients.set(ws, {
				subscribedSession: null,
				lastVersion: 0,
				lastJson: "",
				lastHash: "",
			});

			expect(() => handler.handleSubscribeSession(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "outside",
				type: "subscribe_session",
				sessionPath: fixture.outsidePath,
			})).toThrow("within the Pi sessions directory");
			expect(() => handler.handleSubscribeSession(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "symlink",
				type: "subscribe_session",
				sessionPath: fixture.symlinkPath,
			})).toThrow("escapes the Pi sessions directory");
			expect(() => handler.handleSubscribeSession(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "missing",
				type: "subscribe_session",
				sessionPath: path.join(fixture.sessionsRoot, "missing.jsonl"),
			})).toThrow("Session file not found");
			expect(handler.clients.get(ws)?.subscribedSession).toBeNull();
		} finally {
			rmSync(fixture.tmpDir, { recursive: true, force: true });
		}
	});

	it("subscribes to an actor-owned new path before Pi flushes the file", () => {
		const fixture = createFixture();
		try {
			const pendingPath = path.join(fixture.sessionsRoot, "pending.jsonl");
			const { handler, registry } = makeHandler({ sessionPaths: fixture.sessionPaths });
			attachActor(registry, pendingPath, { id: 42 });
			const { ws, sent } = makeWs();
			handler.clients.set(ws, {
				subscribedSession: null,
				lastVersion: 0,
				lastJson: "",
				lastHash: "",
			});

			handler.handleSubscribeSession(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "pending",
				type: "subscribe_session",
				sessionPath: pendingPath,
			});

			expect(handler.clients.get(ws)?.subscribedSession).toBe(pendingPath);
			expect(sent).toContainEqual(expect.objectContaining({
				type: "session_sync",
				sessionPath: pendingPath,
				op: "full",
			}));
		} finally {
			rmSync(fixture.tmpDir, { recursive: true, force: true });
		}
	});

	it("rejects outside fork sources before acquiring a process or copying", async () => {
		const fixture = createFixture();
		try {
			const { handler, pool } = makeHandler({ sessionPaths: fixture.sessionPaths });
			const { ws } = makeWs();

			await expect(handler.handleFork(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "fork",
				type: "fork",
				sessionPath: fixture.outsidePath,
				entryId: "entry",
			})).rejects.toThrow("within the Pi sessions directory");
			await expect(handler.handleForkPrompt(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "fork-prompt",
				type: "fork_prompt",
				sessionPath: fixture.symlinkPath,
				message: "continue",
			})).rejects.toThrow("escapes the Pi sessions directory");
			expect(pool.acquire).not.toHaveBeenCalled();
		} finally {
			rmSync(fixture.tmpDir, { recursive: true, force: true });
		}
	});

	it("canonicalizes a client path before switching the Pi process", async () => {
		const fixture = createFixture();
		try {
			const proc = { id: 41 };
			const release = vi.fn();
			const acquire = vi.fn(() => ({ process: proc, release }));
			const sendRpcChecked = vi.fn(async () => ({ success: true, data: {} }));
			const sendRpc = vi.fn(async () => ({ success: true, data: {} }));
			const { handler, registry } = makeHandler({
				sessionPaths: fixture.sessionPaths,
				acquire,
				sendRpcChecked,
				sendRpc,
			});
			const { ws } = makeWs();
			const nonCanonicalPath = `${fixture.sessionsRoot}${path.sep}unused${path.sep}..${path.sep}session.jsonl`;

			await handler.handleSetSessionName(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "rename",
				type: "set_session_name",
				sessionPath: nonCanonicalPath,
				name: "renamed",
			});

			expect(sendRpcChecked).toHaveBeenCalledWith(proc, {
				type: "switch_session",
				sessionPath: fixture.sessionPath,
			});
			expect(registry.find(fixture.sessionPath)).toBeDefined();
			expect(registry.find(nonCanonicalPath)).toBeUndefined();
			expect(release).toHaveBeenCalledOnce();
		} finally {
			rmSync(fixture.tmpDir, { recursive: true, force: true });
		}
	});
});

describe("WsHandler slash command discovery", () => {
	it("uses the canonical session cwd for project-scoped commands", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pipane-commands-"));
		try {
			const sessionsRoot = path.join(tmpDir, "agent", "sessions");
			const projectDir = path.join(tmpDir, "project");
			const sessionPath = path.join(sessionsRoot, "session.jsonl");
			mkdirSync(sessionsRoot, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(sessionPath, `${JSON.stringify({ type: "session", cwd: projectDir })}\n`);

			const proc = { id: 51 };
			const release = vi.fn();
			const acquire = vi.fn(() => ({ process: proc, release }));
			const sendRpcChecked = vi.fn(async () => ({
				success: true,
				data: { commands: [{ name: "project-review", source: "prompt" }] },
			}));
			const { handler } = makeHandler({
				sessionPaths: new SessionPathGuard(sessionsRoot),
				acquire,
				sendRpcChecked,
			});
			const { ws, sent } = makeWs();

			await handler.handleGetCommands(ws, {
				protocolVersion: WS_PROTOCOL_VERSION,
				id: "commands",
				type: "get_commands",
				sessionPath: `${sessionsRoot}${path.sep}unused${path.sep}..${path.sep}session.jsonl`,
			});

			expect(acquire).toHaveBeenCalledWith(projectDir);
			expect(sendRpcChecked).toHaveBeenCalledWith(proc, { type: "get_commands" });
			expect(release).toHaveBeenCalledOnce();
			expect(sent).toContainEqual(expect.objectContaining({
				id: "commands",
				success: true,
				data: { commands: [{ name: "project-review", source: "prompt" }] },
			}));
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("uses the selected cwd for a virtual conversation", async () => {
		const proc = { id: 52 };
		const release = vi.fn();
		const acquire = vi.fn(() => ({ process: proc, release }));
		const { handler } = makeHandler({
			acquire,
			sendRpcChecked: vi.fn(async () => ({ success: true, data: { commands: [] } })),
		});
		const { ws } = makeWs();

		await handler.handleGetCommands(ws, {
			protocolVersion: WS_PROTOCOL_VERSION,
			id: "virtual-commands",
			type: "get_commands",
			cwd: "/tmp/project-a",
		});

		expect(acquire).toHaveBeenCalledWith("/tmp/project-a");
		expect(release).toHaveBeenCalledOnce();
	});
});

describe("WsHandler extension statuses", () => {
	it("normalizes and broadcasts session and provider snapshots", () => {
		const { handler, registry, emitProcessEvent } = makeHandler();
		const sessionPath = "/tmp/status.jsonl";
		const proc = { id: 8 };
		attachActor(registry, sessionPath, proc);
		const { ws, sent } = makeWs();
		handler.clients.set(ws, { subscribedSession: sessionPath });

		emitProcessEvent(proc, {
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "provider-usage",
			statusText: "\u001b[39m codex\t25%\n5h",
		});

		expect(sent).toContainEqual({
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "provider_usage",
			statuses: { codex: "codex 25% 5h" },
		});
		expect(sent).toContainEqual({
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "extension_status",
			sessionPath,
			statuses: { "provider-usage": "codex 25% 5h" },
		});
	});

	it("captures statuses only after an explicit pending session switch", () => {
		const { handler, registry, emitProcessEvent } = makeHandler();
		const proc = { id: 9 };
		const event = (statusText: string) => ({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "provider-usage",
			statusText,
		});

		emitProcessEvent(proc, event("stale"));
		expect(handler.extensionStatusesBySession.size).toBe(0);
		handler.beginPendingExtensionStatusCapture(proc);
		emitProcessEvent(proc, event("claude 18% 5h"));
		attachActor(registry, "/tmp/new.jsonl", proc);
		handler.commitPendingExtensionStatuses(proc, "/tmp/new.jsonl");

		expect(handler.makeExtensionStatusMessage("/tmp/new.jsonl").statuses).toEqual({
			"provider-usage": "claude 18% 5h",
		});
	});
});

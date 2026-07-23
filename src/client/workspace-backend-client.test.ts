import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendClient, PiInstallRequiredInfo, SessionInfoDTO } from "./backend-client.js";
import { WorkspaceBackendClient } from "./workspace-backend-client.js";

interface FakeEvents {
	connection: Set<(connected: boolean) => void>;
	extension: Set<() => void>;
	global: Set<() => void>;
	steering: Set<() => void>;
	session: Set<() => void>;
	content: Set<() => void>;
	status: Set<() => void>;
	sessions: Set<(file: string) => void>;
	install: Set<(info: PiInstallRequiredInfo) => void>;
}

function session(id: string, path: string, cwd: string): SessionInfoDTO {
	return {
		id,
		path,
		cwd,
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 1,
		firstMessage: id,
	};
}

function fakeClient(sessions: SessionInfoDTO[], connectError?: Error) {
	const events: FakeEvents = {
		connection: new Set(), extension: new Set(), global: new Set(), steering: new Set(),
		session: new Set(), content: new Set(), status: new Set(), sessions: new Set(), install: new Set(),
	};
	let connected = false;
	let current: SessionInfoDTO | undefined = sessions[0];
	const subscribe = <T extends (...args: any[]) => void>(set: Set<T>, callback: T) => {
		set.add(callback);
		return () => set.delete(callback);
	};
	const client = {
		get state() { return { model: undefined, thinkingLevel: "off", messages: [], isStreaming: false }; },
		get sessionId() { return current?.id ?? "virtual"; },
		get sessionFile() { return current?.path; },
		get sessionName() { return current?.name; },
		get sessionStatus() { return current ? "detached" : "virtual"; },
		get isConnected() { return connected; },
		isReconnecting: false,
		pendingToolCallIds: new Set<string>(), toolCallTimings: {}, steeringQueue: [], extensionStatuses: new Map(),
		get cwd() { return current?.cwd; },
		optimisticSessions: [], virtualSessionInfo: undefined,
		connect: vi.fn(async () => {
			if (connectError) throw connectError;
			connected = true;
			for (const listener of events.connection) listener(true);
		}),
		disconnect: vi.fn(() => { connected = false; }),
		setSessionSubscriptionActive: vi.fn(async () => undefined),
		onConnectionChange: (callback: (connected: boolean) => void) => subscribe(events.connection, callback),
		onExtensionStatusChange: (callback: () => void) => subscribe(events.extension, callback),
		onGlobalStatusChange: (callback: () => void) => subscribe(events.global, callback),
		onSteeringQueueChange: (callback: () => void) => subscribe(events.steering, callback),
		onSessionChange: (callback: () => void) => subscribe(events.session, callback),
		onContentChange: (callback: () => void) => subscribe(events.content, callback),
		onStatusChange: (callback: () => void) => subscribe(events.status, callback),
		onSessionsChanged: (callback: (file: string) => void) => subscribe(events.sessions, callback),
		onPiInstallRequired: (callback: (info: PiInstallRequiredInfo) => void) => subscribe(events.install, callback),
		listSessions: vi.fn(async () => sessions),
		getSessionStatus: vi.fn((path: string) => path === sessions[0]?.path ? "running" : undefined),
		fetchAvailableModels: vi.fn(async () => []),
		loadDefaultModel: vi.fn(async () => undefined),
		switchSession: vi.fn(async (path: string) => {
			current = sessions.find((candidate) => candidate.path === path);
			for (const listener of events.session) listener();
		}),
		newSession: vi.fn(async () => undefined),
		deleteSession: vi.fn(async () => undefined),
		reportError: vi.fn(),
	} as unknown as BackendClient;
	return { client, events };
}

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("WorkspaceBackendClient", () => {
	it("connects authorized hosts and returns one backend-scoped session catalog", async () => {
		const one = fakeClient([session("same", "/sessions/same.jsonl", "/work/project")]);
		const two = fakeClient([session("same", "/sessions/same.jsonl", "/work/project")]);
		const clients = new Map([["b_one", one.client], ["b_two", two.client]]);
		const workspace = new WorkspaceBackendClient([
			{ backendId: "b_one", name: "One", online: true, protocolVersions: [1, 2] },
			{ backendId: "b_two", name: "Two", online: true, protocolVersions: [1, 2] },
		], { getClient: (id) => clients.get(id)!, revokeBackend: vi.fn() });

		await workspace.connect("webrtc");

		expect(one.client.connect).toHaveBeenCalledOnce();
		expect(two.client.connect).toHaveBeenCalledOnce();
		expect(await workspace.listSessions()).toEqual([
			expect.objectContaining({ backendId: "b_one", path: "/sessions/same.jsonl" }),
			expect.objectContaining({ backendId: "b_two", path: "/sessions/same.jsonl" }),
		]);
		expect(workspace.getSessionStatus("/sessions/same.jsonl", "b_two")).toBe("running");
		expect(workspace.workspaceBackends.every((backend) => backend.connected)).toBe(true);
	});

	it("switches the active conversation in place without navigating or conflating equal paths", async () => {
		const one = fakeClient([session("one", "/sessions/shared.jsonl", "/work/one")]);
		const two = fakeClient([session("two", "/sessions/shared.jsonl", "/work/two")]);
		const clients = new Map([["b_one", one.client], ["b_two", two.client]]);
		const workspace = new WorkspaceBackendClient([
			{ backendId: "b_one", name: "One", online: true, protocolVersions: [1, 2] },
			{ backendId: "b_two", name: "Two", online: true, protocolVersions: [1, 2] },
		], { getClient: (id) => clients.get(id)!, revokeBackend: vi.fn() }, "b_one");
		await workspace.connect("webrtc");
		const changed = vi.fn();
		workspace.onSessionChange(changed);

		await workspace.switchSession("/sessions/shared.jsonl", "/work/two", "b_two");

		expect(workspace.activeBackendId).toBe("b_two");
		expect(two.client.fetchAvailableModels).toHaveBeenCalledOnce();
		expect(two.client.switchSession).toHaveBeenCalledWith("/sessions/shared.jsonl", "/work/two");
		expect(one.client.setSessionSubscriptionActive).toHaveBeenCalledWith(false);
		expect(one.client.switchSession).not.toHaveBeenCalled();
		expect(changed).toHaveBeenCalled();
		expect(window.location.pathname).toBe("/");
	});

	it("renders after the first reachable host without waiting for another ICE attempt", async () => {
		const available = fakeClient([session("ok", "/sessions/ok.jsonl", "/work/ok")]);
		const stalled = fakeClient([]);
		stalled.client.connect = vi.fn(() => new Promise<void>(() => {}));
		const clients = new Map([["b_stalled", stalled.client], ["b_ok", available.client]]);
		const workspace = new WorkspaceBackendClient([
			{ backendId: "b_stalled", name: "Stalled", online: true, protocolVersions: [1, 2] },
			{ backendId: "b_ok", name: "Available", online: true, protocolVersions: [1, 2] },
		], { getClient: (id) => clients.get(id)!, revokeBackend: vi.fn() }, "b_stalled");

		await expect(workspace.connect("webrtc")).resolves.toBeUndefined();
		expect(workspace.activeBackendId).toBe("b_ok");
		expect(await workspace.listSessions()).toEqual([
			expect.objectContaining({ backendId: "b_ok", path: "/sessions/ok.jsonl" }),
		]);
	});

	it("keeps the workspace available when one online host cannot connect", async () => {
		const available = fakeClient([session("ok", "/sessions/ok.jsonl", "/work/ok")]);
		const failed = fakeClient([], new Error("host failed"));
		const clients = new Map([["b_ok", available.client], ["b_failed", failed.client]]);
		const getClient = vi.fn((id: string) => clients.get(id)!);
		const workspace = new WorkspaceBackendClient([
			{ backendId: "b_failed", name: "Failed", online: true, protocolVersions: [1, 2] },
			{ backendId: "b_ok", name: "Available", online: true, protocolVersions: [1, 2] },
			{ backendId: "b_old", name: "Old", online: true, protocolVersions: [1] },
		], { getClient, revokeBackend: vi.fn() }, "b_failed");

		await expect(workspace.connect("webrtc")).resolves.toBeUndefined();
		expect(workspace.activeBackendId).toBe("b_ok");
		expect(workspace.workspaceBackends.find((backend) => backend.backendId === "b_failed")?.error).toBe("host failed");
		expect(workspace.workspaceBackends.find((backend) => backend.backendId === "b_old")?.error).toContain("Update required");
		expect(getClient).not.toHaveBeenCalledWith("b_old");
	});

	it("revokes one host and activates a remaining connected host", async () => {
		const one = fakeClient([]);
		const two = fakeClient([]);
		const revokeBackend = vi.fn(async () => undefined);
		const clients = new Map([["b_one", one.client], ["b_two", two.client]]);
		const workspace = new WorkspaceBackendClient([
			{ backendId: "b_one", name: "One", online: true, protocolVersions: [1, 2] },
			{ backendId: "b_two", name: "Two", online: true, protocolVersions: [1, 2] },
		], { getClient: (id) => clients.get(id)!, revokeBackend }, "b_one");
		await workspace.connect("webrtc");

		await workspace.removeBackend("b_one");

		expect(revokeBackend).toHaveBeenCalledWith("b_one");
		expect(workspace.activeBackendId).toBe("b_two");
		expect(workspace.workspaceBackends.map((backend) => backend.backendId)).toEqual(["b_two"]);
	});
});

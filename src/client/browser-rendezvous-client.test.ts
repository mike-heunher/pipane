import { describe, expect, it, vi } from "vitest";
import { RENDEZVOUS_PROTOCOL_VERSION } from "../shared/rendezvous-protocol.js";
import {
	BrowserRendezvousClient,
	type BrowserRendezvousSocket,
} from "./browser-rendezvous-client.js";

class FakeSocket {
	readyState: number = WebSocket.CONNECTING;
	sent: any[] = [];
	onopen: ((event: Event) => unknown) | null = null;
	onerror: ((event: Event) => unknown) | null = null;
	onclose: ((event: CloseEvent) => unknown) | null = null;
	onmessage: ((event: MessageEvent) => unknown) | null = null;
	readonly close = vi.fn(() => {
		this.readyState = WebSocket.CLOSED;
	});

	send(raw: string): void {
		this.sent.push(JSON.parse(raw));
	}

	open(): void {
		this.readyState = WebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	receive(message: Record<string, unknown>): void {
		this.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, ...message }),
		}));
	}
}

function setup() {
	const socket = new FakeSocket();
	const createWebSocket = vi.fn(() => socket as BrowserRendezvousSocket);
	const client = new BrowserRendezvousClient({
		url: "https://signal.example/base?ignored=true",
		backendId: "b_expected",
		ticket: "ticket",
		createWebSocket,
	});
	return { client, socket, createWebSocket };
}

describe("BrowserRendezvousClient", () => {
	it("opens one backend route and relays signals", async () => {
		const { client, socket, createWebSocket } = setup();
		const connecting = client.connect();
		expect(client.connect()).toBe(connecting);
		socket.open();
		expect(createWebSocket).toHaveBeenCalledWith("wss://signal.example/v2/rendezvous/browser");
		expect(socket.sent[0]).toEqual(expect.objectContaining({
			type: "connect_backend",
			backendId: "b_expected",
			ticket: "ticket",
		}));

		socket.receive({ type: "backend_connected", backendId: "b_expected", connectionId: "c_one" });
		await expect(connecting).resolves.toBe("c_one");
		expect(client.activeConnectionId).toBe("c_one");

		const received: unknown[] = [];
		client.onSignal((signal) => received.push(signal));
		const offer = { kind: "description" as const, type: "offer" as const, sdp: "v=0" };
		client.sendSignal(offer);
		expect(socket.sent.at(-1)).toEqual(expect.objectContaining({
			type: "signal",
			connectionId: "c_one",
			signal: offer,
		}));
		socket.receive({ type: "signal", connectionId: "c_one", signal: offer });
		expect(received).toEqual([offer]);
	});

	it("rejects offline connection attempts and surfaces route closure", async () => {
		const { client, socket } = setup();
		const errors: unknown[] = [];
		client.onError((error) => errors.push(error));
		const connecting = client.connect();
		socket.open();
		socket.receive({ type: "error", code: "backend_offline", message: "offline" });
		await expect(connecting).rejects.toThrow("offline");
		expect(errors).toHaveLength(1);

		const reconnecting = client.connect();
		socket.receive({ type: "backend_connected", backendId: "b_expected", connectionId: "c_two" });
		await reconnecting;
		const closed = vi.fn();
		client.onConnectionClosed(closed);
		socket.receive({ type: "connection_closed", connectionId: "c_two", reason: "backend gone" });
		expect(closed).toHaveBeenCalledWith("backend gone");
		expect(client.activeConnectionId).toBeUndefined();
	});

	it("rejects unexpected backend identities and disconnected sends", async () => {
		const { client, socket } = setup();
		expect(() => client.sendSignal({ kind: "description", type: "offer", sdp: "v=0" })).toThrow("not connected");
		const connecting = client.connect();
		socket.open();
		socket.receive({ type: "backend_connected", backendId: "b_other", connectionId: "c_wrong" });
		await expect(connecting).rejects.toThrow("unexpected backend");
		expect(socket.close).toHaveBeenCalledWith(1002, "Backend identity mismatch");
	});
});

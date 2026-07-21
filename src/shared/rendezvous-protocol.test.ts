import { describe, expect, it } from "vitest";
import {
	RENDEZVOUS_PROTOCOL_VERSION,
	backendRegistrationPayload,
	decodeBackendCommand,
	decodeBackendMessage,
	decodeBrowserCommand,
	decodeBrowserMessage,
	encodeRendezvousMessage,
	rendezvousWebSocketUrl,
} from "./rendezvous-protocol.js";

function wire(message: Record<string, unknown>): string {
	return JSON.stringify({ protocolVersion: RENDEZVOUS_PROTOCOL_VERSION, ...message });
}

describe("rendezvous protocol", () => {
	it("validates backend registration and signaling commands", () => {
		expect(decodeBackendCommand(wire({
			type: "register_backend",
			publicKey: "public-key",
			signature: "signature",
			metadata: { name: "workstation", softwareVersion: "1.0.0", protocolVersions: [1] },
		})).ok).toBe(true);
		expect(decodeBackendCommand(wire({
			type: "signal",
			connectionId: "connection",
			signal: { kind: "description", type: "answer", sdp: "v=0" },
		})).ok).toBe(true);
		expect(decodeBackendCommand(wire({
			type: "close_connection",
			connectionId: "connection",
			reason: "done",
		})).ok).toBe(true);
	});

	it("validates browser connection and candidate commands", () => {
		expect(decodeBrowserCommand(wire({ type: "connect_backend", backendId: "b_backend" })).ok).toBe(true);
		expect(decodeBrowserCommand(wire({
			type: "signal",
			connectionId: "connection",
			signal: { kind: "candidate", candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
		})).ok).toBe(true);
	});

	it("validates role-specific server messages", () => {
		expect(decodeBackendMessage(wire({ type: "challenge", nonce: "nonce" })).ok).toBe(true);
		expect(decodeBackendMessage(wire({ type: "registered", backendId: "b_backend" })).ok).toBe(true);
		expect(decodeBackendMessage(wire({ type: "connection_request", connectionId: "connection" })).ok).toBe(true);
		expect(decodeBrowserMessage(wire({
			type: "backend_connected",
			backendId: "b_backend",
			connectionId: "connection",
		})).ok).toBe(true);
		expect(decodeBrowserMessage(wire({
			type: "connection_closed",
			connectionId: "connection",
			reason: "offline",
		})).ok).toBe(true);
		expect(decodeBrowserMessage(wire({
			type: "error",
			code: "backend_offline",
			message: "offline",
		})).ok).toBe(true);
	});

	it("rejects malformed, cross-role, unknown, and unsupported messages", () => {
		expect(decodeBackendCommand("{")).toEqual(expect.objectContaining({
			ok: false,
			error: expect.objectContaining({ code: "invalid_json" }),
		}));
		expect(decodeBrowserCommand(JSON.stringify({ type: "connect_backend", backendId: "b" }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unsupported_version" }) }),
		);
		expect(decodeBrowserCommand(wire({ type: "register_backend" }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unknown_message" }) }),
		);
		expect(decodeBackendCommand(wire({ type: "signal", connectionId: "c", signal: { kind: "candidate" } }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid_message" }) }),
		);
		expect(decodeBackendMessage(wire({ type: "mystery" }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unknown_message" }) }),
		);
	});

	it("uses domain-separated registration payloads and canonical signaling URLs", () => {
		expect(backendRegistrationPayload("abc")).toBe("pipane-rendezvous-v1\nabc");
		expect(JSON.parse(encodeRendezvousMessage({ type: "test" }))).toEqual({ type: "test" });
		expect(rendezvousWebSocketUrl("https://signal.example/base?q=1#fragment", "backend"))
			.toBe("wss://signal.example/v1/rendezvous/backend");
		expect(rendezvousWebSocketUrl("http://localhost:8787", "browser"))
			.toBe("ws://localhost:8787/v1/rendezvous/browser");
		expect(() => rendezvousWebSocketUrl("ftp://signal.example", "backend")).toThrow("Unsupported");
	});
});

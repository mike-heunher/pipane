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

const binding = {
	version: 1,
	backendId: "b_backend",
	publicKey: "public-key",
	connectionId: "connection",
	offerSha256: "offer-hash",
	answerSha256: "answer-hash",
	dtlsFingerprint: "sha-256 AA:BB",
	expiresAt: 1234,
	signature: "signature",
};

describe("rendezvous protocol", () => {
	it("validates authenticated backend registration, pairing, and signaling commands", () => {
		expect(decodeBackendCommand(wire({
			type: "register_backend",
			publicKey: "public-key",
			signature: "signature",
			metadata: { name: "workstation", softwareVersion: "1.0.0", protocolVersions: [1] },
		})).ok).toBe(true);
		expect(decodeBackendCommand(wire({ type: "open_pairing", pairId: "pair_one", expiresAt: 1234 })).ok).toBe(true);
		expect(decodeBackendCommand(wire({ type: "confirm_pairing", connectionId: "connection" })).ok).toBe(true);
		expect(decodeBackendCommand(wire({
			type: "signal",
			connectionId: "connection",
			signal: { kind: "description", type: "answer", sdp: "v=0" },
		})).ok).toBe(true);
		expect(decodeBackendCommand(wire({ type: "connection_binding", connectionId: "connection", binding })).ok).toBe(true);
	});

	it("requires a signed ticket for browser routes and validates candidates", () => {
		expect(decodeBrowserCommand(wire({ type: "connect_backend", backendId: "b_backend", ticket: "ticket" })).ok).toBe(true);
		expect(decodeBrowserCommand(wire({
			type: "connect_backend",
			backendId: "b_backend",
			ticket: "ticket",
			iceServers: [{ urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:443?transport=tcp"], username: "temporary", credential: "secret" }],
		})).ok).toBe(true);
		expect(decodeBrowserCommand(wire({
			type: "connect_backend",
			backendId: "b_backend",
			ticket: "ticket",
			iceServers: [{ urls: "stun:stun.example:3478" }],
		})).ok).toBe(false);
		expect(decodeBrowserCommand(wire({ type: "connect_backend", backendId: "b_backend" })).ok).toBe(false);
		expect(decodeBrowserCommand(wire({
			type: "signal",
			connectionId: "connection",
			signal: { kind: "candidate", candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
		})).ok).toBe(true);
	});

	it("validates role-specific trust messages", () => {
		expect(decodeBackendMessage(wire({ type: "challenge", nonce: "nonce" })).ok).toBe(true);
		expect(decodeBackendMessage(wire({
			type: "registered",
			backendId: "b_backend",
			ticketPublicKey: "ticket-key",
			iceServers: [{ urls: ["turn:example:3478"], username: "user", credential: "pass" }],
		})).ok).toBe(true);
		expect(decodeBackendMessage(wire({
			type: "connection_request",
			connectionId: "connection",
			ticket: "ticket",
			iceServers: [],
		})).ok).toBe(true);
		expect(decodeBackendMessage(wire({
			type: "pairing_confirmed",
			connectionId: "connection",
			pairId: "pair_one",
			accountId: "a_owner",
			deviceId: "d_device",
		})).ok).toBe(true);
		expect(decodeBackendMessage(wire({ type: "authorization_revoked", accountId: "a_owner", deviceId: "d_device" })).ok).toBe(true);
		expect(decodeBrowserMessage(wire({ type: "backend_connected", backendId: "b_backend", connectionId: "connection" })).ok).toBe(true);
		expect(decodeBrowserMessage(wire({ type: "connection_binding", connectionId: "connection", binding })).ok).toBe(true);
	});

	it("rejects malformed, cross-role, unknown, and unsupported messages", () => {
		expect(decodeBackendCommand("{")).toEqual(expect.objectContaining({
			ok: false,
			error: expect.objectContaining({ code: "invalid_json" }),
		}));
		expect(decodeBrowserCommand(JSON.stringify({ type: "connect_backend", backendId: "b", ticket: "t" }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unsupported_version" }) }),
		);
		expect(decodeBrowserCommand(wire({ type: "register_backend" }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unknown_message" }) }),
		);
		expect(decodeBackendCommand(wire({ type: "signal", connectionId: "c", signal: { kind: "candidate" } }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid_message" }) }),
		);
		expect(decodeBrowserCommand(wire({ type: "connection_binding", connectionId: "c", binding }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unknown_message" }) }),
		);
		expect(decodeBackendMessage(wire({ type: "mystery" }))).toEqual(
			expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unknown_message" }) }),
		);
	});

	it("uses domain-separated v2 registration payloads and canonical role URLs", () => {
		expect(backendRegistrationPayload("abc")).toBe("pipane-rendezvous-v2\nabc");
		expect(JSON.parse(encodeRendezvousMessage({ type: "test" }))).toEqual({ type: "test" });
		expect(rendezvousWebSocketUrl("https://signal.example/base?q=1#fragment", "backend"))
			.toBe("wss://signal.example/v2/rendezvous/backend");
		expect(rendezvousWebSocketUrl("http://localhost:8787", "browser"))
			.toBe("ws://localhost:8787/v2/rendezvous/browser");
		expect(() => rendezvousWebSocketUrl("ftp://signal.example", "backend")).toThrow("Unsupported");
	});
});

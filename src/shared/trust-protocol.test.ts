import { describe, expect, it } from "vitest";
import {
	backendIdentityBindingPayload,
	connectionTicketSignaturePayload,
	decodeDataChannelAuthenticateFrame,
	deviceChallengePayload,
	deviceConnectionProofPayload,
	parseConnectionTicketClaims,
} from "./trust-protocol.js";

describe("trust protocol", () => {
	it("uses fixed domain-separated signing payloads", () => {
		expect(deviceChallengePayload({
			version: 1,
			challengeId: "ch_one",
			nonce: "nonce",
			purpose: "pair",
			deviceId: "d_device",
			devicePublicKey: "public-key",
			backendId: "b_backend",
			connectionId: "c_one",
			pairId: "pair_one",
			expiresAt: 1234,
		})).toBe("pipane-device-challenge-v1\nch_one\nnonce\npair\nd_device\npublic-key\nb_backend\nc_one\npair_one\n\n1234");
		expect(connectionTicketSignaturePayload("claims")).toBe("pipane-connection-ticket-v1\nclaims");
		expect(deviceConnectionProofPayload("ticket", "binding")).toBe("pipane-device-connection-v1\nticket\nbinding");
		expect(backendIdentityBindingPayload({
			version: 1,
			backendId: "b_backend",
			publicKey: "public-key",
			connectionId: "c_one",
			offerSha256: "offer",
			answerSha256: "answer",
			dtlsFingerprint: "sha-256 AA:BB",
			expiresAt: 1234,
		})).toContain("pipane-backend-binding-v1\n");
	});

	it("validates ticket claim invariants", () => {
		const claims = {
			version: 1,
			kind: "pairing",
			ticketId: "t_one",
			backendId: "b_backend",
			connectionId: "c_one",
			deviceId: "d_device",
			devicePublicKey: "public-key",
			pairId: "pair_one",
			issuedAt: 100,
			expiresAt: 200,
		};
		expect(parseConnectionTicketClaims(claims)).toEqual(claims);
		expect(parseConnectionTicketClaims({ ...claims, pairId: undefined })).toBeUndefined();
		expect(parseConnectionTicketClaims({ ...claims, kind: "connection", accountId: undefined })).toBeUndefined();
		expect(parseConnectionTicketClaims({ ...claims, expiresAt: 100 })).toBeUndefined();
	});

	it("accepts only the bounded first DataChannel authentication frame", () => {
		const frame = {
			protocolVersion: 1,
			type: "authenticate",
			ticket: "ticket",
			bindingSignature: "binding",
			deviceSignature: "device",
			pairingSecret: "secret",
		};
		expect(decodeDataChannelAuthenticateFrame(JSON.stringify(frame))).toEqual(frame);
		expect(decodeDataChannelAuthenticateFrame("{")).toBeUndefined();
		expect(decodeDataChannelAuthenticateFrame(JSON.stringify({ ...frame, protocolVersion: 2 }))).toBeUndefined();
		expect(decodeDataChannelAuthenticateFrame(JSON.stringify({ ...frame, ticket: "" }))).toBeUndefined();
	});
});

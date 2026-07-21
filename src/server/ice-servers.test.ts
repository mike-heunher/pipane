// @vitest-environment node

import { describe, expect, it } from "vitest";
import { toNodeIceServers } from "./ice-servers.js";

describe("toNodeIceServers", () => {
	it("maps STUN plus UDP, TCP, and TLS TURN URLs", () => {
		expect(toNodeIceServers([
			{ urls: "stun:stun.example:3478" },
			{
				urls: [
					"turn:turn.example:3478?transport=udp",
					"turn:turn.example:443?transport=tcp",
					"turns:[2001:db8::1]:443",
				],
				username: "user",
				credential: "password",
			},
		])).toEqual([
			"stun:stun.example:3478",
			{ hostname: "turn.example", port: 3478, username: "user", password: "password", relayType: "TurnUdp" },
			{ hostname: "turn.example", port: 443, username: "user", password: "password", relayType: "TurnTcp" },
			{ hostname: "2001:db8::1", port: 443, username: "user", password: "password", relayType: "TurnTls" },
		]);
	});

	it("rejects unsupported server schemes", () => {
		expect(() => toNodeIceServers([{ urls: "https://turn.example" }])).toThrow("Unsupported ICE server URL");
	});
});

import "fake-indexeddb/auto";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TurnRelayConfigurationError,
	TurnRelayStore,
	parseStaticIceServers,
	resolveTurnRelayIceServers,
	testTurnRelayProfile,
	validateTurnRelayProfile,
	type TurnRelayProfile,
} from "./turn-relay.js";

const databases: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(databases.splice(0).map((name) => new Promise<void>((resolve) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	})));
});

describe("TURN relay profiles", () => {
	it("stores, validates, and removes a browser-local profile", async () => {
		const databaseName = `pipane-turn-test-${crypto.randomUUID()}`;
		databases.push(databaseName);
		const store = new TurnRelayStore(databaseName);
		const profile: TurnRelayProfile = {
			version: 1,
			kind: "static",
			iceServers: [{
				urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:443?transport=tcp"],
				username: "user",
				credential: "password",
			}],
		};
		await store.save(profile);
		await expect(store.load()).resolves.toEqual(profile);
		await store.clear();
		await expect(store.load()).resolves.toBeUndefined();
	});

	it("generates expiring coturn REST credentials without exposing the shared secret", async () => {
		const profile = validateTurnRelayProfile({
			version: 1,
			kind: "coturn-rest",
			urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:443?transport=tcp"],
			sharedSecret: "rest-secret",
			ttlSeconds: 300,
		});
		const [server] = await resolveTurnRelayIceServers(profile, "d_browser", { now: () => 1_000_000 });
		expect(server.username).toBe("1300:d_browser");
		expect(server.credential).toBe(createHmac("sha1", "rest-secret").update("1300:d_browser").digest("base64"));
		expect(JSON.stringify(server)).not.toContain("rest-secret");
	});

	it("requests temporary Metered credentials from the documented application endpoint", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
			iceServers: [{
				urls: ["turn:global.relay.metered.ca:80?transport=udp", "turns:global.relay.metered.ca:443?transport=tcp"],
				username: "temporary",
				credential: "temporary-password",
			}],
		}), { status: 200, headers: { "content-type": "application/json" } }));
		const servers = await resolveTurnRelayIceServers({
			version: 1,
			kind: "metered",
			application: "my-pipane.metered.live",
			apiKey: "dedicated-key",
		}, "d_browser", { fetch: fetchMock });
		expect(servers[0]).toEqual(expect.objectContaining({ username: "temporary" }));
		const requested = new URL(String(fetchMock.mock.calls[0][0]));
		expect(requested.origin).toBe("https://my-pipane.metered.live");
		expect(requested.pathname).toBe("/api/v1/turn/credentials");
		expect(requested.searchParams.get("apiKey")).toBe("dedicated-key");
	});

	it("rejects STUN-only, malformed, and unsafe credential shapes", () => {
		expect(() => parseStaticIceServers(JSON.stringify({ iceServers: [{ urls: "stun:stun.example:3478" }] })))
			.toThrow("At least one turn:");
		expect(() => validateTurnRelayProfile({ version: 1, kind: "metered", application: "https://not-metered.example", apiKey: "key" }))
			.toThrow("Metered application name");
		expect(() => validateTurnRelayProfile({
			version: 1,
			kind: "coturn-rest",
			urls: ["turn:turn.example:3478"],
			sharedSecret: "secret",
			ttlSeconds: 1,
		})).toThrow("between 60 and 86400");
	});

	it("surfaces provider authentication failures without including the API key", async () => {
		const error = await resolveTurnRelayIceServers({
			version: 1,
			kind: "metered",
			application: "my-pipane",
			apiKey: "do-not-leak",
		}, "d_browser", { fetch: async () => new Response("denied", { status: 403 }) }).catch((reason) => reason);
		expect(error).toBeInstanceOf(TurnRelayConfigurationError);
		expect(error.message).toBe("Metered rejected the TURN API key");
		expect(error.message).not.toContain("do-not-leak");
	});

	it("tests for an observable relay-only ICE candidate", async () => {
		const close = vi.fn();
		const peer = {
			iceGatheringState: "gathering",
			onicecandidate: null as ((event: RTCPeerConnectionIceEvent) => unknown) | null,
			createDataChannel: vi.fn(),
			createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0" })),
			setLocalDescription: vi.fn(async () => {
				queueMicrotask(() => peer.onicecandidate?.({
					candidate: {
						type: "relay",
						candidate: "candidate:1 1 udp 1 203.0.113.1 50000 typ relay",
						protocol: "udp",
						url: "turn:turn.example:3478?transport=udp",
					} as unknown as RTCIceCandidate,
				} as RTCPeerConnectionIceEvent));
			}),
			close,
		};
		const result = await testTurnRelayProfile({
			version: 1,
			kind: "static",
			iceServers: [{ urls: "turn:turn.example:3478?transport=udp", username: "user", credential: "pass" }],
		}, "d_browser", { createPeerConnection: () => peer as unknown as RTCPeerConnection });
		expect(result).toEqual(expect.objectContaining({ protocol: "udp", url: "turn:turn.example:3478?transport=udp" }));
		expect(close).toHaveBeenCalledOnce();
	});
});

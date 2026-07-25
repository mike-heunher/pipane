import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnostics } from "./frame-transport.js";
import { openConnectionDiagnosticsDialog } from "./connection-diagnostics-dialog.js";

const diagnostics: ConnectionDiagnostics = {
	collectedAt: "2026-07-22T18:00:00.000Z",
	carrier: "webrtc",
	backendId: "b_backend",
	rendezvousUrl: "https://pipane.dev",
	signalingUrl: "wss://pipane.dev/v2/rendezvous/browser",
	connectionState: "connected",
	iceConnectionState: "connected",
	iceGatheringState: "complete",
	signalingState: "stable",
	dtlsState: "connected",
	icePath: "direct-stun",
	iceServerUrls: ["stun:stun.cloudflare.com:3478"],
	selectedPair: {
		state: "succeeded",
		nominated: true,
		currentRoundTripTimeMs: 18,
		availableOutgoingBitrate: 3_200_000,
		bytesSent: 8_192,
		bytesReceived: 16_384,
		local: {
			id: "local",
			scope: "local",
			address: "203.0.113.4",
			port: 51_234,
			protocol: "udp",
			candidateType: "srflx",
			relatedAddress: "192.168.1.4",
			relatedPort: 51_234,
			url: "stun:stun.cloudflare.com:3478",
		},
		remote: {
			id: "remote",
			scope: "remote",
			address: "198.51.100.7",
			port: 49_000,
			protocol: "udp",
			candidateType: "host",
		},
	},
	candidates: [],
	dataChannel: {
		state: "open",
		label: "pipane",
		protocol: "pipane.v1",
		ordered: true,
		bufferedAmount: 0,
		maxMessageSize: 262_144,
		messagesSent: 12,
		messagesReceived: 20,
		bytesSent: 8_192,
		bytesReceived: 16_384,
	},
};

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
});

describe("connection diagnostics dialog", () => {
	it("shows the selected STUN path and copies a sanitized snapshot", async () => {
		const writeText = vi.fn(async () => undefined);
		const getDiagnostics = vi.fn(async () => diagnostics);
		const closed = openConnectionDiagnosticsDialog({
			backendName: "piweb",
			backendId: "b_backend",
			getDiagnostics,
			clipboard: { writeText },
			refreshIntervalMs: 60_000,
		});

		await vi.waitFor(() => expect(document.querySelector("[data-testid='connection-diagnostics']")?.textContent)
			.toContain("Direct via STUN"));
		const text = document.querySelector("[data-testid='connection-diagnostics']")?.textContent ?? "";
		expect(text).toContain("stun:stun.cloudflare.com:3478");
		expect(text).toContain("203.0.113.4:51234");
		expect(text).toContain("18 ms");
		expect(text).toContain("256.0 KiB");

		const copy = [...document.querySelectorAll("button")].find((item) => item.textContent === "Copy") as HTMLButtonElement;
		copy.click();
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(diagnostics, null, 2)));

		(document.querySelector("[aria-label='Close connection diagnostics']") as HTMLButtonElement).click();
		await closed;
		expect(document.querySelector("[data-testid='connection-diagnostics']")).toBeNull();
	});
});

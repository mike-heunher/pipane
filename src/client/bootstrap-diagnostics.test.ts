import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendClient } from "./backend-client.js";
import { BootstrapDiagnosticsController } from "./bootstrap-diagnostics-panel.js";
import type { ConnectionDiagnostics } from "./frame-transport.js";

const connection: ConnectionDiagnostics = {
	collectedAt: "2026-08-02T20:00:00.000Z",
	carrier: "webrtc",
	backendId: "b_phone",
	rendezvousUrl: "https://preview.pipane.dev",
	signalingUrl: "wss://preview.pipane.dev/v1/connect",
	connectionState: "connecting",
	iceConnectionState: "checking",
	iceGatheringState: "complete",
	signalingState: "stable",
	icePath: "unknown",
	iceServerUrls: ["stun:stun.example:3478"],
	candidates: [],
	dataChannel: { state: "connecting", bufferedAmount: 0 },
};

function remoteClient(diagnostics: ConnectionDiagnostics = connection): BackendClient {
	return {
		activeBackendId: "b_phone",
		workspaceBackends: [{
			backendId: "b_phone",
			name: "phone backend",
			softwareVersion: "0.1.16",
			protocolVersions: [1, 2],
			online: true,
			connected: false,
			reconnecting: false,
		}],
		onConnectionChange: vi.fn(() => vi.fn()),
		onWorkspaceChange: vi.fn(() => vi.fn()),
		getBackendConnectionDiagnostics: vi.fn(async () => diagnostics),
	} as unknown as BackendClient;
}

beforeEach(() => {
	document.body.replaceChildren();
});

describe("BootstrapDiagnosticsController", () => {
	it("does nothing when the preview build flag is disabled", () => {
		const diagnostics = new BootstrapDiagnosticsController({ enabled: false, document });
		diagnostics.mark("Connecting to backend");
		diagnostics.fail(new Error("ICE failed"));

		expect(document.querySelector("[data-testid='bootstrap-diagnostics']")).toBeNull();
		expect(diagnostics.collectReport().entries).toEqual([]);
	});

	it("tracks startup stages and polls sanitized WebRTC state while visible", async () => {
		let now = Date.parse("2026-08-02T20:00:00.000Z");
		const diagnostics = new BootstrapDiagnosticsController({
			enabled: true,
			document,
			now: () => now,
			refreshIntervalMs: 60_000,
		});
		const client = remoteClient();
		try {
			diagnostics.mark("Discovering authorized backends");
			now += 1_250;
			diagnostics.event("Backend discovery complete", "1 authorized backend");
			diagnostics.attachClient(client);
			diagnostics.mark("Connecting to backend");

			await vi.waitFor(() => expect(diagnostics.collectReport().connection).toEqual(connection));
			const report = diagnostics.collectReport();
			expect(report).toMatchObject({
				stage: "Connecting to backend",
				failed: false,
				backends: [{ backendId: "b_phone", connected: false, online: true }],
			});
			expect(report.entries[0]).toMatchObject({
				label: "Discovering authorized backends",
				durationMs: 1_250,
			});
			expect(document.querySelector("[data-testid='bootstrap-diagnostics']")?.textContent).toContain("TURN not configured");
			expect(client.getBackendConnectionDiagnostics).toHaveBeenCalledWith("b_phone");
		} finally {
			diagnostics.complete();
		}
		expect(document.querySelector("[data-testid='bootstrap-diagnostics']")).toBeNull();
	});

	it("keeps failures actionable and copies only the explicit local report", async () => {
		const writeText = vi.fn(async (_value: string) => undefined);
		const diagnostics = new BootstrapDiagnosticsController({
			enabled: true,
			document,
			clipboard: { writeText },
			refreshIntervalMs: 60_000,
		});
		try {
			diagnostics.attachClient(remoteClient());
			diagnostics.mark("Connecting to backend");
			diagnostics.fail(Object.assign(new Error("No direct ICE path"), { ticket: "must-not-appear" }));

			await vi.waitFor(() => expect(diagnostics.collectReport().connection).toBeDefined());
			const panel = document.querySelector("[data-testid='bootstrap-diagnostics']")!;
			expect(panel.textContent).toContain("Failed: No direct ICE path");
			expect(panel.textContent).toContain("Configure TURN");
			(panel.querySelector("button") as HTMLButtonElement).click();
			await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
			const copied = writeText.mock.calls[0][0];
			expect(JSON.parse(copied)).toMatchObject({
				failed: true,
				error: { name: "Error", message: "No direct ICE path" },
			});
			expect(copied).not.toContain("must-not-appear");
			expect(copied).not.toContain("credential");
		} finally {
			diagnostics.complete();
		}
	});
});

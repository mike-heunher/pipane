// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { IceSignal } from "../shared/rendezvous-protocol.js";
import {
	BackendWebRtcManager,
	PIPANE_DATA_CHANNEL_LABEL,
	PIPANE_DATA_CHANNEL_PROTOCOL,
	type BackendSignalingClient,
} from "./backend-webrtc.js";

class FakeSignaling implements BackendSignalingClient {
	private connectionListener?: (connectionId: string) => void;
	private signalListener?: (connectionId: string, signal: IceSignal) => void;
	private closedListener?: (connectionId: string, reason: string) => void;
	readonly sendSignal = vi.fn();
	readonly closeConnection = vi.fn();

	onConnectionRequest(listener: (connectionId: string) => void): () => void {
		this.connectionListener = listener;
		return () => { this.connectionListener = undefined; };
	}

	onSignal(listener: (connectionId: string, signal: IceSignal) => void): () => void {
		this.signalListener = listener;
		return () => { this.signalListener = undefined; };
	}

	onConnectionClosed(listener: (connectionId: string, reason: string) => void): () => void {
		this.closedListener = listener;
		return () => { this.closedListener = undefined; };
	}

	request(connectionId: string): void {
		this.connectionListener?.(connectionId);
	}

	signal(connectionId: string, signal: IceSignal): void {
		this.signalListener?.(connectionId, signal);
	}

	close(connectionId: string, reason: string): void {
		this.closedListener?.(connectionId, reason);
	}
}

describe("BackendWebRtcManager", () => {
	it("rejects signals for unknown connections", async () => {
		const signaling = new FakeSignaling();
		const manager = new BackendWebRtcManager({ signaling });

		signaling.signal("missing", { kind: "description", type: "offer", sdp: "v=0" });

		expect(signaling.closeConnection).toHaveBeenCalledWith("missing", "Unknown backend WebRTC connection");
		manager.close();
	});

	it("serializes negotiation failures and closes their peer", async () => {
		const signaling = new FakeSignaling();
		const manager = new BackendWebRtcManager({ signaling });
		const error = new Promise<Error>((resolve) => manager.onError((_connectionId, value) => resolve(value)));
		signaling.request("connection");

		signaling.signal("connection", { kind: "description", type: "answer", sdp: "v=0" });

		expect((await error).message).toContain("expected an offer");
		expect(signaling.closeConnection).toHaveBeenCalledWith("connection", "WebRTC negotiation failed");
		signaling.close("connection", "done");
		manager.close();
	});

	it("publishes the required ordered application channel identity", () => {
		expect(PIPANE_DATA_CHANNEL_LABEL).toBe("pipane");
		expect(PIPANE_DATA_CHANNEL_PROTOCOL).toBe("pipane.v1");
	});
});

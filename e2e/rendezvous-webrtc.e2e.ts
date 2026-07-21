import { expect, test } from "@playwright/test";
import nodeDataChannel from "node-datachannel";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreateBackendIdentity } from "../src/server/backend-identity.js";
import { BackendRendezvousClient, rendezvousWebSocketUrl } from "../src/server/rendezvous-client.js";
import {
	BackendWebRtcManager,
	PIPANE_DATA_CHANNEL_LABEL,
	PIPANE_DATA_CHANNEL_PROTOCOL,
} from "../src/server/backend-webrtc.js";
import { RENDEZVOUS_PROTOCOL_VERSION } from "../src/shared/rendezvous-protocol.js";
import { createRendezvousServer } from "../src/rendezvous/server.js";

test("relays signaling into a real browser-to-backend DataChannel", async ({ page }) => {
	const dir = mkdtempSync(path.join(tmpdir(), "pipane-webrtc-e2e-"));
	const rendezvous = createRendezvousServer();
	const port = await rendezvous.listen();
	const baseUrl = `http://127.0.0.1:${port}`;
	const identity = loadOrCreateBackendIdentity(path.join(dir, "identity.json"));
	const signaling = new BackendRendezvousClient({
		url: baseUrl,
		identity,
		metadata: { softwareVersion: "test", protocolVersions: [1] },
	});
	const peers = new BackendWebRtcManager({
		signaling,
		bindAddress: "127.0.0.1",
	});
	peers.onDataChannel((_connectionId, channel) => {
		channel.onMessage((message) => {
			if (message.toString() === "ping") channel.sendMessage("pong");
		});
	});

	try {
		await signaling.start();
		const result = await page.evaluate(async ({ wsUrl, backendId, protocolVersion, label, protocol }) => {
			return new Promise<{ reply: string; ordered: boolean }>((resolve, reject) => {
				const socket = new WebSocket(wsUrl);
				const peer = new RTCPeerConnection();
				const channel = peer.createDataChannel(label, { ordered: true, protocol });
				let connectionId = "";
				const pendingCandidates: RTCIceCandidateInit[] = [];

				const send = (message: object) => socket.send(JSON.stringify({ protocolVersion, ...message }));
				peer.onicecandidate = (event) => {
					if (!event.candidate || !connectionId) return;
					const candidate = event.candidate.toJSON();
					send({
						type: "signal",
						connectionId,
						signal: {
							kind: "candidate",
							candidate: candidate.candidate,
							sdpMid: candidate.sdpMid,
							sdpMLineIndex: candidate.sdpMLineIndex,
						},
					});
				};
				channel.onopen = () => channel.send("ping");
				channel.onmessage = (event) => {
					resolve({ reply: String(event.data), ordered: channel.ordered });
					channel.close();
					peer.close();
					socket.close();
				};
				channel.onerror = () => reject(new Error("DataChannel failed"));
				socket.onerror = () => reject(new Error("Rendezvous WebSocket failed"));
				socket.onopen = () => send({ type: "connect_backend", backendId });
				socket.onmessage = async (event) => {
					const message = JSON.parse(String(event.data));
					if (message.type === "error" || message.type === "connection_closed") {
						reject(new Error(message.message || message.reason));
						return;
					}
					if (message.type === "backend_connected") {
						connectionId = message.connectionId;
						const offer = await peer.createOffer();
						await peer.setLocalDescription(offer);
						send({
							type: "signal",
							connectionId,
							signal: { kind: "description", type: "offer", sdp: offer.sdp },
						});
						return;
					}
					if (message.type !== "signal") return;
					if (message.signal.kind === "description") {
						await peer.setRemoteDescription(message.signal);
						for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
					} else {
						const candidate = {
							candidate: message.signal.candidate,
							sdpMid: message.signal.sdpMid,
							sdpMLineIndex: message.signal.sdpMLineIndex,
						};
						if (peer.remoteDescription) await peer.addIceCandidate(candidate);
						else pendingCandidates.push(candidate);
					}
				};
			});
		}, {
			wsUrl: rendezvousWebSocketUrl(baseUrl, "browser"),
			backendId: identity.backendId,
			protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
			label: PIPANE_DATA_CHANNEL_LABEL,
			protocol: PIPANE_DATA_CHANNEL_PROTOCOL,
		});

		expect(result).toEqual({ reply: "pong", ordered: true });
	} finally {
		peers.close();
		signaling.stop();
		await rendezvous.close();
		nodeDataChannel.cleanup();
		await rm(dir, { recursive: true, force: true });
	}
});

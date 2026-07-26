import { loadOrCreateBrowserDeviceIdentity, type BrowserDeviceIdentity } from "./device-identity.js";
import { parsePairingUrl, RendezvousTrustApi } from "./rendezvous-trust-api.js";
import { WebRtcFrameTransport } from "./webrtc-frame-transport.js";
import { connectionFailureDetails } from "./frame-transport.js";
import { resolveStoredTurnRelayIceServers } from "./turn-relay.js";
import { openTurnRelayDialog } from "./turn-relay-dialog.js";
import type { IceServerConfiguration } from "../shared/trust-protocol.js";

interface PairingTransport {
	connect(endpoint: string): Promise<void>;
	close(code?: number, reason?: string): void;
}

export interface PairingPageDependencies {
	loadIdentity: () => Promise<BrowserDeviceIdentity>;
	createTrustApi: () => Pick<RendezvousTrustApi, "createPairingTicket">;
	createTransport: (options: ConstructorParameters<typeof WebRtcFrameTransport>[0]) => PairingTransport;
	resolveTurnIceServers?: (subject: string) => Promise<IceServerConfiguration[]>;
	openRelayDialog?: typeof openTurnRelayDialog;
}

const defaultDependencies: PairingPageDependencies = {
	loadIdentity: () => loadOrCreateBrowserDeviceIdentity(),
	createTrustApi: () => new RendezvousTrustApi(window.location.origin),
	createTransport: (options) => new WebRtcFrameTransport(options),
};

export async function initializePairingPage(
	dependencies: PairingPageDependencies = defaultDependencies,
): Promise<void> {
	const root = document.getElementById("app") ?? document.body;
	root.replaceChildren();
	const shell = document.createElement("main");
	Object.assign(shell.style, {
		minHeight: "100vh",
		display: "grid",
		placeItems: "center",
		padding: "24px",
		background: "var(--background, #fff)",
		color: "var(--foreground, #111827)",
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
	});
	const card = document.createElement("section");
	Object.assign(card.style, {
		width: "min(460px, 100%)",
		border: "1px solid var(--border, #d1d5db)",
		borderRadius: "12px",
		padding: "28px",
		boxShadow: "0 18px 45px rgba(0, 0, 0, 0.10)",
		background: "var(--card, #fff)",
	});
	const title = document.createElement("h1");
	title.textContent = "Pair this browser";
	Object.assign(title.style, { margin: "0 0 8px", fontSize: "24px" });
	const description = document.createElement("p");
	description.textContent = "pipane will create a private device key and ask the backend to authorize it.";
	Object.assign(description.style, { margin: "0 0 20px", lineHeight: "1.5", opacity: "0.75" });
	const status = document.createElement("p");
	status.dataset.testid = "pairing-status";
	status.setAttribute("role", "status");
	Object.assign(status.style, { margin: "0", lineHeight: "1.5", fontWeight: "600" });
	const retry = document.createElement("button");
	retry.type = "button";
	retry.textContent = "Try again";
	retry.hidden = true;
	Object.assign(retry.style, {
		marginTop: "18px",
		border: "1px solid var(--border, #9ca3af)",
		borderRadius: "8px",
		padding: "9px 14px",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
	});
	const relayButton = document.createElement("button");
	relayButton.type = "button";
	relayButton.textContent = "Set up a TURN relay";
	relayButton.dataset.testid = "pairing-turn-relay";
	relayButton.hidden = true;
	Object.assign(relayButton.style, {
		marginTop: "18px",
		marginLeft: "8px",
		border: "1px solid #2563eb",
		borderRadius: "8px",
		padding: "9px 14px",
		background: "transparent",
		color: "#2563eb",
		cursor: "pointer",
	});
	const continueLink = document.createElement("a");
	continueLink.textContent = "Open backend";
	continueLink.dataset.testid = "pairing-continue";
	continueLink.hidden = true;
	Object.assign(continueLink.style, {
		display: "inline-block",
		marginTop: "18px",
		borderRadius: "8px",
		padding: "9px 14px",
		background: "#2563eb",
		color: "#fff",
		textDecoration: "none",
	});
	card.append(title, description, status, retry, relayButton, continueLink);
	shell.append(card);
	root.append(shell);

	let running = false;
	let currentIdentity: BrowserDeviceIdentity | undefined;
	const pair = async (): Promise<void> => {
		if (running) return;
		running = true;
		retry.hidden = true;
		relayButton.hidden = true;
		status.textContent = "Creating this browser's private device key…";
		continueLink.hidden = true;
		let transport: PairingTransport | undefined;
		try {
			const capability = parsePairingUrl(window.location.href);
			const identity = await dependencies.loadIdentity();
			currentIdentity = identity;
			const api = dependencies.createTrustApi();
			status.textContent = "Contacting the backend…";
			transport = dependencies.createTransport({
				rendezvousUrl: window.location.origin,
				backendId: capability.backendId,
				deviceIdentity: identity,
				authorize: async () => ({
					...await api.createPairingTicket(identity, capability),
					pairingSecret: capability.secret,
					supplementalIceServers: await (dependencies.resolveTurnIceServers ?? resolveStoredTurnRelayIceServers)(identity.deviceId),
				}),
			});
			await transport.connect("webrtc");
			transport.close(1000, "Pairing complete");
			transport = undefined;
			const backendPath = `/backend/${encodeURIComponent(capability.backendId)}`;
			window.history.replaceState(null, "", backendPath);
			status.textContent = "Paired successfully. This browser can now request connections to the backend.";
			status.style.color = "#15803d";
			continueLink.href = backendPath;
			continueLink.hidden = false;
		} catch (error) {
			transport?.close(1000, "Pairing failed");
			status.textContent = error instanceof Error ? error.message : "Pairing failed";
			status.style.color = "#b91c1c";
			retry.hidden = false;
			const failure = connectionFailureDetails(error);
			relayButton.hidden = !failure.turnRecommended && failure.code !== "relay_configuration";
		} finally {
			running = false;
		}
	};
	retry.addEventListener("click", () => void pair());
	relayButton.addEventListener("click", () => {
		void (dependencies.openRelayDialog ?? openTurnRelayDialog)({
			subject: currentIdentity?.deviceId,
			saveLabel: "Save and try again",
			onSaved: () => { void pair(); },
		});
	});
	await pair();
}

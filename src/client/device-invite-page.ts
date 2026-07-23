import { loadOrCreateBrowserDeviceIdentity, type BrowserDeviceIdentity } from "./device-identity.js";
import {
	parseDeviceInviteUrl,
	RendezvousTrustApi,
	type DeviceInviteCapabilityFromUrl,
} from "./rendezvous-trust-api.js";

interface DeviceInviteTrustApi {
	acceptDeviceInvite(identity: BrowserDeviceIdentity, capability: DeviceInviteCapabilityFromUrl): Promise<unknown>;
}

export interface DeviceInvitePageDependencies {
	loadIdentity: () => Promise<BrowserDeviceIdentity>;
	createTrustApi: () => DeviceInviteTrustApi;
}

const defaults: DeviceInvitePageDependencies = {
	loadIdentity: () => loadOrCreateBrowserDeviceIdentity(),
	createTrustApi: () => new RendezvousTrustApi(window.location.origin),
};

export async function initializeDeviceInvitePage(
	dependencies: DeviceInvitePageDependencies = defaults,
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
	title.textContent = "Join this Pipane workspace";
	Object.assign(title.style, { margin: "0 0 8px", fontSize: "24px" });
	const description = document.createElement("p");
	description.textContent = "This one-time invite gives this browser access to the same backends as the inviting device.";
	Object.assign(description.style, { margin: "0 0 20px", lineHeight: "1.5", opacity: "0.75" });
	const status = document.createElement("p");
	status.dataset.testid = "device-invite-status";
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
	const continueLink = document.createElement("a");
	continueLink.textContent = "Open workspace";
	continueLink.dataset.testid = "device-invite-continue";
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
	card.append(title, description, status, retry, continueLink);
	shell.append(card);
	root.append(shell);

	let running = false;
	const accept = async (): Promise<void> => {
		if (running) return;
		running = true;
		retry.hidden = true;
		continueLink.hidden = true;
		status.style.color = "";
		status.textContent = "Creating this browser's private device key…";
		try {
			const capability = parseDeviceInviteUrl(window.location.href);
			const identity = await dependencies.loadIdentity();
			status.textContent = "Accepting the workspace invite…";
			await dependencies.createTrustApi().acceptDeviceInvite(identity, capability);
			window.history.replaceState(null, "", "/");
			status.textContent = "Device added. This browser can now open every backend in the workspace.";
			status.style.color = "#15803d";
			continueLink.href = "/";
			continueLink.hidden = false;
		} catch (error) {
			status.textContent = error instanceof Error ? error.message : "Device invite failed";
			status.style.color = "#b91c1c";
			retry.hidden = false;
		} finally {
			running = false;
		}
	};
	retry.addEventListener("click", () => void accept());
	await accept();
}

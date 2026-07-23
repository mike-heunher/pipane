import QRCode from "qrcode";
import { loadBrowserDeviceIdentity, type BrowserDeviceIdentity } from "./device-identity.js";
import { RendezvousTrustApi, type DeviceInviteLink } from "./rendezvous-trust-api.js";

interface DeviceInviteTrustApi {
	createDeviceInvite(identity: BrowserDeviceIdentity): Promise<DeviceInviteLink>;
}

export interface DeviceInviteDialogDependencies {
	loadIdentity: () => Promise<BrowserDeviceIdentity | undefined>;
	createTrustApi: () => DeviceInviteTrustApi;
	renderQr: (canvas: HTMLCanvasElement, value: string) => Promise<void>;
	copyText: (value: string) => Promise<void>;
	now: () => number;
}

const defaults: DeviceInviteDialogDependencies = {
	loadIdentity: () => loadBrowserDeviceIdentity(),
	createTrustApi: () => new RendezvousTrustApi(window.location.origin),
	renderQr: async (canvas, value) => {
		await QRCode.toCanvas(canvas, value, {
			errorCorrectionLevel: "M",
			margin: 2,
			width: 240,
			color: { dark: "#111827", light: "#ffffff" },
		});
	},
	copyText: async (value) => navigator.clipboard.writeText(value),
	now: Date.now,
};

export function openDeviceInviteDialog(
	dependencies: DeviceInviteDialogDependencies = defaults,
): Promise<void> {
	return new Promise((resolve) => {
		const overlay = element("div", "device-invite-overlay");
		overlay.dataset.testid = "device-invite-dialog";
		const panel = element("section", "device-invite-panel");
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-modal", "true");
		panel.setAttribute("aria-labelledby", "device-invite-title");

		const header = element("header", "device-invite-header");
		const heading = element("div");
		const title = element("h2", "device-invite-title", "Add another device");
		title.id = "device-invite-title";
		const subtitle = element("p", "device-invite-subtitle", "Share all backends in this Pipane workspace");
		heading.append(title, subtitle);
		const closeButton = element("button", "device-invite-close", "×");
		closeButton.type = "button";
		closeButton.setAttribute("aria-label", "Close device invite");
		header.append(heading, closeButton);

		const body = element("div", "device-invite-body");
		const status = element("p", "device-invite-status", "Creating a secure one-time invite…");
		status.setAttribute("role", "status");
		status.dataset.testid = "device-invite-create-status";
		body.append(status);
		panel.append(header, body);
		overlay.append(panel);
		document.body.append(overlay);

		let countdown: ReturnType<typeof setInterval> | undefined;
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			if (countdown) clearInterval(countdown);
			document.removeEventListener("keydown", onKeyDown);
			overlay.remove();
			resolve();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
		closeButton.addEventListener("click", close);
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) close();
		});
		document.addEventListener("keydown", onKeyDown);

		void (async () => {
			try {
				const identity = await dependencies.loadIdentity();
				if (!identity) throw new Error("This browser is not authorized to invite another device");
				const invite = await dependencies.createTrustApi().createDeviceInvite(identity);
				if (closed) return;
				const qr = element("canvas", "device-invite-qr");
				qr.dataset.testid = "device-invite-qr";
				await dependencies.renderQr(qr, invite.url);
				if (closed) return;

				const explanation = element(
					"p",
					"device-invite-explanation",
					"Scan this code on the new device, or copy the link. Anyone with it can access this workspace until it expires or is used.",
				);
				const linkRow = element("div", "device-invite-link-row");
				const link = element("input", "device-invite-link") as HTMLInputElement;
				link.type = "text";
				link.readOnly = true;
				link.value = invite.url;
				link.setAttribute("aria-label", "Device invite link");
				link.dataset.testid = "device-invite-link";
				const copy = element("button", "device-invite-copy", "Copy link");
				copy.type = "button";
				copy.addEventListener("click", () => {
					void dependencies.copyText(invite.url).then(() => {
						copy.textContent = "Copied";
					}).catch((error) => {
						status.textContent = error instanceof Error ? error.message : "Could not copy invite link";
						status.classList.add("is-error");
					});
				});
				linkRow.append(link, copy);
				body.replaceChildren(qr, explanation, linkRow, status);

				const updateCountdown = (): void => {
					const remaining = Math.max(0, invite.expiresAt - dependencies.now());
					if (remaining === 0) {
						status.textContent = "This invite has expired. Close this dialog and create another one.";
						status.classList.add("is-error");
						copy.disabled = true;
						link.disabled = true;
						if (countdown) clearInterval(countdown);
						return;
					}
					const totalSeconds = Math.ceil(remaining / 1000);
					const minutes = Math.floor(totalSeconds / 60);
					const seconds = String(totalSeconds % 60).padStart(2, "0");
					status.textContent = `One-time link · expires in ${minutes}:${seconds}`;
				};
				updateCountdown();
				countdown = setInterval(updateCountdown, 1000);
			} catch (error) {
				if (closed) return;
				status.textContent = error instanceof Error ? error.message : "Could not create a device invite";
				status.classList.add("is-error");
			}
		})();
	});
}

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	text?: string,
): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	if (className) result.className = className;
	if (text !== undefined) result.textContent = text;
	return result;
}

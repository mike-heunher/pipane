import type { AuthorizedBackendDescriptor } from "../shared/trust-protocol.js";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import { loadBrowserDeviceIdentity, type BrowserDeviceIdentity } from "./device-identity.js";
import { RendezvousTrustApi } from "./rendezvous-trust-api.js";

interface LandingTrustApi {
	listAuthorizedBackends(identity: BrowserDeviceIdentity): Promise<AuthorizedBackendDescriptor[]>;
	revokeBackend(identity: BrowserDeviceIdentity, backendId: string): Promise<void>;
}

export interface BackendLandingDependencies {
	loadIdentity(): Promise<BrowserDeviceIdentity | undefined>;
	createTrustApi(): LandingTrustApi;
	confirm(message: string): boolean;
}

const defaults: BackendLandingDependencies = {
	loadIdentity: () => loadBrowserDeviceIdentity(),
	createTrustApi: () => new RendezvousTrustApi(window.location.origin),
	confirm: (message) => window.confirm(message),
};

/** Account-scoped central landing page; it never opens backend transports itself. */
export async function initializeBackendLandingPage(
	dependencies: BackendLandingDependencies = defaults,
): Promise<void> {
	const root = document.getElementById("app") ?? document.body;
	root.replaceChildren();
	const shell = document.createElement("main");
	shell.dataset.testid = "backend-landing";
	shell.style.cssText = "min-height:100vh;padding:40px 24px;font-family:ui-sans-serif,system-ui;color:var(--foreground,#111827);background:var(--background,#fff)";
	const content = document.createElement("section");
	content.style.cssText = "width:min(760px,100%);margin:0 auto";
	const title = document.createElement("h1");
	title.textContent = "Your pipane backends";
	title.style.cssText = "margin:0 0 8px;font-size:28px";
	const intro = document.createElement("p");
	intro.textContent = "Connections are opened directly and only when you choose a backend.";
	intro.style.cssText = "margin:0 0 24px;opacity:.72";
	const list = document.createElement("div");
	list.dataset.testid = "backend-list";
	list.style.cssText = "display:grid;gap:12px";
	const recovery = document.createElement("p");
	recovery.style.cssText = "margin-top:24px;padding-top:18px;border-top:1px solid var(--border,#d1d5db);opacity:.78;line-height:1.5";
	recovery.textContent = "Add a backend or recover this browser by running `pipane pair` in an owned backend terminal and scanning its QR code.";
	content.append(title, intro, list, recovery);
	shell.append(content);
	root.append(shell);

	const identity = await dependencies.loadIdentity();
	if (!identity) {
		list.append(messageCard("No paired browser key was found.", "Use `pipane pair` on a backend to begin without creating an account."));
		return;
	}

	const api = dependencies.createTrustApi();
	let backends: AuthorizedBackendDescriptor[];
	try {
		backends = await api.listAuthorizedBackends(identity);
	} catch (error) {
		list.append(messageCard(
			"Backend access could not be recovered from this device key.",
			error instanceof Error ? error.message : "Pair this browser again from an owned backend terminal.",
		));
		return;
	}
	if (backends.length === 0) {
		list.append(messageCard("No backends are paired.", "Run `pipane pair` in a backend terminal to add one."));
		return;
	}

	for (const backend of backends) list.append(renderBackend(backend, identity, api, dependencies));
}

function renderBackend(
	backend: AuthorizedBackendDescriptor,
	identity: BrowserDeviceIdentity,
	api: LandingTrustApi,
	dependencies: BackendLandingDependencies,
): HTMLElement {
	const card = document.createElement("article");
	card.dataset.backendId = backend.backendId;
	card.style.cssText = "display:flex;align-items:center;gap:14px;border:1px solid var(--border,#d1d5db);border-radius:10px;padding:16px";
	const copy = document.createElement("div");
	copy.style.cssText = "min-width:0;flex:1";
	const name = document.createElement("strong");
	name.textContent = backend.name || `${backend.backendId.slice(0, 18)}…`;
	name.style.cssText = "display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
	const detail = document.createElement("small");
	const compatible = backend.protocolVersions.includes(BACKEND_PROTOCOL_VERSION);
	detail.textContent = backend.online
		? compatible ? `Online${backend.softwareVersion ? ` · v${backend.softwareVersion}` : ""}` : "Online · update required"
		: "Offline";
	detail.style.cssText = `color:${backend.online && compatible ? "#15803d" : "#a16207"}`;
	copy.append(name, detail);
	const open = document.createElement("a");
	open.textContent = "Open";
	open.href = `/backend/${encodeURIComponent(backend.backendId)}`;
	open.dataset.testid = "open-backend";
	open.style.cssText = "border-radius:8px;padding:8px 12px;background:#2563eb;color:white;text-decoration:none";
	if (!backend.online || !compatible) {
		open.removeAttribute("href");
		open.setAttribute("aria-disabled", "true");
		open.style.opacity = ".45";
	}
	const remove = document.createElement("button");
	remove.type = "button";
	remove.textContent = "Remove";
	remove.style.cssText = "border:0;background:transparent;color:#dc2626;cursor:pointer";
	remove.addEventListener("click", () => {
		if (!dependencies.confirm(`Remove ${backend.name || backend.backendId} from this account?`)) return;
		remove.disabled = true;
		void api.revokeBackend(identity, backend.backendId).then(() => card.remove()).catch((error) => {
			remove.disabled = false;
			detail.textContent = error instanceof Error ? error.message : "Removal failed";
			detail.style.color = "#dc2626";
		});
	});
	card.append(copy, open, remove);
	return card;
}

function messageCard(title: string, detail: string): HTMLElement {
	const card = document.createElement("div");
	card.style.cssText = "border:1px solid var(--border,#d1d5db);border-radius:10px;padding:18px;line-height:1.5";
	const strong = document.createElement("strong");
	strong.textContent = title;
	const paragraph = document.createElement("p");
	paragraph.textContent = detail;
	paragraph.style.cssText = "margin:6px 0 0;opacity:.72";
	card.append(strong, paragraph);
	return card;
}

import "./app.css";
import { bootstrapDiagnostics } from "./bootstrap-diagnostics.js";
import { isSettingsPath } from "./settings-route.js";

// Unregister stale service workers before either the local workspace or pairing flow starts.
if ("serviceWorker" in navigator) {
	void navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (const registration of registrations) void registration.unregister();
	});
}

void bootstrap();

async function bootstrap(): Promise<void> {
	bootstrapDiagnostics.mark("Checking deployment");
	if (isDeviceInvitePath(window.location.pathname)) {
		bootstrapDiagnostics.mark("Loading device invitation");
		const { initializeDeviceInvitePage } = await import("./device-invite-page.js");
		await initializeDeviceInvitePage();
		bootstrapDiagnostics.complete();
		return;
	}
	if (isPairingPath(window.location.pathname)) {
		bootstrapDiagnostics.mark("Loading device pairing");
		const { initializePairingPage } = await import("./pairing-page.js");
		await initializePairingPage();
		bootstrapDiagnostics.complete();
		return;
	}
	const backendId = backendIdFromPath(window.location.pathname);
	const rendezvousWorkspace = backendId !== undefined
		|| ((window.location.pathname === "/" || isSettingsPath(window.location.pathname)) && await isRendezvousHost());
	if (rendezvousWorkspace) {
		try {
			bootstrapDiagnostics.mark("Loading remote workspace");
			const [
				{ configureAppRuntime },
				{ RemoteBackendManager },
				{ WorkspaceBackendClient },
				{ loadBrowserDeviceIdentity },
			] = await Promise.all([
				import("./app-runtime.js"),
				import("./remote-backend-manager.js"),
				import("./workspace-backend-client.js"),
				import("./device-identity.js"),
			]);
			bootstrapDiagnostics.mark("Loading browser identity");
			if (!await loadBrowserDeviceIdentity()) {
				await renderBackendLandingPage();
				bootstrapDiagnostics.complete();
				return;
			}
			bootstrapDiagnostics.mark("Discovering authorized backends");
			const manager = new RemoteBackendManager(window.location.origin);
			const backends = await manager.initialize();
			if (backends.length === 0) {
				await renderBackendLandingPage();
				bootstrapDiagnostics.complete();
				return;
			}
			bootstrapDiagnostics.event("Backend discovery complete", `${backends.length} authorized backend${backends.length === 1 ? "" : "s"}`);
			const client = new WorkspaceBackendClient(backends, manager, backendId);
			bootstrapDiagnostics.attachClient(client);
			configureAppRuntime({ client });
		} catch (error) {
			renderBootstrapError(error);
			bootstrapDiagnostics.fail(error);
			return;
		}
	}
	bootstrapDiagnostics.mark("Loading application");
	await import("./main.js");
}

async function renderBackendLandingPage(): Promise<void> {
	const { initializeBackendLandingPage } = await import("./backend-landing-page.js");
	await initializeBackendLandingPage();
}

async function isRendezvousHost(): Promise<boolean> {
	try {
		const response = await fetch("/health", { cache: "no-store" });
		if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return false;
		const value: unknown = await response.json();
		return !!value && typeof value === "object" && (value as Record<string, unknown>).ok === true;
	} catch {
		return false;
	}
}

function renderBootstrapError(error: unknown): void {
	const app = document.getElementById("app") ?? document.body;
	app.replaceChildren();
	const main = document.createElement("main");
	main.style.cssText = "min-height:100vh;display:grid;place-items:center;padding:24px;font-family:ui-sans-serif,system-ui;color:var(--foreground,#111827);background:var(--background,#fff)";
	const card = document.createElement("section");
	card.style.cssText = "max-width:520px;border:1px solid var(--border,#d1d5db);border-radius:12px;padding:28px";
	const title = document.createElement("h1");
	title.textContent = "Cannot open backend";
	const message = document.createElement("p");
	message.textContent = error instanceof Error ? error.message : "This browser is not authorized for the backend.";
	const recovery = document.createElement("p");
	recovery.textContent = "To restore access, run `pipane pair` in the backend terminal and scan the new QR code with this browser.";
	card.append(title, message, recovery);
	main.append(card);
	app.append(main);
}

export function isDeviceInvitePath(pathname: string): boolean {
	return /^\/invite\/[^/]+$/u.test(pathname);
}

export function isPairingPath(pathname: string): boolean {
	return /^\/pair\/[^/]+$/u.test(pathname);
}

export function backendIdFromPath(pathname: string): string | undefined {
	const match = /^\/backend\/([^/]+)$/u.exec(pathname);
	return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

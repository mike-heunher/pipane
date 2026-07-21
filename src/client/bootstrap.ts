import "./app.css";

// Unregister stale service workers before either the local workspace or pairing flow starts.
if ("serviceWorker" in navigator) {
	void navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (const registration of registrations) void registration.unregister();
	});
}

void bootstrap();

async function bootstrap(): Promise<void> {
	if (isPairingPath(window.location.pathname)) {
		const { initializePairingPage } = await import("./pairing-page.js");
		await initializePairingPage();
		return;
	}
	if (window.location.pathname === "/" && await isRendezvousHost()) {
		const { initializeBackendLandingPage } = await import("./backend-landing-page.js");
		await initializeBackendLandingPage();
		return;
	}
	const backendId = backendIdFromPath(window.location.pathname);
	if (backendId) {
		try {
			const [{ configureAppRuntime }, { RemoteBackendManager }] = await Promise.all([
				import("./app-runtime.js"),
				import("./remote-backend-manager.js"),
			]);
			const manager = new RemoteBackendManager(window.location.origin);
			const backends = await manager.initialize();
			configureAppRuntime({
				client: manager.getClient(backendId),
				remote: { backendId, backends, manager },
			});
		} catch (error) {
			renderBootstrapError(error);
			return;
		}
	}
	await import("./main.js");
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

export function isPairingPath(pathname: string): boolean {
	return /^\/pair\/[^/]+$/u.test(pathname);
}

export function backendIdFromPath(pathname: string): string | undefined {
	const match = /^\/backend\/([^/]+)$/u.exec(pathname);
	return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

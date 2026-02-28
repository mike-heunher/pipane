// Unregister any stale service workers from previous apps on this port
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (const r of registrations) r.unregister();
	});
}

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { DummyStorageBackend } from "./dummy-storage.js";
import "./session-picker.js";
import { registerCodingAgentRenderers } from "./tool-renderers.js";
import "./app.css";

// Register tool renderers for coding agent tools (Read, Write, Edit)
registerCodingAgentRenderers();

let chatPanel: ChatPanel;
let agent: WsAgentAdapter;
let sidebarOpen = true;



const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-2">
					<button
						class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						@click=${() => { sidebarOpen = !sidebarOpen; renderApp(); }}
						title="Toggle sidebar"
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
							<line x1="9" y1="3" x2="9" y2="21"></line>
						</svg>
					</button>
					<span class="text-base font-semibold text-foreground">pi web</span>
				</div>
				<div class="flex items-center gap-1 px-2">
					<theme-toggle></theme-toggle>
				</div>
			</div>
			<!-- Main content: sidebar + chat -->
			<div class="flex flex-1 overflow-hidden">
				${sidebarOpen
					? html`
						<div class="shrink-0 border-r border-border bg-background overflow-hidden" style="width: 280px;">
							<session-picker .agent=${agent}></session-picker>
						</div>
					`
					: ""}
				<div class="flex-1 overflow-hidden">
					${chatPanel}
				</div>
			</div>
		</div>
	`;

	render(appHtml, app);
};

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Connecting...</div>
			</div>
		`,
		app,
	);

	// Initialize storage with dummy backend (keys are server-side)
	const settings = new SettingsStore();
	const providerKeys = new ProviderKeysStore();
	const sessions = new SessionsStore();
	const customProviders = new CustomProvidersStore();
	const backend = new DummyStorageBackend();
	settings.setBackend(backend);
	providerKeys.setBackend(backend);
	sessions.setBackend(backend);
	customProviders.setBackend(backend);
	const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
	setAppStorage(storage);

	// Connect to backend
	agent = new WsAgentAdapter();
	const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

	try {
		await agent.connect(wsUrl);
	} catch (err) {
		render(
			html`
				<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
					<div class="text-destructive">Failed to connect to server. Is the backend running?</div>
				</div>
			`,
			app,
		);
		return;
	}

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Set agent — cast to Agent since WsAgentAdapter implements the same interface
	await chatPanel.setAgent(agent as any);

	// Re-render chat when session changes (new messages after switch)
	agent.onSessionChange(async () => {
		await chatPanel.setAgent(agent as any);
		renderApp();
	});

	renderApp();
}

initApp();

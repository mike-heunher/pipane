import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { ChatPanel } from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Settings } from "lucide";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import "./app.css";

let chatPanel: ChatPanel;
let agent: WsAgentAdapter;

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-2">
					<span class="text-base font-semibold text-foreground">pi web</span>
				</div>
				<div class="flex items-center gap-1 px-2">
					<theme-toggle></theme-toggle>
				</div>
			</div>
			<!-- Chat Panel -->
			${chatPanel}
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

	renderApp();
}

initApp();

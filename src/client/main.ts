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

registerCodingAgentRenderers();

let chatPanel: ChatPanel;
let agent: WsAgentAdapter;
let sidebarOpen = true;
let steeringQueue: readonly string[] = [];

/**
 * Patch the AgentInterface to allow sending messages during streaming.
 * The upstream component blocks input when isStreaming=true. We override
 * sendMessage to bypass that guard, and force the message-editor to
 * always show the send button (never the stop button).
 */
function patchAgentInterface() {
	const ai = chatPanel.agentInterface;
	if (!ai) return;

	// Override sendMessage to bypass isStreaming guard
	const originalSendMessage = ai.sendMessage.bind(ai);
	ai.sendMessage = async (input: string, attachments?: any[]) => {
		if (!input.trim() && (!attachments || attachments.length === 0)) return;
		const session = ai.session;
		if (!session) return;
		if (!session.state.model) return;

		// Clear editor
		const editor = ai.querySelector("message-editor") as any;
		if (editor) {
			editor.value = "";
			editor.attachments = [];
		}

		// If streaming, prompt() in our adapter will route as steer
		if (attachments && attachments.length > 0) {
			await session.prompt({ role: "user-with-attachments", content: input, attachments, timestamp: Date.now() });
		} else {
			await session.prompt(input);
		}
	};

	// Continuously force message-editor.isStreaming = false so the send button
	// stays visible (we render our own abort button in the header).
	startEditorPatcher(ai);
}

let editorPatcherRunning = false;
let currentAgentInterface: any = null;

/** Force the message-editor to not be in streaming mode (shows send button). */
function patchEditorNow() {
	if (!currentAgentInterface) return;
	const editor = currentAgentInterface.querySelector("message-editor") as any;
	if (editor && editor.isStreaming === true) {
		editor.isStreaming = false;
	}
}

/**
 * Continuously override the message-editor's isStreaming to false.
 * Also subscribe to agent events so we patch immediately after Lit re-renders.
 */
function startEditorPatcher(ai: any) {
	currentAgentInterface = ai;

	// Subscribe to agent events to patch right after state updates trigger re-renders
	agent.subscribe(() => {
		// Microtask runs after Lit's synchronous render in the event handler
		queueMicrotask(patchEditorNow);
	});

	if (editorPatcherRunning) return;
	editorPatcherRunning = true;

	const patch = () => {
		patchEditorNow();
		requestAnimationFrame(patch);
	};
	requestAnimationFrame(patch);
}

function renderSteeringQueue() {
	if (steeringQueue.length === 0) return "";
	return html`
		<div class="steering-queue">
			<div class="steering-queue-header">
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
				</svg>
				<span>Queued steering ${steeringQueue.length === 1 ? "prompt" : "prompts"}</span>
			</div>
			${steeringQueue.map((msg, i) => html`
				<div class="steering-queue-item">
					<span class="steering-queue-index">${i + 1}</span>
					<span class="steering-queue-text">${msg.length > 120 ? msg.slice(0, 120) + "…" : msg}</span>
				</div>
			`)}
		</div>
	`;
}

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const isStreaming = agent?.isReallyStreaming;

	const statusBadge = agent
		? agent.sessionStatus === "attached"
			? html`<span class="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 dark:text-green-400 font-mono">attached</span>`
			: agent.sessionStatus === "virtual"
				? html`<span class="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 font-mono">new</span>`
				: html`<span class="text-xs px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-500 font-mono">detached</span>`
		: "";

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
					${statusBadge}
					${isStreaming ? html`
						<button
							class="abort-btn"
							@click=${() => agent.abort()}
							title="Stop agent"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
							</svg>
							<span>Stop</span>
						</button>
					` : ""}
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
				<div class="flex-1 overflow-hidden flex flex-col">
					${agent?.sessionStatus === "virtual" && agent?.cwd && agent?.state?.messages?.length === 0
						? html`
							<div class="flex items-center gap-2 px-4 py-2 border-b border-border bg-accent/50 text-sm text-muted-foreground">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
									<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
								</svg>
								<span>New conversation in <span class="font-medium text-foreground" title="${agent.cwd}">${agent.cwd.split("/").filter(Boolean).pop() || agent.cwd}</span></span>
							</div>
						`
						: ""}
					<div class="flex-1 overflow-hidden relative">
						${chatPanel}
						${renderSteeringQueue()}
					</div>
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

	// Initialize storage
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

	// Connect WebSocket
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
	await chatPanel.setAgent(agent as any);

	// Patch the AgentInterface to allow sending during streaming
	patchAgentInterface();

	// Session switch: full re-init of chat panel
	agent.onSessionChange(async () => {
		await chatPanel.setAgent(agent as any);
		patchAgentInterface();
		renderApp();
	});

	// Content change (messages refreshed from disk): lightweight re-render
	agent.onContentChange(() => {
		const ai = chatPanel.agentInterface;
		if (ai) {
			ai.session = agent as any;
			ai.requestUpdate();
		}
	});

	// Status change (attached/detached): update header badge & abort button
	agent.onStatusChange(() => {
		renderApp();
	});

	// Steering queue change: update the queue visualization
	agent.onSteeringQueueChange(() => {
		steeringQueue = agent.steeringQueue;
		renderApp();
	});

	// Load models and start with a virtual new session
	await agent.loadDefaultModel();
	await agent.newSession();

	renderApp();
}

initApp();

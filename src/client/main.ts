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
let inputAreaObserver: ResizeObserver | null = null;
let observedInputArea: Element | null = null;

/**
 * Patch the AgentInterface to allow sending messages during streaming.
 * The upstream component blocks input when isStreaming=true. We override
 * sendMessage to bypass that guard, and patch the message-editor's
 * handleKeyDown so Enter sends even while streaming. The native stop
 * button in the message-editor is left intact.
 */
function patchAgentInterface() {
	const ai = chatPanel.agentInterface;
	if (!ai) return;

	// Override sendMessage to bypass isStreaming guard
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

		// Extract images and document text from attachments
		if (attachments && attachments.length > 0) {
			const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
			const docTexts: string[] = [];

			for (const att of attachments) {
				if (att.type === "image") {
					images.push({ type: "image", data: att.content, mimeType: att.mimeType });
				} else if (att.extractedText) {
					docTexts.push(att.extractedText);
				}
			}

			// Append document text to the user message
			const fullInput = docTexts.length > 0
				? (input ? input + "\n\n" + docTexts.join("\n\n") : docTexts.join("\n\n"))
				: input;

			if (images.length > 0) {
				await session.prompt(fullInput, images);
			} else {
				await session.prompt(fullInput);
			}
		} else {
			await session.prompt(input);
		}
	};

	// Patch the message-editor to allow sending during streaming.
	// Wait a frame to ensure the editor has rendered.
	requestAnimationFrame(() => patchMessageEditor(ai));
}

/**
 * Patch the message-editor's keyboard handler and add a send button
 * that's visible alongside the native stop button during streaming.
 */
function patchMessageEditor(ai: any) {
	const editor = ai.querySelector("message-editor") as any;
	if (!editor) return;

	// Override handleKeyDown to allow Enter to send even while streaming
	// (original blocks Enter when isStreaming=true)
	editor.handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!editor.processingFiles && (editor.value.trim() || editor.attachments.length > 0)) {
				editor.onSend?.(editor.value, editor.attachments);
			}
		} else if (e.key === "Escape" && editor.isStreaming) {
			e.preventDefault();
			editor.onAbort?.();
		}
	};

	// After every Lit render, ensure the send button is present when streaming
	const injectSendButton = () => {
		if (!editor.isStreaming) {
			// Not streaming — remove injected button if present
			const existing = editor.querySelector(".injected-send-btn");
			if (existing) existing.remove();
			return;
		}

		// Already injected and still in DOM — nothing to do
		if (editor.querySelector(".injected-send-btn")) return;

		// Find the right-side toolbar div (contains the stop button)
		const toolbarDivs = editor.querySelectorAll(".flex.gap-2.items-center");
		const rightToolbar = toolbarDivs[toolbarDivs.length - 1];
		if (!rightToolbar) return;

		const sendBtn = document.createElement("button");
		sendBtn.className = "injected-send-btn";
		sendBtn.title = "Send message (steer)";
		sendBtn.type = "button";
		sendBtn.innerHTML = `<div style="transform: rotate(-45deg)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></div>`;
		sendBtn.addEventListener("click", (ev: Event) => {
			ev.preventDefault();
			ev.stopPropagation();
			if (editor.value.trim() || editor.attachments.length > 0) {
				editor.onSend?.(editor.value, editor.attachments);
			}
		});
		rightToolbar.appendChild(sendBtn);
	};

	// Hook into Lit's updated lifecycle to re-inject after every render
	const origUpdated = editor.updated?.bind(editor);
	editor.updated = (changedProps: Map<string, any>) => {
		origUpdated?.(changedProps);
		injectSendButton();
	};

	// Force a re-render so Lit picks up our new handleKeyDown
	editor.requestUpdate();
	// Initial sync after the forced re-render
	editor.updateComplete.then(() => injectSendButton());
}

/** Watch the input area inside AgentInterface and sync its height to a CSS variable */
function observeInputAreaHeight() {
	const ai = chatPanel?.agentInterface;
	if (!ai) return;
	// The input area is the last .shrink-0 child inside the agent interface
	const inputArea = ai.querySelector(".shrink-0");
	if (!inputArea || inputArea === observedInputArea) return;

	// Clean up previous observer
	if (inputAreaObserver) inputAreaObserver.disconnect();

	observedInputArea = inputArea;
	inputAreaObserver = new ResizeObserver((entries) => {
		for (const entry of entries) {
			const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
			document.documentElement.style.setProperty("--input-area-height", `${height}px`);
		}
	});
	inputAreaObserver.observe(inputArea);

	// Set initial value
	const rect = inputArea.getBoundingClientRect();
	document.documentElement.style.setProperty("--input-area-height", `${rect.height}px`);
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

	// Re-observe after render in case DOM changed
	requestAnimationFrame(() => observeInputAreaHeight());
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
		// Refresh steering queue for the new session (it's per-session now)
		steeringQueue = agent.steeringQueue;
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

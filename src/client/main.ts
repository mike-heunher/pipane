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
import "./message-renderers.js";
import "./thinking-block-patch.js";
import "./fork-modal.js";
import type { ForkModal, ForkResult } from "./fork-modal.js";
import "./app.css";
import { initCanvas, isCanvasVisible, showCanvas, restoreCanvasFromMessages } from "./canvas-panel.js";
import { selectModelFromAvailable } from "./model-picker.js";
import { ensureInputMenuButton } from "./input-menu.js";

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

		try {
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
		} catch (err) {
			console.error("Failed to send message:", err);
			alert(err instanceof Error ? err.message : String(err));
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
	// Cmd+Enter (or Ctrl+Enter): fork session and prompt in the fork
	editor.handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
			e.preventDefault();
			if (!editor.processingFiles && (editor.value.trim() || editor.attachments.length > 0)) {
				const value = editor.value;
				const attachments = editor.attachments;
				editor.value = "";
				editor.attachments = [];
				handleForkAndPrompt(value, attachments);
			}
		} else if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!editor.processingFiles && (editor.value.trim() || editor.attachments.length > 0)) {
				editor.onSend?.(editor.value, editor.attachments);
			}
		} else if (e.key === "Escape" && editor.isStreaming) {
			e.preventDefault();
			editor.onAbort?.();
		}
	};

	const customModelSelect = async () => {
		try {
			const models = await agent.fetchAvailableModels();
			const selected = await selectModelFromAvailable(models as any, agent.state.model as any, (msg) => Promise.resolve(window.prompt(msg)));
			if (selected) agent.setModel(selected as any);
		} catch (err) {
			console.error("Failed to open model picker:", err);
		}
	};

	// After every Lit render, ensure the input controls are present.
	const injectInputControls = () => {
		// Guard against infinite update loops: onModelSelect is a reactive property.
		// Re-assign only if upstream replaced our handler.
		if (editor.onModelSelect !== customModelSelect) {
			editor.onModelSelect = customModelSelect;
		}

		ensureInputMenuButton(editor, () => agent?.sessionFile);

		if (!editor.isStreaming) {
			// Not streaming — remove injected send button if present
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
		sendBtn.innerHTML = `<span style="transform: translateY(3px) rotate(-45deg); display: inline-flex;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></span>`;
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
		injectInputControls();
	};

	// Force a re-render so Lit picks up our new handleKeyDown
	editor.requestUpdate();
	// Initial sync after the forced re-render
	editor.updateComplete.then(() => injectInputControls());
}

/** Watch the input area inside AgentInterface and sync its height to a CSS variable */
function observeInputAreaHeight() {
	const ai = chatPanel?.agentInterface;
	if (!ai) return;

	// Find the input area: try message-editor first, then fall back to last .shrink-0
	let inputArea: Element | null = ai.querySelector("message-editor");
	if (!inputArea) {
		const shrinkElements = ai.querySelectorAll(".shrink-0");
		inputArea = shrinkElements[shrinkElements.length - 1] ?? null;
	}

	if (!inputArea || inputArea === observedInputArea) return;

	// Clean up previous observer
	if (inputAreaObserver) inputAreaObserver.disconnect();

	observedInputArea = inputArea;

	const syncHeight = () => {
		if (!observedInputArea) return;
		// Walk up to find the containing shrink-0 wrapper (the actual bottom bar)
		let el: Element | null = observedInputArea;
		while (el && !el.classList.contains("shrink-0")) {
			el = el.parentElement;
		}
		const target = el || observedInputArea;
		const height = target.getBoundingClientRect().height;
		if (height > 0) {
			document.documentElement.style.setProperty("--input-area-height", `${height}px`);
		}
	};

	inputAreaObserver = new ResizeObserver(() => syncHeight());
	inputAreaObserver.observe(inputArea);

	// Also observe the parent shrink-0 if different
	let wrapper: Element | null = inputArea;
	while (wrapper && !wrapper.classList.contains("shrink-0")) {
		wrapper = wrapper.parentElement;
	}
	if (wrapper && wrapper !== inputArea) {
		inputAreaObserver.observe(wrapper);
	}

	// Set initial value
	syncHeight();
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
					<button class="steering-queue-remove" onclick=${() => { agent.removeSteering(i); }} title="Remove from queue">
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
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
					<div class="flex-1 overflow-hidden flex">
						<div class="flex-1 overflow-hidden relative">
							${chatPanel}
							${renderSteeringQueue()}
						</div>
						${isCanvasVisible()
							? html`<div id="canvas-container" class="canvas-container border-l border-border"></div>`
							: ""}
					</div>
				</div>
			</div>
		</div>
	`;

	render(appHtml, app);

	// Re-observe after render in case DOM changed
	requestAnimationFrame(() => {
		observeInputAreaHeight();
		const canvasEl = document.getElementById("canvas-container");
		if (canvasEl) {
			initCanvas(canvasEl, renderApp);
		}
	});
};

/**
 * Fork the current session and prompt in the new fork.
 * Handles image/document attachments the same way as sendMessage.
 */
async function handleForkAndPrompt(input: string, attachments?: any[]) {
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	const docTexts: string[] = [];

	if (attachments && attachments.length > 0) {
		for (const att of attachments) {
			if (att.type === "image") {
				images.push({ type: "image", data: att.content, mimeType: att.mimeType });
			} else if (att.extractedText) {
				docTexts.push(att.extractedText);
			}
		}
	}

	const fullInput = docTexts.length > 0
		? (input ? input + "\n\n" + docTexts.join("\n\n") : docTexts.join("\n\n"))
		: input;

	await agent.forkAndPrompt(fullInput, images.length > 0 ? images : undefined);
}

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

	// Fix: clear the streaming container on message_end to prevent the same
	// assistant message from rendering in BOTH message-list AND the streaming
	// container. The upstream AgentInterface only clears it on agent_end,
	// but between message_end and agent_end (while tools are executing)
	// the streaming container still holds the old streamMessage.
	agent.subscribe((ev) => {
		if (ev.type === "message_end") {
			const ai = chatPanel.agentInterface;
			if (ai) {
				const sc = ai.querySelector("streaming-message-container") as any;
				if (sc) {
					sc.setMessage(null, true);
				}
			}
		}

		// Canvas tool: show side panel when tool_execution_end fires for "canvas"
		if (ev.type === "tool_execution_end" && (ev as any).toolName === "canvas") {
			const details = (ev as any).result?.details;
			if (details?.markdown) {
				showCanvas(details.title || "Canvas", details.markdown);
			}
		}
	});

	// Session switch: full re-init of chat panel
	agent.onSessionChange(async () => {
		await chatPanel.setAgent(agent as any);
		patchAgentInterface();
		// Refresh steering queue for the new session (it's per-session now)
		steeringQueue = agent.steeringQueue;
		// Restore canvas state from the new session's messages
		restoreCanvasFromMessages(agent.state.messages);
		renderApp();
	});

	// Content change (messages refreshed from disk): lightweight re-render
	agent.onContentChange(() => {
		const ai = chatPanel.agentInterface;
		if (ai) {
			ai.session = agent as any;
			ai.requestUpdate();
		}
		// Restore canvas state from refreshed messages
		restoreCanvasFromMessages(agent.state.messages);
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

	// Fork request handler (triggered by /fork command or keyboard shortcut)
	const handleForkRequest = async () => {
		if (!agent.sessionFile || agent.sessionStatus === "virtual") return;

		const modal = document.createElement("fork-modal") as ForkModal;
		document.body.appendChild(modal);

		const result = await modal.open(agent);
		if (!result) return; // cancelled

		// Switch to the new forked session
		if (result.newSessionPath) {
			await agent.switchSession(result.newSessionPath);
		}

		// Pre-fill the editor with the selected message text
		if (result.text) {
			const ai = chatPanel.agentInterface;
			const editor = ai?.querySelector("message-editor") as any;
			if (editor) {
				editor.value = result.text;
				editor.requestUpdate();
				requestAnimationFrame(() => editor.focus?.());
			}
		}
	};

	window.addEventListener("pi-fork-request", handleForkRequest);

	// Load models and start with a virtual new session
	await agent.loadDefaultModel();
	await agent.newSession();

	renderApp();
}

initApp();

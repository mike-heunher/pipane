// Unregister any stale service workers from previous apps on this port
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (const r of registrations) r.unregister();
	});
}

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { initThemes, createThemeSelector } from "./theme-selector.js";
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
import { initCanvas, isCanvasVisible, showCanvas, restoreCanvasFromMessages, canvasKey, markCanvasOpened } from "./canvas-panel.js";
import { initJsonlPanel, isJsonlPanelVisible, toggleJsonlPanel, setJsonlSessionPath, refreshJsonlPanel, jumpToJsonlEntryForChat } from "./jsonl-panel.js";
import { openModelPickerDialog } from "./model-picker-dialog.js";
import { ensureInputMenuButton } from "./input-menu.js";
import { getLoadTraceId, sendNavigationTiming, traceInstant, traceSpanStart } from "./load-trace.js";

registerCodingAgentRenderers();
initThemes();

let chatPanel: ChatPanel;
let agent: WsAgentAdapter;
let sidebarOpen = true;
let steeringQueue: readonly string[] = [];
let piInstallPromptOpen = false;
let inputAreaObserver: ResizeObserver | null = null;
let observedInputArea: Element | null = null;
let chatJsonlJumpListenerInstalled = false;

traceInstant("frontend_bootstrap_loaded", { url: window.location.pathname });

// Token usage visibility toggle
const TOKEN_USAGE_KEY = "pi-web-hide-token-usage";
function isTokenUsageHidden(): boolean {
	return localStorage.getItem(TOKEN_USAGE_KEY) === "true";
}
function setTokenUsageHidden(hidden: boolean) {
	localStorage.setItem(TOKEN_USAGE_KEY, String(hidden));
	document.documentElement.classList.toggle("hide-token-usage", hidden);
}
// Apply saved preference immediately
if (isTokenUsageHidden()) {
	document.documentElement.classList.add("hide-token-usage");
}

/**
 * Configure the AgentInterface to allow sending messages during streaming
 * and set up custom keyboard shortcuts, model picker, and input menu.
 *
 * Uses upstream extension points (added via patch-package) instead of
 * monkey-patching internal methods:
 *   - `allowSendDuringStreaming` on AgentInterface + MessageEditor
 *   - `onKeyDown` callback on MessageEditor (return true to suppress default)
 *   - `extraToolbarButtons` on MessageEditor (render custom buttons in toolbar)
 */
function patchAgentInterface() {
	const ai = chatPanel.agentInterface;
	if (!ai) return;

	// Enable sending during streaming (bypasses isStreaming guard in sendMessage
	// and shows send+stop buttons together in the editor)
	(ai as any).allowSendDuringStreaming = true;

	// Wait a frame for the editor to render, then configure it
	requestAnimationFrame(() => configureMessageEditor(ai));
}

/**
 * Configure the message-editor via its public extension points.
 */
function configureMessageEditor(ai: any) {
	const editor = ai.querySelector("message-editor") as any;
	if (!editor) return;

	// Custom keyboard handler: Cmd+Enter forks, default Enter/Escape handled by upstream
	editor.onKeyDown = (e: KeyboardEvent): boolean => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
			e.preventDefault();
			if (!editor.processingFiles && (editor.value.trim() || editor.attachments.length > 0)) {
				const value = editor.value;
				const attachments = editor.attachments;
				editor.value = "";
				editor.attachments = [];
				handleForkAndPrompt(value, attachments);
			}
			return true; // suppress default Enter handling
		}
		return false; // let upstream handle Enter, Escape, etc.
	};

	// Custom model picker
	editor.onModelSelect = async () => {
		try {
			const models = await agent.fetchAvailableModels();
			const selected = await openModelPickerDialog(models as any, agent.state.model as any);
			if (selected) agent.setModel(selected as any);
		} catch (err) {
			console.error("Failed to open model picker:", err);
		}
	};

	// Input menu button (injected once via DOM, still needs the ensureInputMenuButton helper)
	ensureInputMenuButton(editor, () => agent?.sessionFile);

	// Re-inject input menu after Lit re-renders (it can get removed)
	const origUpdated = editor.updated?.bind(editor);
	editor.updated = (changedProps: Map<string, any>) => {
		origUpdated?.(changedProps);
		ensureInputMenuButton(editor, () => agent?.sessionFile);
	};
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

/**
 * When the JSONL panel is open, clicking a rendered chat message jumps to
 * the corresponding JSONL line.
 */
function installChatJsonlJumpListener() {
	if (chatJsonlJumpListenerInstalled) return;
	chatJsonlJumpListenerInstalled = true;

	document.addEventListener("click", (e) => {
		if (!isJsonlPanelVisible()) return;
		const target = e.target as HTMLElement | null;
		if (!target) return;

		const ai = chatPanel?.agentInterface as HTMLElement | undefined;
		if (!ai) return;

		const messageList = ai.querySelector("message-list") as HTMLElement | null;
		if (!messageList || !messageList.contains(target)) return;

		let displayedMessageOrdinal = NaN;
		const messageWrapper = target.closest("[data-message-index]") as HTMLElement | null;
		const indexRaw = messageWrapper?.getAttribute("data-message-index");
		if (indexRaw != null) {
			displayedMessageOrdinal = Number(indexRaw);
		}

		// Fallback path if the upstream patch is not active in the current bundle:
		// derive ordinal from direct children in message-list.
		if (!Number.isFinite(displayedMessageOrdinal)) {
			const listRoot = messageList.querySelector(":scope > div") as HTMLElement | null;
			if (!listRoot) return;
			const children = Array.from(listRoot.children) as HTMLElement[];
			displayedMessageOrdinal = children.findIndex((el) => el === target || el.contains(target));
		}
		if (!Number.isFinite(displayedMessageOrdinal) || displayedMessageOrdinal < 0) return;

		const toolEl = target.closest("tool-message") as any;
		const toolCallId =
			(toolEl?.getAttribute?.("data-tool-call-id") as string | null) ??
			(toolEl?.toolCall?.id as string | undefined);
		jumpToJsonlEntryForChat(displayedMessageOrdinal, toolCallId || undefined);
	});
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
					<button
						class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors ${!isTokenUsageHidden() ? 'text-foreground bg-accent' : ''}"
						@click=${() => { setTokenUsageHidden(!isTokenUsageHidden()); renderApp(); }}
						title="Toggle token usage display"
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
						</svg>
					</button>
					<button
						class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors ${isJsonlPanelVisible() ? 'text-foreground bg-accent' : ''}"
						@click=${() => { toggleJsonlPanel(); renderApp(); }}
						title="Toggle raw JSONL viewer"
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="16 18 22 12 16 6"></polyline>
							<polyline points="8 6 2 12 8 18"></polyline>
						</svg>
					</button>
					${createThemeSelector()}
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
						${isJsonlPanelVisible()
							? html`<div id="jsonl-container" class="jsonl-container border-l border-border"></div>`
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
		const jsonlEl = document.getElementById("jsonl-container");
		if (jsonlEl) {
			initJsonlPanel(jsonlEl, renderApp);
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
	traceInstant("init_app_start");
	sendNavigationTiming();
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Leave the HTML skeleton shell visible while connecting.
	// Only show a "Connecting..." overlay if WS takes more than 300ms.
	let connectingOverlayTimer: ReturnType<typeof setTimeout> | undefined;
	const skeletonShell = document.getElementById("skeleton-shell");
	connectingOverlayTimer = setTimeout(() => {
		// If the skeleton is still visible (JS hasn't rendered the real app yet),
		// add a subtle connecting indicator on top of it
		if (skeletonShell?.parentElement === app) {
			const overlay = document.createElement("div");
			overlay.id = "connecting-overlay";
			overlay.style.cssText = "position:absolute;bottom:2rem;left:50%;transform:translateX(-50%);color:var(--muted-foreground,#6b7280);font-size:0.8rem;z-index:10;";
			overlay.textContent = "Connecting…";
			skeletonShell.style.position = "relative";
			skeletonShell.appendChild(overlay);
		}
	}, 300);

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
	const wsUrl = `${wsProtocol}//${window.location.host}/ws?traceId=${encodeURIComponent(getLoadTraceId())}`;

	const endWsConnectSpan = traceSpanStart("frontend_ws_connect");
	try {
		await agent.connect(wsUrl);
		endWsConnectSpan();
	} catch (err) {
		endWsConnectSpan();
		clearTimeout(connectingOverlayTimer);
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

	clearTimeout(connectingOverlayTimer);

	// Create ChatPanel
	chatPanel = new ChatPanel();
	await chatPanel.setAgent(agent as any);
	installChatJsonlJumpListener();

	// Patch the AgentInterface to allow sending during streaming
	patchAgentInterface();

	// Fix: clear the streaming container on message_end to prevent the same
	// assistant message from rendering in BOTH message-list AND the streaming
	// container. The upstream AgentInterface only clears it on agent_end,
	// but between message_end and agent_end (while tools are executing)
	// the streaming container still holds the old streamMessage.
	agent.subscribe((ev) => {
		// Update JSONL panel path when session gets created (virtual → attached)
		if (ev.type === "agent_start" || ev.type === "agent_end") {
			setJsonlSessionPath(agent.sessionFile);
			refreshJsonlPanel();
		}
		if (ev.type === "message_end") {
			refreshJsonlPanel();
			const ai = chatPanel.agentInterface;
			if (ai) {
				const sc = ai.querySelector("streaming-message-container") as any;
				if (sc) {
					sc.setMessage(null, true);
				}
				// When an assistant message ends with toolUse, tools are about
				// to execute. The streaming container was just cleared (to avoid
				// duplicating text), so the tool calls now live only in the
				// message-list. But MessageList hides pending tool calls when
				// isStreaming=true (assuming StreamingMessageContainer shows them).
				// Since we cleared the streaming container, tell the message-list
				// to stop hiding pending tool calls so they remain visible with
				// their spinner/in-progress state during execution.
				// The next message_start will trigger a re-render that restores
				// isStreaming=true on the message-list (when the streaming
				// container takes over again).
				const msg = (ev as any).message;
				if (msg?.role === "assistant" && msg?.stopReason === "toolUse") {
					const ml = ai.querySelector("message-list") as any;
					if (ml) {
						ml.isStreaming = false;
						ml.requestUpdate();
					}
				}
			}
		}

		// Canvas tool: show side panel when tool_execution_end fires for "canvas"
		if (ev.type === "tool_execution_end" && (ev as any).toolName === "canvas") {
			const details = (ev as any).result?.details;
			if (details?.markdown) {
				showCanvas(details.title || "Canvas", details.markdown);
				// Mark this canvas as opened so restoreCanvasFromMessages won't reopen it
				if (agent.sessionFile) {
					const msgs = agent.state.messages;
					// The tool result was just appended — find its index (last canvas toolResult)
					for (let i = msgs.length - 1; i >= 0; i--) {
						const m = msgs[i] as any;
						if (m.role === "toolResult" && m.toolName === "canvas") {
							markCanvasOpened(canvasKey(agent.sessionFile, i));
							break;
						}
					}
				}
			}
		}
	});

	// Session switch: update session on existing chat panel (don't recreate agent-interface)
	agent.onSessionChange(async () => {
		const ai = chatPanel.agentInterface;
		if (ai) {
			ai.session = agent as any;
			ai.requestUpdate();
		}
		// Refresh steering queue for the new session (it's per-session now)
		steeringQueue = agent.steeringQueue;
		// Restore canvas if this session has one we haven't auto-opened yet
		restoreCanvasFromMessages(agent.state.messages, agent.sessionFile);
		// Update JSONL panel with new session path
		setJsonlSessionPath(agent.sessionFile);
		renderApp();
		// Focus the input textarea after switching/creating a session.
		// Must wait for Lit to finish rendering, then reach into the
		// message-editor shadow DOM to focus the actual textarea.
		requestAnimationFrame(() => {
			const editor = chatPanel?.agentInterface?.querySelector("message-editor") as any;
			if (editor) {
				const textarea = editor.shadowRoot?.querySelector("textarea") ??
					editor.textareaRef?.value;
				textarea?.focus();
			}
		});
	});

	// Content change (messages refreshed from disk): lightweight re-render
	agent.onContentChange(() => {
		const ai = chatPanel.agentInterface;
		if (ai) {
			ai.session = agent as any;
			ai.requestUpdate();
			// Fix: when tools are executing (pendingToolCalls non-empty) but
			// there's no stream message, the streaming container is empty and
			// the tool calls live only in message-list. But AgentInterface
			// passes isStreaming=true to message-list which causes it to hide
			// pending tool calls (assuming StreamingMessageContainer shows them).
			// After the render completes, correct this by telling message-list
			// not to hide pending tool calls.
			if (agent.state.isStreaming && agent.state.pendingToolCalls.size > 0 && !agent.state.streamMessage) {
				ai.updateComplete.then(() => {
					const ml = ai.querySelector("message-list") as any;
					if (ml && ml.isStreaming) {
						ml.isStreaming = false;
						ml.requestUpdate();
					}
				});
			}
		}
		// Restore canvas state from refreshed messages (won't reopen if already shown)
		restoreCanvasFromMessages(agent.state.messages, agent.sessionFile);
		// Refresh JSONL panel
		refreshJsonlPanel();
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

	agent.onPiInstallRequired(async (info) => {
		if (piInstallPromptOpen) return;
		piInstallPromptOpen = true;
		try {
			if (!info.installable) {
				alert(`${info.message}\n\nPlease install pi manually or set PI_CLI.`);
				return;
			}
			if (info.installing) return;
			const yes = window.confirm(`${info.message}\n\nInstall pi now? (npm install -g @mariozechner/pi-coding-agent)`);
			if (!yes) return;
			await agent.installPi();
			alert("pi installed. You can retry your action now.");
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			piInstallPromptOpen = false;
		}
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
				requestAnimationFrame(() => {
					const textarea = editor.shadowRoot?.querySelector("textarea") ??
						editor.textareaRef?.value;
					textarea?.focus();
				});
			}
		}
	};

	window.addEventListener("pi-fork-request", handleForkRequest);

	// Load models and start with a virtual new session
	const endLoadModelSpan = traceSpanStart("frontend_load_default_model");
	await agent.loadDefaultModel();
	endLoadModelSpan();

	const endNewSessionSpan = traceSpanStart("frontend_new_session");
	await agent.newSession();
	endNewSessionSpan();

	renderApp();
	traceInstant("frontend_first_render_complete", {
		sessionStatus: agent.sessionStatus,
	});
}

initApp();

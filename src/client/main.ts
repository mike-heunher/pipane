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
	CustomProvidersStore,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
// Import pi-web-ui so its custom elements get registered (user-message, assistant-message, etc.)
import { html, render } from "lit";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { DummyStorageBackend } from "./dummy-storage.js";
import "./session-picker.js";
import { registerCodingAgentRenderers } from "./tool-renderers.js";
import "./message-renderers.js";
import "./thinking-block-patch.js";
import "./pi-message-list.js";
import "./fork-modal.js";
import type { ForkModal } from "./fork-modal.js";
import "./app.css";
import { initCanvas, isCanvasVisible, showCanvas, restoreCanvasFromMessages, canvasKey, markCanvasOpened } from "./canvas-panel.js";
import { initJsonlPanel, isJsonlPanelVisible, toggleJsonlPanel, setJsonlSessionPath, refreshJsonlPanel, jumpToJsonlEntryForChat } from "./jsonl-panel.js";
import { openModelPickerDialog } from "./model-picker-dialog.js";
import { openLocalSettingsDialog } from "./local-settings-modal.js";
import { ensureInputMenuButton } from "./input-menu.js";
import { getLoadTraceId, sendNavigationTiming, traceInstant, traceSpanStart } from "./load-trace.js";
import { formatUsage } from "@mariozechner/pi-web-ui";

registerCodingAgentRenderers();
initThemes();

let agent: WsAgentAdapter;
let sidebarOpen = true;
let steeringQueue: readonly string[] = [];
let piInstallPromptOpen = false;
let localSettingsModalOpen = false;
let chatJsonlJumpListenerInstalled = false;
let prefetchedSessions: import("./ws-agent-adapter.js").SessionInfoDTO[] | undefined;
let autoScroll = true;
let lastScrollTop = 0;
let ignoreScrollEvents = false;

const isDevMode = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

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
if (isTokenUsageHidden()) {
	document.documentElement.classList.add("hide-token-usage");
}

/**
 * Configure message-editor's keyboard shortcuts, model picker, and input menu.
 */
function configureMessageEditor() {
	const editor = document.querySelector("message-editor") as any;
	if (!editor) return;

	editor.allowSendDuringStreaming = true;

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
			return true;
		}
		return false;
	};

	editor.onModelSelect = async () => {
		try {
			const models = await agent.fetchAvailableModels();
			const selected = await openModelPickerDialog(models as any, agent.state.model as any);
			if (selected) agent.setModel(selected as any);
		} catch (err) {
			console.error("Failed to open model picker:", err);
		}
	};

	ensureInputMenuButton(editor, () => agent?.sessionFile);

	const origUpdated = editor.updated?.bind(editor);
	editor.updated = (changedProps: Map<string, any>) => {
		origUpdated?.(changedProps);
		ensureInputMenuButton(editor, () => agent?.sessionFile);
	};
}

function handleSend(input: string, attachments?: any[]) {
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

	// Clear the editor after capturing the input
	const editor = document.querySelector("message-editor") as any;
	if (editor) {
		editor.value = "";
		editor.attachments = [];
	}

	autoScroll = true;
	agent.prompt(fullInput, images.length > 0 ? images : undefined).catch((err) => {
		console.error("Prompt failed:", err);
	});
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

		const messageList = document.querySelector("pi-message-list") as HTMLElement | null;
		if (!messageList || !messageList.contains(target)) return;

		let displayedMessageOrdinal = NaN;
		const messageWrapper = target.closest("[data-message-index]") as HTMLElement | null;
		const indexRaw = messageWrapper?.getAttribute("data-message-index");
		if (indexRaw != null) {
			displayedMessageOrdinal = Number(indexRaw);
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
			${steeringQueue.map((msg, i) => html`
				<div class="steering-chip">
					<span class="steering-chip-num">${i + 1}</span>
					<span class="steering-chip-text">${msg.length > 80 ? msg.slice(0, 80) + "…" : msg}</span>
					<button class="steering-chip-remove" @click=${() => { agent.removeSteering(i); }} title="Remove from queue">
						<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				</div>
			`)}
		</div>
	`;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

function modelSupportsThinking(model: any): boolean {
	if (!model) return false;
	if (typeof model.reasoning === "boolean") return model.reasoning;
	const provider = String(model.provider ?? "").toLowerCase();
	const id = String(model.id ?? "").toLowerCase();
	if (provider === "openai-codex") return true;
	if (provider === "openai" && id.startsWith("gpt-5")) return true;
	return false;
}

function renderThinkingButton() {
	if (!agent) return "";
	const model = agent.state?.model;
	if (!modelSupportsThinking(model)) return "";

	const level = agent.state?.thinkingLevel ?? "off";
	const idx = THINKING_LEVELS.indexOf(level);
	const nextLevel = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];

	// 4 bars, filled up to the current level (off=0, minimal=1, low=2, medium=3, high=4)
	const filledBars = idx; // off=0, minimal=1, low=2, medium=3, high=4
	const title = `Thinking: ${level} (click to switch to ${nextLevel})`;

	return html`
		<button
			class="thinking-icon-btn"
			@click=${() => agent?.setThinkingLevel(nextLevel)}
			title=${title}
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/>
				<path d="M9 21h6"/>
			</svg>
			<span class="thinking-bars" data-level="${filledBars}">
				${[0, 1, 2, 3].map(i => html`<span class="thinking-bar ${i < filledBars ? "filled" : ""}"></span>`)}
			</span>
		</button>
	`;
}

function renderToolbarExtras() {
	return html`${renderThinkingButton()}${renderTokenUsage()}`;
}

async function openLocalSettingsModal() {
	if (localSettingsModalOpen) return;
	localSettingsModalOpen = true;
	try {
		await openLocalSettingsDialog({
			onSaved: () => {
				renderApp();
				const picker = document.querySelector("session-picker") as any;
				picker?.refreshSessions?.();
			},
		});
	} finally {
		localSettingsModalOpen = false;
	}
}

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function renderTokenUsage() {
	if (!agent) return "";
	const state = agent.state;
	const totals = state.messages
		.filter((m: any) => m.role === "assistant")
		.reduce((acc: any, msg: any) => {
			const usage = msg.usage;
			if (usage) {
				acc.input += usage.input ?? usage.inputTokens ?? 0;
				acc.output += usage.output ?? usage.outputTokens ?? 0;
				acc.cacheRead += usage.cacheRead ?? 0;
				acc.cacheWrite += usage.cacheWrite ?? 0;
				acc.cost.total += usage.cost?.total ?? usage.totalCost ?? 0;
			}
			return acc;
		}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

	const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
	if (!hasTotals) return "";

	try {
		const parts: string[] = [];
		if (totals.input) parts.push(`↑${fmtTok(totals.input)}`);
		if (totals.output) parts.push(`↓${fmtTok(totals.output)}`);
		if (totals.cost?.total) parts.push(`$${totals.cost.total < 0.01 ? totals.cost.total.toFixed(4) : totals.cost.total < 1 ? totals.cost.total.toFixed(3) : totals.cost.total.toFixed(2)}`);
		if (!parts.length) return "";
		return html`<span class="input-token-usage">${parts.join(" ")}</span>`;
	} catch {
		return "";
	}
}

function handleScroll(e: Event) {
	const el = e.target as HTMLElement;
	if (!el) return;

	// After a session switch or programmatic scroll-to-bottom, ignore scroll
	// events until the programmatic scroll settles. This prevents the browser's
	// intermediate scroll adjustments from disabling autoScroll.
	if (ignoreScrollEvents) return;

	const currentScrollTop = el.scrollTop;
	const distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;

	if (currentScrollTop !== 0 && currentScrollTop < lastScrollTop && distanceFromBottom > 50) {
		autoScroll = false;
	} else if (distanceFromBottom < 10) {
		autoScroll = true;
	}
	lastScrollTop = currentScrollTop;
}

function scrollToBottomIfNeeded() {
	if (!autoScroll) return;
	ignoreScrollEvents = true;
	requestAnimationFrame(() => {
		const scrollArea = document.getElementById("chat-scroll-area");
		if (scrollArea) {
			scrollArea.scrollTop = scrollArea.scrollHeight;
			lastScrollTop = scrollArea.scrollTop;
		}
		// Re-enable scroll event handling after the programmatic scroll settles.
		// Use a second rAF to ensure the browser has processed the scroll.
		requestAnimationFrame(() => {
			ignoreScrollEvents = false;
		});
	});
}

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const state = agent?.state;
	const messages = state?.messages ?? [];
	const isStreaming = state?.isStreaming ?? false;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0 ${isDevMode ? 'dev-header' : ''}">
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
					<span class="text-base font-semibold text-foreground">${isDevMode ? "pi web · dev" : "pi web"}</span>
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
						class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
						@click=${() => { void openLocalSettingsModal(); }}
						title="Open local settings (~/.piweb/settings.json)"
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
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
							<session-picker .agent=${agent} .prefetchedSessions=${prefetchedSessions}></session-picker>
						</div>
					`
					: ""}
				<div class="flex-1 overflow-hidden flex flex-col">
					${agent && !agent.isConnected
						? html`
							<div class="flex items-center justify-center gap-2 px-4 py-1.5 bg-yellow-500/15 border-b border-yellow-500/30 text-sm text-yellow-700 dark:text-yellow-400">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 animate-spin" style="animation-duration: 1.5s;">
									<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
								</svg>
								<span>Reconnecting to server…</span>
							</div>
						`
						: ""}
					${agent?.sessionStatus === "virtual" && agent?.cwd && messages.length === 0
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
						<div class="flex-1 overflow-hidden relative flex flex-col">
							<!-- Messages area -->
							<div id="chat-scroll-area" class="flex-1 overflow-y-auto" @scroll=${handleScroll}>
								<div class="max-w-3xl mx-auto p-4 pb-4">
									<pi-message-list
										.messages=${messages}
										.isStreaming=${isStreaming}
										.pendingToolCalls=${agent?.pendingToolCallIds ?? new Set()}
									></pi-message-list>
								</div>
							</div>
							<!-- Steering queue (between messages and input) -->
							${renderSteeringQueue()}
							<!-- Input area -->
							<div class="shrink-0 border-t border-border">
								<div class="max-w-3xl mx-auto px-2">
									<message-editor
										.isStreaming=${isStreaming}
										.allowSendDuringStreaming=${true}
										.currentModel=${state?.model}
										.thinkingLevel=${state?.thinkingLevel ?? "off"}
										.showAttachmentButton=${true}
										.showModelSelector=${true}
										.showThinkingSelector=${false}
										.onSend=${(input: string, attachments?: any[]) => handleSend(input, attachments)}
										.onAbort=${() => agent?.abort()}
										.onThinkingChange=${(level: any) => agent?.setThinkingLevel(level)}
										.extraToolbarButtons=${() => renderToolbarExtras()}
									></message-editor>
								</div>
							</div>
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

	// Post-render setup
	requestAnimationFrame(() => {
		configureMessageEditor();
		scrollToBottomIfNeeded();
		const canvasEl = document.getElementById("canvas-container");
		if (canvasEl) initCanvas(canvasEl, renderApp);
		const jsonlEl = document.getElementById("jsonl-container");
		if (jsonlEl) initJsonlPanel(jsonlEl, renderApp);
	});
};

/**
 * Fork the current session and prompt in the new fork.
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

	let connectingOverlayTimer: ReturnType<typeof setTimeout> | undefined;
	const skeletonShell = document.getElementById("skeleton-shell");
	connectingOverlayTimer = setTimeout(() => {
		if (skeletonShell?.parentElement === app) {
			const overlay = document.createElement("div");
			overlay.id = "connecting-overlay";
			overlay.style.cssText = "position:absolute;bottom:2rem;left:50%;transform:translateX(-50%);color:var(--muted-foreground,#6b7280);font-size:0.8rem;z-index:10;";
			overlay.textContent = "Connecting…";
			skeletonShell.style.position = "relative";
			skeletonShell.appendChild(overlay);
		}
	}, 300);

	// Initialize storage (needed by upstream components)
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

	const sessionsPrefetch = agent.listSessions().catch((err) => {
		console.error("Failed to prefetch sessions:", err);
		return undefined;
	});

	installChatJsonlJumpListener();

	// Canvas tool: show side panel when tool_execution_end fires for "canvas"
	agent.subscribe((ev) => {
		if (ev.type === "agent_start" || ev.type === "agent_end") {
			setJsonlSessionPath(agent.sessionFile);
			refreshJsonlPanel();
		}
		if (ev.type === "message_end") {
			refreshJsonlPanel();
		}

		if (ev.type === "tool_execution_end" && (ev as any).toolName === "canvas") {
			const details = (ev as any).result?.details;
			if (details?.markdown) {
				showCanvas(details.title || "Canvas", details.markdown);
				if (agent.sessionFile) {
					const msgs = agent.state.messages;
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

	// Session switch
	agent.onSessionChange(async () => {
		steeringQueue = agent.steeringQueue;
		restoreCanvasFromMessages(agent.state.messages, agent.sessionFile);
		setJsonlSessionPath(agent.sessionFile);
		autoScroll = true;
		lastScrollTop = 0;
		ignoreScrollEvents = false;
		renderApp();
		requestAnimationFrame(() => {
			const editor = document.querySelector("message-editor") as any;
			const textarea = editor?.shadowRoot?.querySelector("textarea") ?? editor?.textareaRef?.value;
			textarea?.focus();
		});
	});

	// Content change — just re-render
	agent.onContentChange(() => {
		restoreCanvasFromMessages(agent.state.messages, agent.sessionFile);
		refreshJsonlPanel();
		renderApp();
		scrollToBottomIfNeeded();
	});

	// Status change
	agent.onStatusChange(() => {
		renderApp();
	});

	// Connection change — show/hide reconnection banner
	agent.onConnectionChange((connected) => {
		renderApp();
	});

	// Steering queue change
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

	// Fork request handler
	const handleForkRequest = async () => {
		if (!agent.sessionFile || agent.sessionStatus === "virtual") return;

		const modal = document.createElement("fork-modal") as ForkModal;
		document.body.appendChild(modal);

		const result = await modal.open(agent);
		if (!result) return;

		if (result.newSessionPath) {
			await agent.switchSession(result.newSessionPath);
		}

		if (result.text) {
			const editor = document.querySelector("message-editor") as any;
			if (editor) {
				editor.value = result.text;
				editor.requestUpdate();
				requestAnimationFrame(() => {
					const textarea = editor.shadowRoot?.querySelector("textarea") ?? editor.textareaRef?.value;
					textarea?.focus();
				});
			}
		}
	};

	window.addEventListener("pi-fork-request", handleForkRequest);

	// Load models
	const endLoadModelSpan = traceSpanStart("frontend_load_default_model");
	await agent.loadDefaultModel();
	endLoadModelSpan();

	prefetchedSessions = (await sessionsPrefetch) ?? undefined;

	const endNewSessionSpan = traceSpanStart("frontend_new_session");
	if (prefetchedSessions && prefetchedSessions.length > 0) {
		const mostRecent = prefetchedSessions.reduce((best, s) => {
			const bestTime = best.lastUserPromptTime ? new Date(best.lastUserPromptTime).getTime() : new Date(best.modified).getTime();
			const sTime = s.lastUserPromptTime ? new Date(s.lastUserPromptTime).getTime() : new Date(s.modified).getTime();
			return sTime > bestTime ? s : best;
		});
		await agent.switchSession(mostRecent.path);
	} else {
		await agent.newSession();
	}
	endNewSessionSpan();

	renderApp();

	prefetchedSessions = undefined;

	traceInstant("frontend_first_render_complete", {
		sessionStatus: agent.sessionStatus,
	});
}

initApp();

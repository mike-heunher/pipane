// Unregister any stale service workers from previous apps on this port
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (const r of registrations) r.unregister();
	});
}

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { initThemes, getShowTokenUsage, setShowTokenUsage, resyncAppearanceFromServer } from "./theme-selector.js";
import {
	AppStorage,
	CustomProvidersStore,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
// Import pi-web-ui so its custom elements get registered
import { html, render } from "lit";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { computeTokenUsageParts } from "./token-usage.js";
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
import { loadAutoCollapseSettings, resetAutoCollapse, runAutoCollapse } from "./auto-collapse.js";

import { getLoadTraceId, sendNavigationTiming, traceInstant, traceSpanStart } from "./load-trace.js";
import { formatUsage } from "@mariozechner/pi-web-ui";

registerCodingAgentRenderers();
initThemes();

let agent: WsAgentAdapter;
const isMobile = () => window.innerWidth <= 768;
let wasMobile = isMobile();
let mobileSidebarOpen = false;
let steeringQueue: readonly string[] = [];

// Re-render when crossing the mobile/desktop breakpoint so the sidebar
// instantly switches between inline (desktop) and overlay (mobile).
window.addEventListener("resize", () => {
	const nowMobile = isMobile();
	if (nowMobile !== wasMobile) {
		wasMobile = nowMobile;
		// Close mobile overlay when switching back to desktop
		if (!nowMobile) mobileSidebarOpen = false;
		renderApp();
	}
});
let piInstallPromptOpen = false;
let localSettingsModalOpen = false;
let chatJsonlJumpListenerInstalled = false;
let prefetchedSessions: import("./ws-agent-adapter.js").SessionInfoDTO[] | undefined;
let autoScroll = true;
let lastScrollTop = 0;
let ignoreScrollEvents = false;
let canvasFeatureEnabled = false;
let sessionsPerProject = 5;
let messagesInitialCount = 50;
let pendingHardKillOfferFor: string | null = null;

const isDevMode = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

traceInstant("frontend_bootstrap_loaded", { url: window.location.pathname });

// Token usage visibility — backed by settings.json via theme-selector
function isTokenUsageHidden(): boolean {
	return !getShowTokenUsage();
}
function toggleTokenUsage() {
	setShowTokenUsage(!getShowTokenUsage());
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

	const origUpdated = editor.updated?.bind(editor);
	editor.updated = (changedProps: Map<string, any>) => {
		origUpdated?.(changedProps);
	};
}

function clearPendingHardKillOffer() {
	pendingHardKillOfferFor = null;
}

async function handleStopClick() {
	if (!agent?.sessionFile) return;
	const sessionPath = agent.sessionFile;
	const isStillRunning = agent.getSessionStatus(sessionPath) === "running";

	if (pendingHardKillOfferFor === sessionPath && isStillRunning) {
		const yes = window.confirm("The agent still appears to be running.\n\nHard kill the connected pi process? A new one will be spawned automatically for future prompts.");
		if (yes) {
			agent.hardKill();
		}
		clearPendingHardKillOffer();
		return;
	}

	pendingHardKillOfferFor = sessionPath;
	agent.abort();
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
		agent.reportError(err, "Prompt failed");
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
				loadAutoCollapseSettings();
				renderApp();
				const picker = document.querySelector("session-picker") as any;
				picker?.refreshSessions?.();
			},
		});
	} finally {
		localSettingsModalOpen = false;
	}
}

// Cache the last rendered token usage HTML to avoid flicker during session switches
// (messages are cleared to [] before the new session_sync arrives).
let lastTokenUsageHtml: ReturnType<typeof html> | "" = "";

function renderTokenUsage() {
	if (!agent) return "";
	const state = agent.state;

	const result = computeTokenUsageParts(state.messages, state.model?.contextWindow);
	if (result.parts === null) return lastTokenUsageHtml; // empty messages, keep cache
	if (!result.parts.length) { lastTokenUsageHtml = ""; return ""; }

	lastTokenUsageHtml = html`<span class="input-token-usage">${result.parts.join(" ")}</span>`;
	return lastTokenUsageHtml;
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

	// Remove the static skeleton shell from index.html on first real render.
	// Lit's render() doesn't clear pre-existing DOM children, so we must
	// remove it explicitly to avoid it lingering behind the real app.
	const skeletonShell = document.getElementById("skeleton-shell");
	if (skeletonShell) skeletonShell.remove();

	const state = agent?.state;
	const messages = state?.messages ?? [];
	const isStreaming = state?.isStreaming ?? false;

	const burgerMenuCallbacks = {
		onToggleTokenUsage: () => { toggleTokenUsage(); renderApp(); },
		onOpenSettings: () => { void openLocalSettingsModal(); },
		onToggleJsonl: () => { toggleJsonlPanel(); renderApp(); },
		isTokenUsageHidden: isTokenUsageHidden(),
		isJsonlVisible: isJsonlPanelVisible(),
		isDevMode,
	};

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Main content: sidebar + chat -->
			<div class="flex flex-1 overflow-hidden">
				${!isMobile()
					? html`
						<div class="shrink-0 border-r border-border bg-background overflow-hidden" style="width: 280px;">
							<session-picker .agent=${agent} .prefetchedSessions=${prefetchedSessions} .burgerMenu=${burgerMenuCallbacks} .sessionsPerProject=${sessionsPerProject}></session-picker>
						</div>
					`
					: ""}
				<div class="flex-1 overflow-hidden flex flex-col">
					${isMobile()
						? html`
							<button
								class="mobile-sidebar-btn"
								@click=${() => { mobileSidebarOpen = true; renderApp(); }}
								title="Open sessions"
							>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<line x1="3" y1="12" x2="21" y2="12"></line>
									<line x1="3" y1="6" x2="21" y2="6"></line>
									<line x1="3" y1="18" x2="21" y2="18"></line>
								</svg>
							</button>
						`
						: ""}
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
					${state?.error
						? html`
							<div class="flex items-center gap-2 px-4 py-1.5 bg-red-500/15 border-b border-red-500/30 text-sm text-red-700 dark:text-red-400" title=${state.error}>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
									<circle cx="12" cy="12" r="10"></circle>
									<line x1="12" y1="8" x2="12" y2="12"></line>
									<line x1="12" y1="16" x2="12.01" y2="16"></line>
								</svg>
								<span class="truncate">${state.error}</span>
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
										.initialCount=${messagesInitialCount}
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
										.onAbort=${() => handleStopClick()}
										.onThinkingChange=${(level: any) => agent?.setThinkingLevel(level)}
										.extraToolbarButtons=${() => renderToolbarExtras()}
									></message-editor>
								</div>
							</div>
						</div>
						${canvasFeatureEnabled && isCanvasVisible()
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

	// Mobile sidebar overlay
	if (mobileSidebarOpen && isMobile()) {
		const mobileOverlay = html`
			<div class="sidebar-mobile-overlay">
				<div class="sidebar-panel shrink-0 border-r border-border bg-background overflow-hidden">
					<session-picker .agent=${agent} .prefetchedSessions=${prefetchedSessions} .burgerMenu=${burgerMenuCallbacks} .sessionsPerProject=${sessionsPerProject}></session-picker>
				</div>
				<div class="sidebar-mobile-backdrop" @click=${() => { mobileSidebarOpen = false; renderApp(); }}></div>
			</div>
		`;
		render(html`${appHtml}${mobileOverlay}`, app);
	} else {
		render(appHtml, app);
	}

	// Post-render setup
	requestAnimationFrame(() => {
		configureMessageEditor();
		scrollToBottomIfNeeded();
		runAutoCollapse();
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

	try {
		await agent.forkAndPrompt(fullInput, images.length > 0 ? images : undefined);
	} catch (err) {
		agent.reportError(err, "Fork prompt failed");
		console.error("Fork prompt failed:", err);
	}
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

	// Fetch local settings to check feature flags
	try {
		const settingsRes = await fetch("/api/settings/local");
		if (settingsRes.ok) {
			const settingsData = await settingsRes.json();
			canvasFeatureEnabled = settingsData.settings?.canvas?.enabled === true;
			if (typeof settingsData.settings?.sidebar?.sessionsPerProject === "number") {
				sessionsPerProject = settingsData.settings.sidebar.sessionsPerProject;
			}
			if (typeof settingsData.settings?.messages?.initialCount === "number") {
				messagesInitialCount = settingsData.settings.messages.initialCount;
			}
		}
	} catch {
		// Ignore — canvas stays disabled by default
	}

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

		if (canvasFeatureEnabled && ev.type === "tool_execution_end" && (ev as any).toolName === "canvas") {
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

	// Re-fetch feature flags and appearance when local settings change
	agent.onSessionsChanged(async (file) => {
		if (file !== "__local_settings__") return;
		try {
			const res = await fetch("/api/settings/local");
			if (res.ok) {
				const data = await res.json();
				canvasFeatureEnabled = data.settings?.canvas?.enabled === true;
				if (typeof data.settings?.sidebar?.sessionsPerProject === "number") {
					sessionsPerProject = data.settings.sidebar.sessionsPerProject;
				}
				if (typeof data.settings?.messages?.initialCount === "number") {
					messagesInitialCount = data.settings.messages.initialCount;
				}
			}
		} catch { /* ignore */ }
		await resyncAppearanceFromServer();
		renderApp();
	});

	// Session switch
	agent.onSessionChange(async () => {
		clearPendingHardKillOffer();
		steeringQueue = agent.steeringQueue;
		resetAutoCollapse();
		// Reset message truncation so the new session shows the last N messages
		const messageList = document.querySelector("pi-message-list") as any;
		if (messageList?.resetVisibleCount) messageList.resetVisibleCount();
		if (canvasFeatureEnabled) restoreCanvasFromMessages(agent.state.messages, agent.sessionFile);
		setJsonlSessionPath(agent.sessionFile);
		autoScroll = true;
		lastScrollTop = 0;
		ignoreScrollEvents = false;
		// Auto-close sidebar overlay on mobile after session switch
		if (isMobile()) mobileSidebarOpen = false;
		renderApp();
		requestAnimationFrame(() => {
			const editor = document.querySelector("message-editor") as any;
			const textarea = editor?.shadowRoot?.querySelector("textarea") ?? editor?.textareaRef?.value;
			textarea?.focus();
		});
	});

	// Content change — just re-render
	agent.onContentChange(() => {
		if (canvasFeatureEnabled) restoreCanvasFromMessages(agent.state.messages, agent.sessionFile);
		refreshJsonlPanel();
		renderApp();
		scrollToBottomIfNeeded();
	});

	// Status change
	agent.onStatusChange(() => {
		if (!agent.sessionFile || agent.getSessionStatus(agent.sessionFile) !== "running") {
			clearPendingHardKillOffer();
		}
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

	// Load auto-collapse settings
	loadAutoCollapseSettings();

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

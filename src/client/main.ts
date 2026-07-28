import { initThemes, resyncAppearanceFromServer } from "./theme-selector.js";
import { html, render } from "lit";
import { live } from "lit/directives/live.js";
import type { BackendClient, SessionInfoDTO } from "./backend-client.js";
import { ConversationScrollController } from "./conversation-scroll.js";
import { conversationDraftKey, ConversationDraftStore } from "./conversation-drafts.js";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { consumeAppRuntime } from "./app-runtime.js";
import { computeTokenUsageSummary, type TokenUsageSummary } from "./token-usage.js";
import { LOCAL_BACKEND_UPDATE_KEY } from "./session-picker.js";
import "./ui/index.js";
import type { MessageEditor } from "./ui/components/MessageEditor.js";
import type { Attachment } from "./ui/utils/attachment-utils.js";
import { buildAttachmentPromptPayload } from "./attachment-prompt.js";
import { uploadAttachmentFile } from "./file-upload.js";
import { getPromptFailureSession } from "./prompt-failure.js";
import { mergeSlashCommands, type SlashCommandSuggestion } from "./slash-commands.js";
import "./fork-modal.js";
import type { ForkModal } from "./fork-modal.js";
import "./app.css";
import { closeCanvas, initCanvas, isCanvasVisible, restoreCanvasFromMessages } from "./canvas-panel.js";
import { initJsonlPanel, isJsonlPanelVisible, toggleJsonlPanel, setJsonlSessionPath, refreshJsonlPanel, jumpToJsonlEntryForChat } from "./jsonl-panel.js";
import {
	closeFilePreview,
	getFilePreviewPath,
	initFilePreview,
	isFilePreviewVisible,
	isPreviewableFileHref,
	openFilePreviewLink,
	openFilePreviewLinkInNewWindow,
	setFilePreviewSession,
} from "./file-preview-panel.js";
import { openModelPickerDialog } from "./model-picker-dialog.js";
import { openLocalSettingsDialog } from "./local-settings-modal.js";
import { enterSettingsRoute, isSettingsPath, leaveSettingsRoute } from "./settings-route.js";
import { openConnectionDiagnosticsDialog } from "./connection-diagnostics-dialog.js";
import { openTurnRelayDialog } from "./turn-relay-dialog.js";
import { openDeviceInviteDialog } from "./device-invite-dialog.js";
import { loadAutoCollapseSettings, resetAutoCollapse, runAutoCollapse } from "./auto-collapse.js";
import { contextUsageTone, dismissStatusDetailsOnOutsideClick } from "./status-usage.js";
import type { UpdateNotice, UpdateTarget } from "../shared/updates.js";
import {
	UpdateNoticeSnoozeStore,
	updateConfirmationMessage,
	updateNoticeTitle,
} from "./update-notifications.js";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ThinkingLevelValue,
} from "../shared/thinking-levels.js";

const appRuntime = consumeAppRuntime(() => new WsAgentAdapter());
const agent: BackendClient = appRuntime.client;
initThemes(agent);
document.addEventListener("click", dismissStatusDetailsOnOutsideClick);
document.addEventListener("keydown", handleConversationKeyDown);

function syncAppViewport(): void {
	const viewport = window.visualViewport;
	const rootStyle = document.documentElement.style;
	rootStyle.setProperty("--app-viewport-top", `${viewport?.offsetTop ?? 0}px`);
	rootStyle.setProperty("--app-viewport-left", `${viewport?.offsetLeft ?? 0}px`);
	rootStyle.setProperty("--app-viewport-width", `${viewport?.width ?? window.innerWidth}px`);
	rootStyle.setProperty("--app-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
}

syncAppViewport();
window.visualViewport?.addEventListener("resize", syncAppViewport);
window.visualViewport?.addEventListener("scroll", syncAppViewport);
window.addEventListener("resize", syncAppViewport);

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
let routedSettingsAbort: AbortController | undefined;
let connectionDiagnosticsOpen = false;
let turnRelaySettingsOpen = false;
let deviceInviteOpen = false;
let chatJsonlJumpListenerInstalled = false;
let filePreviewLinkListenerInstalled = false;
let prefetchedSessions: SessionInfoDTO[] | undefined;
const conversationScroll = new ConversationScrollController();
let conversationTouchY: number | undefined;
let canvasFeatureEnabled = false;
let sessionsPerProject = 5;
let messagesInitialCount = 50;
let hideOlderThinking = false;
let keepThinkingParts = 3;
let pendingHardKillOfferFor: string | null = null;
let updateNoticesByBackend = new Map<string, UpdateNotice[]>();
let updatingByBackend = new Map<string, Set<UpdateTarget>>();
let updateFeedbackByBackend = new Map<string, { kind: "success" | "error"; message: string }>();
const updateNoticeSnoozes = new UpdateNoticeSnoozeStore(window.localStorage);
let updateSnoozeRefreshTimer: number | undefined;
let slashCommands: SlashCommandSuggestion[] = mergeSlashCommands([]);
let slashCommandRequest = 0;
const conversationDrafts = new ConversationDraftStore<Attachment>();

function openMobileSidebar(): void {
	// Mobile Safari does not reliably move focus from a textarea to a tapped
	// button. Blur explicitly so opening the sidebar dismisses the keyboard.
	getMessageEditor()?.querySelector("textarea")?.blur();
	mobileSidebarOpen = true;
	renderApp();
}

function applyBackendSettings(payload: { settings?: any }): void {
	canvasFeatureEnabled = payload.settings?.canvas?.enabled === true;
	if (typeof payload.settings?.sidebar?.sessionsPerProject === "number") {
		sessionsPerProject = payload.settings.sidebar.sessionsPerProject;
	}
	if (typeof payload.settings?.messages?.initialCount === "number") {
		messagesInitialCount = payload.settings.messages.initialCount;
	}
	hideOlderThinking = payload.settings?.messages?.hideOlderThinking === true;
	if (typeof payload.settings?.messages?.keepThinkingParts === "number") {
		keepThinkingParts = payload.settings.messages.keepThinkingParts;
	} else {
		keepThinkingParts = 3;
	}
}

const isDevMode = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);


function getMessageEditor(): MessageEditor | null {
	return document.querySelector("message-editor") as MessageEditor | null;
}

function currentSessionScopeKey(): string {
	const session = agent.sessionFile ?? `virtual:${agent.sessionId}`;
	return agent.activeBackendId ? `${agent.activeBackendId}\u0000${session}` : session;
}

function currentCanvasTrackingScope(): string | undefined {
	if (!agent.sessionFile) return undefined;
	const basename = agent.sessionFile.split("/").pop() || agent.sessionFile;
	return agent.activeBackendId ? `${agent.activeBackendId}:${basename}` : basename;
}

function currentConversationDraftKey(): string {
	return conversationDraftKey(agent.sessionFile, agent.sessionId, agent.activeBackendId);
}

function clearConversationDraft(draftKey: string): void {
	conversationDrafts.clear(draftKey);
	if (draftKey !== currentConversationDraftKey()) return;
	const editor = getMessageEditor();
	if (!editor) return;
	editor.value = "";
	editor.attachments = [];
}

function slashCommandScope(): string {
	const scope = agent.sessionFile ? `session:${agent.sessionFile}` : `cwd:${agent.cwd ?? ""}`;
	return agent.activeBackendId ? `${agent.activeBackendId}\u0000${scope}` : scope;
}

async function refreshSlashCommands(): Promise<void> {
	const request = ++slashCommandRequest;
	const scope = slashCommandScope();
	// Never show project commands from the previously selected conversation.
	slashCommands = mergeSlashCommands([]);
	renderApp();

	const commands = await agent.fetchCommands();
	if (request !== slashCommandRequest || scope !== slashCommandScope()) return;
	slashCommands = mergeSlashCommands(commands);
	renderApp();
}

function handleEditorKeyDown(event: KeyboardEvent): boolean {
	if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.shiftKey) return false;

	event.preventDefault();
	const editor = getMessageEditor();
	if (!editor || editor.processingFiles || (!editor.value.trim() && editor.attachments.length === 0)) return true;

	const value = editor.value;
	const attachments = editor.attachments;
	handleForkAndPrompt(value, attachments);
	return true;
}

async function handleModelSelect(): Promise<void> {
	try {
		const models = await agent.fetchAvailableModels();
		const selected = await openModelPickerDialog(models as any, agent.state.model as any);
		if (selected) agent.setModel(selected as any);
	} catch (err) {
		console.error("Failed to open model picker:", err);
	}
}

function clearPendingHardKillOffer(): void {
	pendingHardKillOfferFor = null;
}

function handleStopClick(): void {
	if (!agent?.sessionFile) return;
	const sessionPath = agent.sessionFile;
	const sessionKey = currentSessionScopeKey();
	const isStillRunning = agent.getSessionStatus(sessionPath, agent.activeBackendId) === "running";

	if (pendingHardKillOfferFor === sessionKey && isStillRunning) {
		const confirmed = window.confirm("The agent still appears to be running.\n\nHard kill the connected pi process? A new one will be spawned automatically for future prompts.");
		if (confirmed) agent.hardKill();
		clearPendingHardKillOffer();
		return;
	}

	pendingHardKillOfferFor = sessionKey;
	agent.abort();
}

async function uploadEditorAttachment(attachment: Attachment): Promise<string> {
	return (await uploadAttachmentFile(agent, attachment)).path;
}

type PromptMode = "prompt" | "fork";

function submitPrompt(input: string, attachments: readonly Attachment[] | undefined, mode: PromptMode): void {
	const submittedAttachments = (attachments ?? []).map((attachment) => ({ ...attachment }));
	const payload = buildAttachmentPromptPayload(input, submittedAttachments, {
		useUploadedImageReferences: agent.supportsUploadedImagePrompt === true,
	});
	const submittedDraftKey = currentConversationDraftKey();
	const submittedBackendId = agent.activeBackendId;

	// Clear only this conversation's editor after capturing a complete retry copy.
	clearConversationDraft(submittedDraftKey);
	conversationScroll.pinToBottom();

	const prefix = mode === "fork" ? "Fork prompt failed" : "Prompt failed";
	const restore = (error: unknown) => {
		const targetSessionPath = getPromptFailureSession(error);
		const targetDraftKey = targetSessionPath
			? conversationDraftKey(targetSessionPath, "", submittedBackendId)
			: submittedDraftKey;
		conversationDrafts.restore(targetDraftKey, input, submittedAttachments);
		agent.reportError(error, prefix);
		if (targetDraftKey === currentConversationDraftKey()) renderApp();
		console.error(`${prefix}:`, error);
	};

	try {
		const request = mode === "fork"
			? agent.forkAndPrompt(payload.input, payload.images)
			: agent.prompt(payload.input, payload.images);
		void request.catch(restore);
	} catch (error) {
		restore(error);
	}
}

function handleSend(input: string, attachments?: Attachment[]): void {
	submitPrompt(input, attachments, "prompt");
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

function handleFilePreviewLinkEvent(event: MouseEvent, openInNewWindow: boolean): void {
	if (event.defaultPrevented || event.altKey) return;
	const target = event.target as HTMLElement | null;
	const anchor = target?.closest("a") as HTMLAnchorElement | null;
	if (!anchor) return;

	const messageList = document.querySelector("pi-message-list");
	const previewPanel = anchor.closest(".file-preview-panel");
	if (!previewPanel && (!messageList || !messageList.contains(anchor))) return;

	const rawHref = anchor.getAttribute("href") ?? "";
	const cwd = agent?.cwd;
	const sessionPath = agent?.sessionFile;
	if (!cwd || !sessionPath || !isPreviewableFileHref(rawHref)) return;
	const handled = openInNewWindow
		? openFilePreviewLinkInNewWindow(rawHref, cwd, sessionPath, previewPanel ? getFilePreviewPath() : undefined, agent)
		: openFilePreviewLink(rawHref, cwd, sessionPath, previewPanel ? getFilePreviewPath() : undefined, agent, currentSessionScopeKey());
	if (!handled) return;

	event.preventDefault();
	if (!openInNewWindow) {
		if (isCanvasVisible()) closeCanvas();
		if (isJsonlPanelVisible()) toggleJsonlPanel();
		renderApp();
	}
}

function installFilePreviewLinkListener() {
	if (filePreviewLinkListenerInstalled) return;
	filePreviewLinkListenerInstalled = true;

	document.addEventListener("click", (event) => {
		if (event.button !== 0) return;
		handleFilePreviewLinkEvent(event, event.metaKey || event.ctrlKey || event.shiftKey);
	});
	document.addEventListener("auxclick", (event) => {
		if (event.button !== 1) return;
		handleFilePreviewLinkEvent(event, true);
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

function renderThinkingButton() {
	if (!agent) return "";
	const model = agent.state?.model;
	const supportedLevels = getSupportedThinkingLevels(model);
	if (supportedLevels.length < 2) return "";

	const rawLevel = String(agent.state?.thinkingLevel ?? "off");
	const level = supportedLevels.includes(rawLevel as ThinkingLevelValue)
		? rawLevel as ThinkingLevelValue
		: clampThinkingLevel(model, rawLevel);
	const idx = supportedLevels.indexOf(level);
	const nextLevel = supportedLevels[(idx + 1) % supportedLevels.length];
	const title = `Reasoning: ${level} (click to switch to ${nextLevel})`;

	return html`
		<span class="status-separator" aria-hidden="true">·</span>
		<button
			class="thinking-icon-btn"
			@click=${() => agent?.setThinkingLevel(nextLevel)}
			title=${title}
			aria-label=${title}
		>
			<span class="thinking-level-label">${level}</span>
		</button>
	`;
}

type ProviderStatus = {
	key: string;
	text: string;
	providerLabel: string;
	percent?: number;
	percentLabel?: string;
	windowLabel?: string;
	usageTooltip: string;
};

function providerDisplayName(provider: string): string {
	return provider.length > 0
		? `${provider[0].toUpperCase()}${provider.slice(1)}`
		: "Provider";
}

function usageWindowDescription(windowLabel: string | undefined): string | undefined {
	if (!windowLabel) return undefined;
	const normalized = windowLabel.toLowerCase().replace(/\s+/g, "");
	if (normalized === "5h") return "5-hour window";
	if (normalized === "wk") return "weekly window";
	const match = normalized.match(/^(\d+)([hdw])$/);
	if (!match) return `${windowLabel} window`;
	const unit = match[2] === "h" ? "hour" : match[2] === "d" ? "day" : "week";
	return `${match[1]}-${unit} window`;
}

function getProviderStatuses(): ProviderStatus[] {
	if (!agent) return [];
	return [...agent.extensionStatuses.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, text]) => {
			const matches = [...text.matchAll(/(\d+(?:\.\d+)?)%\s*(5h|wk|(?:\d+\s*)?[hdw])?/gi)];
			const match = matches[0];
			const percent = match ? Math.max(0, Math.min(100, Number.parseFloat(match[1]))) : undefined;
			const provider = text.trim().split(/\s+/)[0] || key;
			const providerLabel = providerDisplayName(provider);
			const usageSummary = matches.map((usageMatch) => {
				const windowDescription = usageWindowDescription(usageMatch[2]);
				return `${usageMatch[1]}%${windowDescription ? ` in the ${windowDescription}` : ""}`;
			}).join("; ");
			return {
				key,
				text,
				providerLabel,
				percent: Number.isFinite(percent) ? percent : undefined,
				percentLabel: match ? `${match[1]}%` : undefined,
				windowLabel: match?.[2]?.replace(/\s+/g, ""),
				usageTooltip: usageSummary
					? `${providerLabel} quota used: ${usageSummary}.`
					: `${providerLabel} status: ${text}`,
			};
		});
}

function renderProviderQuota(
	status: ProviderStatus | undefined,
	statuses: ProviderStatus[],
	usage: TokenUsageSummary | undefined,
) {
	if (!status || status.percent == null || !status.percentLabel) return "";
	const title = `${status.usageTooltip} Click for session details.`;
	return renderStatusMetric("quota", title, html`
		<span class="status-quota">
			<span class="status-quota-track" aria-hidden="true">
				<span class="status-quota-fill" style=${`width: ${status.percent}%`}></span>
			</span>
			<span class="status-quota-percent">
				${status.percentLabel} used${status.windowLabel ? html` <span aria-hidden="true">/</span> ${status.windowLabel}` : ""}
			</span>
		</span>
	`, statuses, usage);
}

function renderContextUsage(
	usage: TokenUsageSummary | undefined,
	statuses: ProviderStatus[],
) {
	if (usage?.contextPercent === undefined || !usage.contextWindowLabel) return "";
	const isUnknown = usage.contextPercent === null;
	const percent = Math.max(0, usage.contextPercent ?? 0);
	const fillPercent = Math.min(100, percent);
	const tone = contextUsageTone(percent);
	const description = isUnknown
		? `Context window usage is unknown after compaction (${usage.contextWindowLabel} window)`
		: `Context window: ${percent}% used of ${usage.contextWindowLabel}`;
	return renderStatusMetric("context", `${description}. Click for session details.`, html`
		<span class="status-context is-${tone} ${isUnknown ? "is-unknown" : ""}">
			<span class="status-context-label">context</span>
			<span class="status-context-track" aria-hidden="true">
				<span class="status-context-fill" style=${`width: ${fillPercent}%`}></span>
			</span>
			<span class="status-context-percent">${isUnknown ? "?" : `${percent}%`}</span>
		</span>
	`, statuses, usage);
}

function renderStatusDetailsCard(statuses: ProviderStatus[], usage: TokenUsageSummary | undefined) {
	return html`
		<div class="status-details-popover">
			<div class="status-details-title">Session details</div>
			${statuses.map((status) => html`
				<div class="status-detail-row">
					<span>${status.providerLabel} quota (used)</span>
					<span class="extension-status-value" data-status-key=${status.key} title=${status.usageTooltip}>${status.text}</span>
				</div>
			`)}
			${usage ? html`
				<div class="status-detail-row"><span>Input tokens</span><span>${usage.input.toLocaleString()}</span></div>
				<div class="status-detail-row"><span>Output tokens</span><span>${usage.output.toLocaleString()}</span></div>
				${usage.contextPercent !== undefined && usage.contextWindowLabel
					? html`<div class="status-detail-row"><span>Context</span><span>${usage.contextPercent === null ? "?" : `${usage.contextPercent}%`} / ${usage.contextWindowLabel}</span></div>`
					: ""}
				<div class="status-detail-row"><span>Session cost</span><span>${usage.costLabel}</span></div>
			` : ""}
		</div>
	`;
}

function renderStatusMetric(
	kind: "quota" | "context" | "cost",
	title: string,
	content: ReturnType<typeof html>,
	statuses: ProviderStatus[],
	usage: TokenUsageSummary | undefined,
) {
	return html`
		<details class="status-metric-details is-${kind}" name="conversation-status-details">
			<summary title=${title} aria-label=${title}>${content}</summary>
			${renderStatusDetailsCard(statuses, usage)}
		</details>
	`;
}

function renderSessionCost(
	usage: TokenUsageSummary | undefined,
	statuses: ProviderStatus[],
) {
	if (!usage?.cost) return "";
	const title = `Session cost: ${usage.costLabel}. Click for session details.`;
	return renderStatusMetric("cost", title, html`
		<span class="status-cost">${usage.costLabel}</span>
	`, statuses, usage);
}

function renderToolbarExtras() {
	const statuses = getProviderStatuses();
	const usage = getTokenUsageSummary();
	return html`
		${renderThinkingButton()}
		${renderProviderQuota(statuses.find((status) => status.percent != null), statuses, usage)}
		<span class="status-toolbar-spacer" aria-hidden="true"></span>
		${renderContextUsage(usage, statuses)}
		${renderSessionCost(usage, statuses)}
	`;
}

async function openLocalSettingsModal(backendId?: string, routed = false) {
	if (localSettingsModalOpen) return;
	localSettingsModalOpen = true;
	const routeAbort = routed ? new AbortController() : undefined;
	if (routeAbort) routedSettingsAbort = routeAbort;
	try {
		if (backendId && backendId !== agent.activeBackendId) await agent.activateBackend?.(backendId);
		await openLocalSettingsDialog({
			api: agent,
			isJsonlVisible: isJsonlPanelVisible(),
			signal: routeAbort?.signal,
			onToggleJsonl: () => {
				if (isFilePreviewVisible()) closeFilePreview();
				toggleJsonlPanel();
				renderApp();
			},
			onSaved: async (settings) => {
				applyBackendSettings({ settings });
				await resyncAppearanceFromServer();
				loadAutoCollapseSettings(agent);
				renderApp();
				const picker = document.querySelector("session-picker") as any;
				picker?.refreshSessions?.();
			},
		});
	} catch (error) {
		agent.reportError(error, "Failed to open backend settings");
	} finally {
		localSettingsModalOpen = false;
		if (routeAbort) {
			if (routedSettingsAbort === routeAbort) routedSettingsAbort = undefined;
			if (routeAbort.signal.aborted) queueMicrotask(syncSettingsRoute);
			else leaveSettingsRoute();
		} else {
			syncSettingsRoute();
		}
	}
}

function openRoutedSettings(): void {
	enterSettingsRoute();
	void openLocalSettingsModal(undefined, true);
}

function syncSettingsRoute(): void {
	if (isSettingsPath(window.location.pathname)) {
		if (!localSettingsModalOpen) void openLocalSettingsModal(undefined, true);
		return;
	}
	routedSettingsAbort?.abort();
}

window.addEventListener("popstate", syncSettingsRoute);

async function openTurnRelaySettings(reconnectAfterSave = false): Promise<void> {
	if (turnRelaySettingsOpen) return;
	turnRelaySettingsOpen = true;
	try {
		await openTurnRelayDialog({
			saveLabel: reconnectAfterSave ? "Save and reconnect" : "Save",
			onSaved: () => {
				if (reconnectAfterSave) window.location.reload();
			},
		});
	} finally {
		turnRelaySettingsOpen = false;
	}
}

async function openConnectionDiagnosticsModal(backendId = agent.activeBackendId): Promise<void> {
	if (!backendId || connectionDiagnosticsOpen) return;
	connectionDiagnosticsOpen = true;
	try {
		await openConnectionDiagnosticsDialog({
			backendName: backendDisplayName(backendId),
			backendId,
			getDiagnostics: () => agent.getBackendConnectionDiagnostics?.(backendId)
				?? agent.getConnectionDiagnostics?.()
				?? Promise.resolve(undefined),
			onConfigureRelay: () => { void openTurnRelaySettings(false); },
		});
	} finally {
		connectionDiagnosticsOpen = false;
	}
}

function getTokenUsageSummary(): TokenUsageSummary | undefined {
	if (!agent) return undefined;
	const state = agent.state;
	return computeTokenUsageSummary(state.messages, state.model?.contextWindow);
}

function handleScroll(event: Event): void {
	const target = event.currentTarget;
	if (target instanceof HTMLElement) conversationScroll.handleScroll(target);
}

function handleConversationWheel(event: WheelEvent): void {
	if (event.deltaY < 0) conversationScroll.pauseForUser();
}

function handleConversationKeyDown(event: KeyboardEvent): void {
	if (event.defaultPrevented) return;
	const fromInteractiveControl = event.composedPath().some((element) =>
		element instanceof HTMLElement
		&& (element.isContentEditable || element.matches("input, textarea, select, button, [role='textbox']")),
	);
	if (fromInteractiveControl) return;

	const scrollsUp = event.key === "ArrowUp"
		|| event.key === "PageUp"
		|| event.key === "Home"
		|| (event.key === " " && event.shiftKey);
	if (scrollsUp) conversationScroll.pauseForUser();
}

function handleConversationTouchStart(event: TouchEvent): void {
	conversationTouchY = event.touches[0]?.clientY;
}

function handleConversationTouchMove(event: TouchEvent): void {
	const nextY = event.touches[0]?.clientY;
	if (nextY === undefined) return;
	if (conversationTouchY !== undefined && nextY > conversationTouchY) {
		conversationScroll.pauseForUser();
	}
	conversationTouchY = nextY;
}

function handleConversationTouchEnd(): void {
	conversationTouchY = undefined;
}

function handleConversationPointerDown(event: PointerEvent): void {
	const target = event.currentTarget;
	if (!(target instanceof HTMLElement) || event.button !== 0) return;
	const scrollbarWidth = target.offsetWidth - target.clientWidth;
	if (scrollbarWidth <= 0) return;
	const bounds = target.getBoundingClientRect();
	if (event.clientX >= bounds.right - scrollbarWidth) conversationScroll.pauseForUser();
}

function scrollToBottomIfNeeded(): void {
	conversationScroll.scrollToBottomIfNeeded(() => document.getElementById("chat-scroll-area"));
}

function scheduleUpdateSnoozeRefresh(): void {
	if (updateSnoozeRefreshTimer !== undefined) window.clearTimeout(updateSnoozeRefreshTimer);
	updateSnoozeRefreshTimer = undefined;
	let expiresAt: number | undefined;
	for (const [backendId, notices] of updateNoticesByBackend) {
		const candidate = updateNoticeSnoozes.nextExpiry(notices, backendId);
		if (candidate !== undefined && (expiresAt === undefined || candidate < expiresAt)) expiresAt = candidate;
	}
	if (expiresAt === undefined) return;

	const delay = Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647);
	updateSnoozeRefreshTimer = window.setTimeout(() => {
		updateSnoozeRefreshTimer = undefined;
		scheduleUpdateSnoozeRefresh();
		renderApp();
	}, delay);
}

function updateBackendIds(): string[] {
	if (!agent.workspaceBackends) return [LOCAL_BACKEND_UPDATE_KEY];
	return agent.workspaceBackends
		.filter((backend) => backend.connected)
		.map((backend) => backend.backendId);
}

async function getBackendUpdates(backendId: string) {
	if (backendId === LOCAL_BACKEND_UPDATE_KEY) return agent.getUpdates();
	if (agent.getBackendUpdates) return agent.getBackendUpdates(backendId);
	if (backendId === agent.activeBackendId) return agent.getUpdates();
	throw new Error("Backend updates are unavailable");
}

async function runBackendUpdate(backendId: string, target: UpdateTarget) {
	if (backendId === LOCAL_BACKEND_UPDATE_KEY) return agent.runUpdate(target);
	if (agent.runBackendUpdate) return agent.runBackendUpdate(backendId, target);
	if (backendId === agent.activeBackendId) return agent.runUpdate(target);
	throw new Error("Backend updates are unavailable");
}

async function refreshUpdateNotices(): Promise<void> {
	const backendIds = updateBackendIds();
	await Promise.all(backendIds.map(async (backendId) => {
		try {
			const snapshot = await getBackendUpdates(backendId);
			updateNoticesByBackend = new Map(updateNoticesByBackend).set(
				backendId,
				Array.isArray(snapshot.notices) ? snapshot.notices : [],
			);
		} catch {
			// Update checks are optional and must never interfere with the chat UI.
		}
	}));
	const currentIds = new Set(updateBackendIds());
	updateNoticesByBackend = new Map([...updateNoticesByBackend].filter(([backendId]) => currentIds.has(backendId)));
	scheduleUpdateSnoozeRefresh();
	renderApp();
}

function handleUpdateSnooze(backendId: string, notice: UpdateNotice): void {
	if ((updatingByBackend.get(backendId)?.size ?? 0) > 0) return;
	updateNoticeSnoozes.snooze(notice, backendId);
	scheduleUpdateSnoozeRefresh();
	renderApp();
}

async function handleUpdatesClick(backendId: string, notices: readonly UpdateNotice[]): Promise<void> {
	if (notices.length === 0 || (updatingByBackend.get(backendId)?.size ?? 0) > 0) return;
	const backendName = backendId === LOCAL_BACKEND_UPDATE_KEY ? "this backend" : backendDisplayName(backendId);
	const confirmation = notices.length === 1
		? updateConfirmationMessage(notices[0])
		: `Install these updates on ${backendName}?\n\n${notices.map((notice) => `• ${updateNoticeTitle(notice)}`).join("\n")}`;
	if (!window.confirm(confirmation)) return;

	updatingByBackend = new Map(updatingByBackend).set(backendId, new Set(notices.map((notice) => notice.target)));
	updateFeedbackByBackend = new Map(updateFeedbackByBackend);
	updateFeedbackByBackend.delete(backendId);
	renderApp();
	const completed: string[] = [];
	const errors: string[] = [];
	try {
		for (const notice of notices) {
			try {
				const payload = await runBackendUpdate(backendId, notice.target);
				updateNoticesByBackend = new Map(updateNoticesByBackend).set(backendId, payload.snapshot.notices);
				completed.push(payload.result.message);
			} catch (error) {
				errors.push(`${updateNoticeTitle(notice)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		updateFeedbackByBackend = new Map(updateFeedbackByBackend).set(backendId, errors.length > 0
			? { kind: "error", message: [completed.length > 0 ? `${completed.length} completed.` : "", ...errors].filter(Boolean).join(" ") }
			: { kind: "success", message: completed.join(" ") });
	} finally {
		updatingByBackend = new Map(updatingByBackend);
		updatingByBackend.delete(backendId);
		scheduleUpdateSnoozeRefresh();
		renderApp();
	}
}

function visibleUpdateNoticesByBackend(): ReadonlyMap<string, readonly UpdateNotice[]> {
	return new Map([...updateNoticesByBackend].map(([backendId, notices]) => [
		backendId,
		notices.filter((notice) => !updateNoticeSnoozes.isSnoozed(notice, backendId)),
	]));
}

function backendDisplayName(backendId: string): string {
	const descriptor = agent.workspaceBackends?.find((backend) => backend.backendId === backendId);
	return descriptor?.name || `${backendId.slice(0, 12)}…`;
}

async function openDeviceInviteModal(): Promise<void> {
	if (deviceInviteOpen) return;
	deviceInviteOpen = true;
	try {
		await openDeviceInviteDialog();
	} finally {
		deviceInviteOpen = false;
	}
}

async function removeBackend(backendId: string): Promise<void> {
	const name = backendDisplayName(backendId);
	if (!window.confirm(`Remove ${name} from this account? Active connections will close immediately.`)) return;
	try {
		await agent.removeBackend?.(backendId);
		if ((agent.workspaceBackends?.length ?? 0) === 0) window.location.reload();
		else renderApp();
	} catch (error) {
		agent.reportError(error, "Failed to remove backend");
	}
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
	const draftKey = currentConversationDraftKey();
	const draft = conversationDrafts.get(draftKey);

	const settingsMenuCallbacks = {
		onOpenSettings: (backendId?: string) => {
			if (backendId) void openLocalSettingsModal(backendId);
			else openRoutedSettings();
		},
		onOpenDiagnostics: (backendId: string) => { void openConnectionDiagnosticsModal(backendId); },
		onOpenRelaySettings: () => { void openTurnRelaySettings(false); },
		onRemoveBackend: (backendId: string) => { void removeBackend(backendId); },
		onInviteDevice: () => { void openDeviceInviteModal(); },
		onRunUpdates: (backendId: string, notices: readonly UpdateNotice[]) => { void handleUpdatesClick(backendId, notices); },
		onSnoozeUpdate: handleUpdateSnooze,
		onDismissUpdateFeedback: (backendId: string) => {
			updateFeedbackByBackend = new Map(updateFeedbackByBackend);
			updateFeedbackByBackend.delete(backendId);
			renderApp();
		},
		updatesByBackend: visibleUpdateNoticesByBackend(),
		updatingByBackend,
		updateFeedbackByBackend,
		isDevMode,
	};

	const appHtml = html`
		<div class="app-viewport-shell flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Main content: sidebar + chat -->
			<div class="flex flex-1 overflow-hidden">
				${!isMobile()
					? html`
						<div class="shrink-0 border-r border-border bg-background overflow-hidden" style="width: 280px;">
							<session-picker .agent=${agent} .prefetchedSessions=${prefetchedSessions} .settingsMenu=${settingsMenuCallbacks} .sessionsPerProject=${sessionsPerProject}></session-picker>
						</div>
					`
					: ""}
				<div class="flex-1 overflow-hidden flex flex-col">
					${isMobile()
						? html`
							<button
								type="button"
								class="mobile-sidebar-btn"
								@click=${openMobileSidebar}
								aria-label="Open sessions"
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
							<div
								id="chat-scroll-area"
								class="flex-1 overflow-y-auto"
								@scroll=${handleScroll}
								@wheel=${handleConversationWheel}
								@touchstart=${handleConversationTouchStart}
								@touchmove=${handleConversationTouchMove}
								@touchend=${handleConversationTouchEnd}
								@touchcancel=${handleConversationTouchEnd}
								@pointerdown=${handleConversationPointerDown}
							>
								<div class="max-w-3xl mx-auto p-4 pb-4 min-h-full flex flex-col justify-end">
									<pi-message-list
										.messages=${messages}
										.isStreaming=${isStreaming}
										.pendingToolCalls=${agent?.pendingToolCallIds ?? new Set()}
										.toolCallTimings=${agent?.toolCallTimings ?? {}}
										.sessionPath=${agent?.sessionFile ?? ""}
										.initialCount=${messagesInitialCount}
										.hideOlderThinking=${hideOlderThinking}
										.keepThinkingParts=${keepThinkingParts}
									></pi-message-list>
								</div>
							</div>
							<!-- Steering queue (between messages and input) -->
							${renderSteeringQueue()}
							<!-- Input area -->
							<div class="shrink-0 border-t border-border">
								<div class="max-w-3xl mx-auto px-2">
									<message-editor
										.value=${live(draft.value)}
										.attachments=${live(draft.attachments)}
										.isStreaming=${isStreaming}
										.allowSendDuringStreaming=${true}
										.currentModel=${state?.model}
										.thinkingLevel=${state?.thinkingLevel ?? "off"}
										.showAttachmentButton=${true}
										.showModelSelector=${true}
										.showThinkingSelector=${false}
										.slashCommands=${slashCommands}
										.onInput=${(value: string) => conversationDrafts.setValue(draftKey, value)}
										.onFilesChange=${(files: Attachment[]) => conversationDrafts.setAttachments(draftKey, files)}
										.onFileUpload=${uploadEditorAttachment}
										.onSend=${(input: string, attachments?: Attachment[]) => handleSend(input, attachments)}
										.onAbort=${handleStopClick}
										.onModelSelect=${handleModelSelect}
										.onKeyDown=${handleEditorKeyDown}
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
						${isFilePreviewVisible()
							? html`<div id="file-preview-container" class="file-preview-container border-l border-border"></div>`
							: ""}
					</div>
				</div>
			</div>
		</div>
	`;

	// Keep the root template stable while toggling the mobile overlay. Switching
	// between a bare app template and a wrapper recreated message-editor, whose
	// initial focus reopened the phone keyboard as the sidebar was opening.
	const mobileOverlay = mobileSidebarOpen && isMobile()
		? html`
			<div class="sidebar-mobile-overlay">
				<div class="sidebar-panel shrink-0 border-r border-border bg-background overflow-hidden">
					<session-picker .agent=${agent} .prefetchedSessions=${prefetchedSessions} .settingsMenu=${settingsMenuCallbacks} .sessionsPerProject=${sessionsPerProject}></session-picker>
				</div>
				<div class="sidebar-mobile-backdrop" @click=${() => { mobileSidebarOpen = false; renderApp(); }}></div>
			</div>
		`
		: "";
	render(html`${appHtml}${mobileOverlay}`, app);

	// Post-render setup
	requestAnimationFrame(() => {
		scrollToBottomIfNeeded();
		runAutoCollapse();
		const canvasEl = document.getElementById("canvas-container");
		if (canvasEl) initCanvas(canvasEl, renderApp);
		const jsonlEl = document.getElementById("jsonl-container");
		if (jsonlEl) initJsonlPanel(jsonlEl, renderApp, agent);
		const filePreviewEl = document.getElementById("file-preview-container");
		if (filePreviewEl) initFilePreview(filePreviewEl, renderApp);
	});
};

/** Fork the current session and prompt in the new fork. */
function handleForkAndPrompt(input: string, attachments?: Attachment[]): void {
	submitPrompt(input, attachments, "fork");
}

async function initApp() {
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

	// Connect the selected carrier before making backend requests.
	const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

	try {
		await agent.connect(wsUrl);
	} catch (err) {
		clearTimeout(connectingOverlayTimer);
		const backends = agent.workspaceBackends ?? [];
		const relayCandidate = backends.find((backend) => backend.connectionFailure?.turnRecommended
			|| backend.connectionFailure?.code === "relay_configuration");
		render(
			html`
				<div class="w-full h-screen flex items-center justify-center bg-background text-foreground p-6">
					<div class="max-w-lg rounded-lg border border-border p-6" data-testid="backend-unavailable-recovery">
						<h1 class="text-lg font-semibold mb-2">Backends unavailable</h1>
						<p class="text-destructive mb-4">${err instanceof Error ? err.message : "No authorized backend could be reached."}</p>
						${relayCandidate ? html`
							<div class="rounded border border-border bg-muted/30 p-4 mb-4">
								<h2 class="font-semibold mb-2">${relayCandidate.connectionFailure?.code === "relay_configuration" ? "TURN relay settings need attention" : "No direct network path was found"}</h2>
								<p class="text-sm text-muted-foreground mb-3">
									${relayCandidate.connectionFailure?.code === "relay_configuration"
										? "Pipane could not obtain valid temporary credentials from the configured relay. Check its API key, URLs, credentials, or usage quota."
										: "Pipane reached the rendezvous service and the backend, but WebRTC could not establish a direct route. A TURN relay can carry the encrypted connection through restrictive NATs and firewalls. The relay operator can observe IP addresses, timing, and traffic volume, but not the encrypted conversation."}
								</p>
								<div class="flex flex-wrap gap-2">
									<button class="rounded bg-primary text-primary-foreground px-3 py-2 text-sm" type="button" @click=${() => { void openTurnRelaySettings(true); }}>Set up a relay</button>
									<button class="rounded border border-border px-3 py-2 text-sm" type="button" @click=${() => window.location.reload()}>Try again</button>
									<button class="rounded border border-border px-3 py-2 text-sm" type="button" @click=${() => { void openConnectionDiagnosticsModal(relayCandidate.backendId); }}>Connection details</button>
								</div>
							</div>
						` : ""}
						${backends.length > 0 ? html`
							<div class="grid gap-2 mb-4">
								${backends.map((backend) => html`
									<div class="flex items-center gap-3 rounded border border-border px-3 py-2">
										<span class="flex-1">${backendDisplayName(backend.backendId)}</span>
										<span class="text-sm text-muted-foreground">${backend.error || (backend.online ? "Unavailable" : "Offline")}</span>
										<button class="text-red-600 text-sm" type="button" @click=${() => { void removeBackend(backend.backendId); }}>Remove</button>
									</div>
								`)}
							</div>
						` : ""}
						${!relayCandidate ? html`<p class="text-sm text-muted-foreground">Run <code>pipane pair</code> on an owned backend to add or recover access. TURN cannot help when a backend is offline or authorization fails.</p>` : ""}
					</div>
				</div>
			`,
			app,
		);
		return;
	}

	clearTimeout(connectingOverlayTimer);

	try {
		applyBackendSettings(await agent.getLocalSettings());
		await resyncAppearanceFromServer();
	} catch {
		// Backend settings are optional; cached UI defaults remain usable.
	}

	const sessionsPrefetch = agent.listSessions().catch((err) => {
		console.error("Failed to prefetch sessions:", err);
		return undefined;
	});

	installChatJsonlJumpListener();
	installFilePreviewLinkListener();

	// Re-fetch feature flags and appearance when local settings change
	agent.onSessionsChanged(async (file) => {
		if (file !== "__local_settings__") return;
		const requestedBackendId = agent.activeBackendId;
		try {
			const settings = await agent.getLocalSettings();
			if (requestedBackendId !== agent.activeBackendId) return;
			applyBackendSettings(settings);
		} catch { /* ignore */ }
		if (requestedBackendId !== agent.activeBackendId) return;
		await resyncAppearanceFromServer();
		if (requestedBackendId === agent.activeBackendId) renderApp();
	});

	// Session switch
	let observedBackendId = agent.activeBackendId;
	agent.onSessionChange(async () => {
		if (observedBackendId !== agent.activeBackendId) {
			observedBackendId = agent.activeBackendId;
		}
		clearPendingHardKillOffer();
		setFilePreviewSession(agent.sessionFile, currentSessionScopeKey());
		steeringQueue = agent.steeringQueue;
		resetAutoCollapse();
		if (canvasFeatureEnabled) restoreCanvasFromMessages(agent.state.messages, agent.sessionFile, currentCanvasTrackingScope());
		setJsonlSessionPath(agent.sessionFile, currentSessionScopeKey());
		conversationScroll.pinToBottom();
		// Auto-close sidebar overlay on mobile after session switch
		if (isMobile()) mobileSidebarOpen = false;
		renderApp();
		void refreshSlashCommands();
		requestAnimationFrame(() => {
			const editor = document.querySelector("message-editor") as any;
			const textarea = editor?.shadowRoot?.querySelector("textarea") ?? editor?.textareaRef?.value;
			textarea?.focus();
		});
	});

	// Content change — just re-render
	agent.onContentChange(() => {
		if (canvasFeatureEnabled) restoreCanvasFromMessages(agent.state.messages, agent.sessionFile, currentCanvasTrackingScope());
		refreshJsonlPanel();
		renderApp();
		scrollToBottomIfNeeded();
	});

	// Status change
	agent.onStatusChange(() => {
		if (!agent.sessionFile || agent.getSessionStatus(agent.sessionFile, agent.activeBackendId) !== "running") {
			clearPendingHardKillOffer();
		}
		renderApp();
	});

	agent.onExtensionStatusChange(() => {
		renderApp();
	});

	// Connection change — show/hide reconnection banner
	agent.onConnectionChange(() => {
		renderApp();
	});

	agent.onWorkspaceChange?.(() => {
		const connectedIds = updateBackendIds();
		if (connectedIds.length !== updateNoticesByBackend.size || connectedIds.some((backendId) => !updateNoticesByBackend.has(backendId))) {
			void refreshUpdateNotices();
		}
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
			const yes = window.confirm(`${info.message}\n\nInstall pi now? (npm install -g @earendil-works/pi-coding-agent)`);
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
			conversationDrafts.setValue(currentConversationDraftKey(), result.text);
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
	loadAutoCollapseSettings(agent);

	// Load the full model catalog before restoring a session. Persisted sessions
	// contain only provider/modelId refs, so restoration needs this metadata.
	try {
		await agent.fetchAvailableModels();
	} catch (err) {
		console.warn("Failed to preload available models; using compact session metadata", err);
	}
	await agent.loadDefaultModel();

	prefetchedSessions = (await sessionsPrefetch) ?? undefined;

	if (prefetchedSessions && prefetchedSessions.length > 0) {
		const mostRecent = prefetchedSessions.reduce((best, s) => {
			const bestTime = best.lastUserPromptTime ? new Date(best.lastUserPromptTime).getTime() : new Date(best.modified).getTime();
			const sTime = s.lastUserPromptTime ? new Date(s.lastUserPromptTime).getTime() : new Date(s.modified).getTime();
			return sTime > bestTime ? s : best;
		});
		await agent.switchSession(mostRecent.path, mostRecent.cwd, mostRecent.backendId);
	} else {
		await agent.newSession();
	}

	renderApp();
	void refreshUpdateNotices();
	syncSettingsRoute();

	prefetchedSessions = undefined;

}

initApp();

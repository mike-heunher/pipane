import { initThemes, getShowTokenUsage, resyncAppearanceFromServer } from "./theme-selector.js";
import { html, render } from "lit";
import { live } from "lit/directives/live.js";
import type { BackendClient, SessionInfoDTO } from "./backend-client.js";
import { ConversationScrollController } from "./conversation-scroll.js";
import { conversationDraftKey, ConversationDraftStore } from "./conversation-drafts.js";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { consumeAppRuntime } from "./app-runtime.js";
import { computeTokenUsageSummary, type TokenUsageSummary } from "./token-usage.js";
import "./session-picker.js";
import "./ui/index.js";
import type { MessageEditor } from "./ui/components/MessageEditor.js";
import type { Attachment } from "./ui/utils/attachment-utils.js";
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
} from "./file-preview-panel.js";
import { openModelPickerDialog } from "./model-picker-dialog.js";
import { openLocalSettingsDialog } from "./local-settings-modal.js";
import { loadAutoCollapseSettings, resetAutoCollapse, runAutoCollapse } from "./auto-collapse.js";
import { contextUsageTone, dismissStatusDetailsOnOutsideClick } from "./status-usage.js";
import type { UpdateNotice, UpdateTarget } from "../shared/updates.js";
import {
	updateConfirmationMessage,
	updateNoticeDetail,
	updateNoticeTitle,
} from "./update-notifications.js";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ThinkingLevelValue,
} from "../shared/thinking-levels.js";

const appRuntime = consumeAppRuntime(() => new WsAgentAdapter());
const agent: BackendClient = appRuntime.client;
const remoteRuntime = appRuntime.remote;
initThemes(agent);
document.addEventListener("click", dismissStatusDetailsOnOutsideClick);
document.addEventListener("keydown", handleConversationKeyDown);
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
let filePreviewLinkListenerInstalled = false;
let prefetchedSessions: SessionInfoDTO[] | undefined;
const conversationScroll = new ConversationScrollController();
let conversationTouchY: number | undefined;
let canvasFeatureEnabled = false;
let sessionsPerProject = 5;
let messagesInitialCount = 50;
let pendingHardKillOfferFor: string | null = null;
let updateNotices: UpdateNotice[] = [];
let updatingTarget: UpdateTarget | null = null;
let updateFeedback: { kind: "success" | "error"; message: string } | null = null;
let slashCommands: SlashCommandSuggestion[] = mergeSlashCommands([]);
let slashCommandRequest = 0;
const conversationDrafts = new ConversationDraftStore<Attachment>();

function applyBackendSettings(payload: { settings?: any }): void {
	canvasFeatureEnabled = payload.settings?.canvas?.enabled === true;
	if (typeof payload.settings?.sidebar?.sessionsPerProject === "number") {
		sessionsPerProject = payload.settings.sidebar.sessionsPerProject;
	}
	if (typeof payload.settings?.messages?.initialCount === "number") {
		messagesInitialCount = payload.settings.messages.initialCount;
	}
}

const isDevMode = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);


function getMessageEditor(): MessageEditor | null {
	return document.querySelector("message-editor") as MessageEditor | null;
}

function currentConversationDraftKey(): string {
	return conversationDraftKey(agent.sessionFile, agent.sessionId);
}

function clearCurrentConversationDraft(): void {
	conversationDrafts.clear(currentConversationDraftKey());
	const editor = getMessageEditor();
	if (!editor) return;
	editor.value = "";
	editor.attachments = [];
}

function slashCommandScope(): string {
	return agent.sessionFile ? `session:${agent.sessionFile}` : `cwd:${agent.cwd ?? ""}`;
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
	clearCurrentConversationDraft();
	void handleForkAndPrompt(value, attachments);
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
	const isStillRunning = agent.getSessionStatus(sessionPath) === "running";

	if (pendingHardKillOfferFor === sessionPath && isStillRunning) {
		const confirmed = window.confirm("The agent still appears to be running.\n\nHard kill the connected pi process? A new one will be spawned automatically for future prompts.");
		if (confirmed) agent.hardKill();
		clearPendingHardKillOffer();
		return;
	}

	pendingHardKillOfferFor = sessionPath;
	agent.abort();
}

function handleSend(input: string, attachments?: Attachment[]) {
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

	// Clear only this conversation's editor after capturing the input.
	clearCurrentConversationDraft();

	conversationScroll.pinToBottom();
	agent.prompt(fullInput, images.length > 0 ? images : undefined).catch((err: unknown) => {
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

function installFilePreviewLinkListener() {
	if (filePreviewLinkListenerInstalled) return;
	filePreviewLinkListenerInstalled = true;

	document.addEventListener("click", (event) => {
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
		if (!openFilePreviewLink(rawHref, cwd, sessionPath, previewPanel ? getFilePreviewPath() : undefined, agent)) return;

		event.preventDefault();
		if (isCanvasVisible()) closeCanvas();
		if (isJsonlPanelVisible()) toggleJsonlPanel();
		renderApp();
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
	const usage = getShowTokenUsage() ? getTokenUsageSummary() : undefined;
	return html`
		${renderThinkingButton()}
		${renderProviderQuota(statuses.find((status) => status.percent != null), statuses, usage)}
		<span class="status-toolbar-spacer" aria-hidden="true"></span>
		${renderContextUsage(usage, statuses)}
		${renderSessionCost(usage, statuses)}
	`;
}

async function openLocalSettingsModal() {
	if (localSettingsModalOpen) return;
	localSettingsModalOpen = true;
	try {
		await openLocalSettingsDialog({
			api: agent,
			isJsonlVisible: isJsonlPanelVisible(),
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
	} finally {
		localSettingsModalOpen = false;
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

async function refreshUpdateNotices(): Promise<void> {
	try {
		const snapshot = await agent.getUpdates();
		updateNotices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
		renderApp();
	} catch {
		// Update checks are optional and must never interfere with the chat UI.
	}
}

async function handleUpdateClick(notice: UpdateNotice): Promise<void> {
	if (updatingTarget) return;
	if (!window.confirm(updateConfirmationMessage(notice))) return;

	updatingTarget = notice.target;
	updateFeedback = null;
	renderApp();
	try {
		const payload = await agent.runUpdate(notice.target);
		updateNotices = payload.snapshot.notices;
		updateFeedback = { kind: "success", message: payload.result.message };
	} catch (error) {
		updateFeedback = {
			kind: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		updatingTarget = null;
		renderApp();
	}
}

function renderUpdateNotifications() {
	if (updateNotices.length === 0 && !updateFeedback) return "";
	return html`
		<div class="update-notifications" aria-live="polite">
			${updateNotices.map((notice) => html`
				<button
					type="button"
					class="update-notice"
					data-update-target=${notice.target}
					?disabled=${updatingTarget !== null}
					@click=${() => { void handleUpdateClick(notice); }}
				>
					<span class="update-notice-icon" aria-hidden="true">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 3v12"></path>
							<path d="m7 10 5 5 5-5"></path>
							<path d="M5 21h14"></path>
						</svg>
					</span>
					<span class="update-notice-copy">
						<strong>${updateNoticeTitle(notice)}</strong>
						<small title=${updateNoticeDetail(notice)}>${updateNoticeDetail(notice)}</small>
					</span>
					<span class="update-notice-action">
						${updatingTarget === notice.target ? "Updating…" : "Update"}
					</span>
				</button>
			`)}
			${updateFeedback ? html`
				<div class="update-feedback is-${updateFeedback.kind}" role=${updateFeedback.kind === "error" ? "alert" : "status"}>
					<span>${updateFeedback.message}</span>
					<button type="button" @click=${() => { updateFeedback = null; renderApp(); }} aria-label="Dismiss update message">×</button>
				</div>
			` : ""}
		</div>
	`;
}

function backendDisplayName(backendId: string): string {
	const descriptor = remoteRuntime?.backends.find((backend) => backend.backendId === backendId);
	return descriptor?.name || `${backendId.slice(0, 12)}…`;
}

function switchBackend(event: Event): void {
	const backendId = (event.currentTarget as HTMLSelectElement).value;
	if (backendId && backendId !== remoteRuntime?.backendId) {
		window.location.assign(`/backend/${encodeURIComponent(backendId)}`);
	}
}

async function removeCurrentBackend(): Promise<void> {
	if (!remoteRuntime) return;
	const name = backendDisplayName(remoteRuntime.backendId);
	if (!window.confirm(`Remove ${name} from this account? Active connections will close immediately.`)) return;
	try {
		await remoteRuntime.manager.revokeBackend(remoteRuntime.backendId);
		const next = remoteRuntime.backends.find((backend) => backend.backendId !== remoteRuntime.backendId && backend.online)
			?? remoteRuntime.backends.find((backend) => backend.backendId !== remoteRuntime.backendId);
		if (next) window.location.assign(`/backend/${encodeURIComponent(next.backendId)}`);
		else window.location.reload();
	} catch (error) {
		agent.reportError(error, "Failed to remove backend");
	}
}

function renderBackendBar() {
	if (!remoteRuntime) return "";
	const active = remoteRuntime.backends.find((backend) => backend.backendId === remoteRuntime.backendId);
	return html`
		<div class="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40 text-sm" data-testid="backend-switcher">
			<span class="text-muted-foreground shrink-0">Backend</span>
			<select
				class="min-w-0 max-w-64 rounded border border-border bg-background px-2 py-1 text-foreground"
				@change=${switchBackend}
				aria-label="Active backend"
			>
				${remoteRuntime.backends.map((backend) => html`
					<option
						value=${backend.backendId}
						?selected=${backend.backendId === remoteRuntime.backendId}
						?disabled=${!backend.online}
					>
						${backendDisplayName(backend.backendId)}${backend.online ? "" : " (offline)"}
					</option>
				`)}
			</select>
			<span class=${active?.online ? "text-green-600" : "text-amber-600"}>
				${active?.online ? "Online" : "Offline"}
			</span>
			<span class="flex-1"></span>
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground"
				title="Pair or recover another browser or backend"
				@click=${() => window.alert("Run `pipane pair` in an owned backend terminal, then scan its QR code. This also restores access after browser storage loss.")}
			>Pair / recover</button>
			<button
				type="button"
				class="text-red-600 hover:text-red-700"
				@click=${() => { void removeCurrentBackend(); }}
			>Remove</button>
		</div>
	`;
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
		onOpenSettings: () => { void openLocalSettingsModal(); },
		isDevMode,
	};

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			${renderBackendBar()}
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
					${renderUpdateNotifications()}
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
								<div class="max-w-3xl mx-auto p-4 pb-4">
									<pi-message-list
										.messages=${messages}
										.isStreaming=${isStreaming}
										.pendingToolCalls=${agent?.pendingToolCallIds ?? new Set()}
										.toolCallTimings=${agent?.toolCallTimings ?? {}}
										.sessionPath=${agent?.sessionFile ?? ""}
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

	// Mobile sidebar overlay
	if (mobileSidebarOpen && isMobile()) {
		const mobileOverlay = html`
			<div class="sidebar-mobile-overlay">
				<div class="sidebar-panel shrink-0 border-r border-border bg-background overflow-hidden">
					<session-picker .agent=${agent} .prefetchedSessions=${prefetchedSessions} .settingsMenu=${settingsMenuCallbacks} .sessionsPerProject=${sessionsPerProject}></session-picker>
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

/**
 * Fork the current session and prompt in the new fork.
 */
async function handleForkAndPrompt(input: string, attachments?: Attachment[]) {
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
		render(
			html`
				<div class="w-full h-screen flex items-center justify-center bg-background text-foreground p-6">
					<div class="max-w-lg rounded-lg border border-border p-6">
						<h1 class="text-lg font-semibold mb-2">Backend unavailable</h1>
						<p class="text-destructive mb-4">Failed to connect to the selected backend. It may be offline or unreachable.</p>
						${remoteRuntime ? html`
							<button class="text-red-600 underline mb-4" type="button" @click=${() => { void removeCurrentBackend(); }}>
								Remove this backend from the account
							</button>
						` : ""}
						${remoteRuntime?.backends.some((backend) => backend.backendId !== remoteRuntime.backendId && backend.online)
							? html`
								<p class="text-sm text-muted-foreground mb-2">Open another authorized backend:</p>
								<div class="flex flex-wrap gap-2">
									${remoteRuntime.backends.filter((backend) => backend.backendId !== remoteRuntime.backendId && backend.online).map((backend) => html`
										<a class="underline" href=${`/backend/${encodeURIComponent(backend.backendId)}`}>${backendDisplayName(backend.backendId)}</a>
									`)}
								</div>
							`
							: html`<p class="text-sm text-muted-foreground">Run <code>pipane pair</code> on an owned backend to restore access.</p>`}
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
		try {
			applyBackendSettings(await agent.getLocalSettings());
		} catch { /* ignore */ }
		await resyncAppearanceFromServer();
		renderApp();
	});

	// Session switch
	agent.onSessionChange(async () => {
		clearPendingHardKillOffer();
		closeFilePreview();
		steeringQueue = agent.steeringQueue;
		resetAutoCollapse();
		if (canvasFeatureEnabled) restoreCanvasFromMessages(agent.state.messages, agent.sessionFile);
		setJsonlSessionPath(agent.sessionFile);
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

	agent.onExtensionStatusChange(() => {
		renderApp();
	});

	// Connection change — show/hide reconnection banner
	agent.onConnectionChange(() => {
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
		await agent.switchSession(mostRecent.path, mostRecent.cwd);
	} else {
		await agent.newSession();
	}

	renderApp();
	void refreshUpdateNotices();

	prefetchedSessions = undefined;

}

initApp();

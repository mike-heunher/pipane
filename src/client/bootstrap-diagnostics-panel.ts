import type { BackendClient, WorkspaceBackendState } from "./backend-client.js";
import type { ConnectionDiagnostics } from "./frame-transport.js";

export interface BootstrapDiagnosticEntry {
	kind: "stage" | "event";
	label: string;
	detail?: string;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
}

export interface BootstrapDiagnosticReport {
	collectedAt: string;
	elapsedMs: number;
	stage?: string;
	failed: boolean;
	error?: { name: string; message: string };
	page: {
		origin: string;
		pathname: string;
		online: boolean;
		visibilityState: string;
		userAgent: string;
	};
	backends: Array<{
		backendId: string;
		name?: string;
		softwareVersion?: string;
		protocolVersions: number[];
		online: boolean;
		connected: boolean;
		reconnecting: boolean;
		error?: string;
		connectionFailure?: WorkspaceBackendState["connectionFailure"];
	}>;
	connection?: ConnectionDiagnostics;
	entries: BootstrapDiagnosticEntry[];
}

interface BootstrapDiagnosticsOptions {
	enabled: boolean;
	document?: Document;
	now?: () => number;
	clipboard?: Pick<Clipboard, "writeText">;
	refreshIntervalMs?: number;
}

/** Preview-only startup telemetry that stays browser-local until explicitly copied. */
export class BootstrapDiagnosticsController {
	private readonly document: Document | undefined;
	private readonly now: () => number;
	private readonly clipboard: Pick<Clipboard, "writeText"> | undefined;
	private readonly refreshIntervalMs: number;
	private readonly startedAt: number;
	private readonly entries: BootstrapDiagnosticEntry[] = [];
	private client: BackendClient | undefined;
	private currentStage: BootstrapDiagnosticEntry | undefined;
	private latestConnection: ConnectionDiagnostics | undefined;
	private error: Error | undefined;
	private panel: HTMLElement | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private refreshing = false;
	private unsubscribers: Array<() => void> = [];

	constructor(private readonly options: BootstrapDiagnosticsOptions) {
		this.document = options.document ?? globalThis.document;
		this.now = options.now ?? (() => Date.now());
		this.clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
		this.refreshIntervalMs = options.refreshIntervalMs ?? 1_000;
		this.startedAt = this.now();
	}

	get enabled(): boolean {
		return this.options.enabled;
	}

	mark(label: string, detail?: string): void {
		if (!this.enabled) return;
		this.finishCurrentStage();
		this.error = undefined;
		this.currentStage = {
			kind: "stage",
			label,
			...(detail ? { detail } : {}),
			startedAt: new Date(this.now()).toISOString(),
		};
		this.entries.push(this.currentStage);
		this.ensurePanel();
		this.render();
		void this.refreshConnection();
	}

	event(label: string, detail?: string): void {
		if (!this.enabled) return;
		this.entries.push({
			kind: "event",
			label,
			...(detail ? { detail } : {}),
			startedAt: new Date(this.now()).toISOString(),
		});
		this.render();
	}

	attachClient(client: BackendClient): void {
		if (!this.enabled || this.client === client) return;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		this.client = client;
		this.unsubscribers.push(client.onConnectionChange((connected) => {
			this.event(connected ? "Backend transport connected" : "Backend transport disconnected");
			void this.refreshConnection();
		}));
		if (client.onWorkspaceChange) {
			this.unsubscribers.push(client.onWorkspaceChange(() => {
				this.render();
				void this.refreshConnection();
			}));
		}
		void this.refreshConnection();
	}

	fail(error: unknown): void {
		if (!this.enabled) return;
		this.finishCurrentStage();
		this.error = error instanceof Error ? error : new Error(String(error));
		this.event("Startup failed", this.error.message);
		this.ensurePanel();
		this.render();
		void this.refreshConnection();
	}

	complete(): void {
		if (!this.enabled) return;
		this.finishCurrentStage();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		this.panel?.remove();
		this.panel = undefined;
	}

	collectReport(): BootstrapDiagnosticReport {
		const client = this.client;
		return {
			collectedAt: new Date(this.now()).toISOString(),
			elapsedMs: Math.max(0, this.now() - this.startedAt),
			...(this.currentStage ? { stage: this.currentStage.label } : {}),
			failed: Boolean(this.error),
			...(this.error ? { error: { name: this.error.name, message: this.error.message } } : {}),
			page: {
				origin: globalThis.location?.origin ?? "",
				pathname: globalThis.location?.pathname ?? "",
				online: globalThis.navigator?.onLine ?? true,
				visibilityState: this.document?.visibilityState ?? "unknown",
				userAgent: globalThis.navigator?.userAgent ?? "",
			},
			backends: (client?.workspaceBackends ?? []).map((backend) => ({
				backendId: backend.backendId,
				...(backend.name ? { name: backend.name } : {}),
				...(backend.softwareVersion ? { softwareVersion: backend.softwareVersion } : {}),
				protocolVersions: [...backend.protocolVersions],
				online: backend.online,
				connected: backend.connected,
				reconnecting: backend.reconnecting,
				...(backend.error ? { error: backend.error } : {}),
				...(backend.connectionFailure ? { connectionFailure: { ...backend.connectionFailure } } : {}),
			})),
			...(this.latestConnection ? { connection: structuredClone(this.latestConnection) } : {}),
			entries: this.entries.map((entry) => ({ ...entry })),
		};
	}

	private finishCurrentStage(): void {
		if (!this.currentStage || this.currentStage.finishedAt) return;
		const finishedAt = this.now();
		this.currentStage.finishedAt = new Date(finishedAt).toISOString();
		this.currentStage.durationMs = Math.max(0, finishedAt - Date.parse(this.currentStage.startedAt));
		this.currentStage = undefined;
	}

	private ensurePanel(): void {
		if (!this.enabled || !this.document || this.panel) return;
		this.panel = this.document.createElement("section");
		this.panel.dataset.testid = "bootstrap-diagnostics";
		this.panel.setAttribute("role", "status");
		this.panel.style.cssText = [
			"position:fixed", "left:12px", "right:12px", "bottom:12px", "z-index:10000",
			"max-width:620px", "margin:0 auto", "padding:14px", "border:1px solid var(--sk-border,#d1d5db)",
			"border-radius:10px", "background:var(--sk-background,#fff)", "color:var(--sk-muted-foreground,#374151)",
			"box-shadow:0 12px 32px rgba(0,0,0,.2)", "font:12px/1.4 ui-sans-serif,system-ui,sans-serif",
		].join(";");
		this.document.body.append(this.panel);
		this.timer = setInterval(() => {
			this.render();
			void this.refreshConnection();
		}, this.refreshIntervalMs);
	}

	private render(): void {
		if (!this.panel || !this.document) return;
		const header = this.document.createElement("div");
		header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:700;color:var(--foreground,#111827)";
		header.append(this.textElement("span", "Preview startup diagnostics"), this.badge("preview only"));

		const status = this.textElement("div", this.error
			? `Failed: ${this.error.message}`
			: `${this.currentStage?.label ?? "Starting"} · ${formatDuration(this.now() - this.startedAt)}`);
		status.style.cssText = `margin-top:8px;font-weight:600;${this.error ? "color:#dc2626" : "color:var(--foreground,#111827)"}`;

		const connection = this.textElement("div", this.connectionSummary());
		connection.style.cssText = "margin-top:4px";

		const timeline = this.document.createElement("ol");
		timeline.style.cssText = "margin:9px 0 0;padding-left:20px;max-height:112px;overflow:auto";
		for (const entry of this.entries.slice(-8)) {
			const duration = entry.durationMs === undefined ? "" : ` · ${formatDuration(entry.durationMs)}`;
			const item = this.textElement("li", `${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}${duration}`);
			timeline.append(item);
		}

		const actions = this.document.createElement("div");
		actions.style.cssText = "display:flex;flex-wrap:wrap;gap:7px;margin-top:10px";
		const copy = this.actionButton("Copy debug report", () => {
			const json = JSON.stringify(this.collectReport(), null, 2);
			void this.clipboard?.writeText(json).then(() => {
				copy.textContent = "Copied";
				setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy debug report"; }, 1_200);
			}).catch(() => { copy.textContent = "Copy failed"; });
		});
		const details = this.actionButton("Connection details", () => { void this.openConnectionDetails(); });
		details.disabled = !this.client;
		const relay = this.actionButton("Configure TURN", () => { void this.openTurnSettings(); });
		actions.append(copy, details, relay);

		const privacy = this.textElement("div", "Browser-local diagnostics; nothing is uploaded automatically. Copying may include browser-exposed ICE addresses.");
		privacy.style.cssText = "margin-top:8px;opacity:.75";
		this.panel.replaceChildren(header, status, connection, timeline, actions, privacy);
	}

	private connectionSummary(): string {
		const diagnostics = this.latestConnection;
		if (!diagnostics) return this.client ? "WebRTC statistics not available yet" : "Waiting for backend discovery";
		const turnConfigured = diagnostics.iceServerUrls.some((url) => /^turns?:/iu.test(url));
		return [
			`WebRTC ${diagnostics.connectionState ?? "unknown"}`,
			`ICE ${diagnostics.iceConnectionState ?? "unknown"}`,
			`DataChannel ${diagnostics.dataChannel.state ?? "unknown"}`,
			`path ${diagnostics.icePath}`,
			`TURN ${turnConfigured ? "configured" : "not configured"}`,
		].join(" · ");
	}

	private async refreshConnection(): Promise<void> {
		if (!this.enabled || !this.client || this.refreshing) return;
		this.refreshing = true;
		try {
			const backendId = this.client.activeBackendId ?? this.client.workspaceBackends?.[0]?.backendId;
			this.latestConnection = backendId && this.client.getBackendConnectionDiagnostics
				? await this.client.getBackendConnectionDiagnostics(backendId)
				: await this.client.getConnectionDiagnostics?.();
			this.render();
		} catch {
			// Startup diagnostics are best-effort and must not alter connection behavior.
		} finally {
			this.refreshing = false;
		}
	}

	private async openConnectionDetails(): Promise<void> {
		if (!this.client) return;
		const backendId = this.client.activeBackendId ?? this.client.workspaceBackends?.[0]?.backendId;
		if (!backendId) return;
		const backend = this.client.workspaceBackends?.find((candidate) => candidate.backendId === backendId);
		const { openConnectionDiagnosticsDialog } = await import("./connection-diagnostics-dialog.js");
		await openConnectionDiagnosticsDialog({
			backendName: backend?.name ?? backendId,
			backendId,
			getDiagnostics: () => this.client?.getBackendConnectionDiagnostics?.(backendId)
				?? this.client?.getConnectionDiagnostics?.()
				?? Promise.resolve(undefined),
			onConfigureRelay: () => { void this.openTurnSettings(); },
		});
	}

	private async openTurnSettings(): Promise<void> {
		const { openTurnRelayDialog } = await import("./turn-relay-dialog.js");
		await openTurnRelayDialog({
			saveLabel: "Save and reconnect",
			onSaved: () => globalThis.location?.reload(),
		});
	}

	private actionButton(label: string, onClick: () => void): HTMLButtonElement {
		const button = this.document!.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.style.cssText = "padding:6px 9px;border:1px solid var(--sk-border,#d1d5db);border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer";
		button.addEventListener("click", onClick);
		return button;
	}

	private badge(label: string): HTMLElement {
		const badge = this.textElement("span", label);
		badge.style.cssText = "padding:2px 6px;border:1px solid #f59e0b;border-radius:999px;color:#b45309;font-size:10px;text-transform:uppercase;letter-spacing:.05em";
		return badge;
	}

	private textElement<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text: string): HTMLElementTagNameMap[Tag] {
		const element = this.document!.createElement(tag);
		element.textContent = text;
		return element;
	}
}

function formatDuration(durationMs: number): string {
	return durationMs < 1_000 ? `${Math.max(0, Math.round(durationMs))} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}


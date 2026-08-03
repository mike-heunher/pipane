import type {
	ConnectionDiagnostics,
	IceCandidateDiagnostics,
	IceConnectionPath,
} from "./frame-transport.js";

export interface ConnectionDiagnosticsDialogOptions {
	backendName: string;
	backendId: string;
	getDiagnostics(): Promise<ConnectionDiagnostics | undefined>;
	onConfigureRelay?: () => void;
	clipboard?: Pick<Clipboard, "writeText">;
	refreshIntervalMs?: number;
}

export function openConnectionDiagnosticsDialog(options: ConnectionDiagnosticsDialogOptions): Promise<void> {
	return new Promise((resolve) => {
		const overlay = element("div", "connection-diagnostics-overlay");
		const panel = element("section", "connection-diagnostics-panel");
		panel.dataset.testid = "connection-diagnostics";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-modal", "true");
		panel.setAttribute("aria-labelledby", "connection-diagnostics-title");

		const header = element("header", "connection-diagnostics-header");
		const titleWrap = element("div", "connection-diagnostics-title-wrap");
		const title = element("h2", "connection-diagnostics-title", "Connection diagnostics");
		title.id = "connection-diagnostics-title";
		const subtitle = element("p", "connection-diagnostics-subtitle", `${options.backendName} · ${options.backendId}`);
		subtitle.title = options.backendId;
		titleWrap.append(title, subtitle);
		const actions = element("div", "connection-diagnostics-actions");
		const refreshButton = button("Refresh", "Refresh connection statistics");
		const copyButton = button("Copy", "Copy diagnostics as JSON");
		copyButton.disabled = true;
		const closeButton = button("×", "Close connection diagnostics");
		closeButton.classList.add("connection-diagnostics-close");
		actions.append(refreshButton, copyButton, closeButton);
		header.append(titleWrap, actions);

		const content = element("div", "connection-diagnostics-content");
		content.append(statusMessage("Collecting WebRTC statistics…"));
		const privacy = element(
			"p",
			"connection-diagnostics-privacy",
			"Candidate addresses are read from this browser's WebRTC statistics and are not sent anywhere unless you copy them.",
		);
		panel.append(header, content, privacy);
		overlay.append(panel);
		document.body.append(overlay);

		let closed = false;
		let latest: ConnectionDiagnostics | undefined;
		let refreshGeneration = 0;
		const refresh = async (): Promise<void> => {
			const generation = ++refreshGeneration;
			refreshButton.disabled = true;
			try {
				const diagnostics = await options.getDiagnostics();
				if (closed || generation !== refreshGeneration) return;
				latest = diagnostics;
				copyButton.disabled = !diagnostics;
				const scrollTop = content.scrollTop;
				const rawWasOpen = (content.querySelector(".connection-diagnostics-raw") as HTMLDetailsElement | null)?.open ?? false;
				content.replaceChildren(diagnostics
					? renderDiagnostics(diagnostics, options.onConfigureRelay)
					: statusMessage("Connection statistics are available only for an active remote WebRTC backend."));
				const nextRaw = content.querySelector(".connection-diagnostics-raw") as HTMLDetailsElement | null;
				if (nextRaw) nextRaw.open = rawWasOpen;
				content.scrollTop = scrollTop;
			} catch (error) {
				if (closed || generation !== refreshGeneration) return;
				latest = undefined;
				copyButton.disabled = true;
				content.replaceChildren(statusMessage(error instanceof Error ? error.message : "Unable to collect connection statistics.", true));
			} finally {
				if (!closed && generation === refreshGeneration) refreshButton.disabled = false;
			}
		};
		const close = (): void => {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			document.removeEventListener("keydown", onKeyDown);
			overlay.remove();
			resolve();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
		const timer = setInterval(() => { void refresh(); }, options.refreshIntervalMs ?? 1_000);

		refreshButton.addEventListener("click", () => { void refresh(); });
		copyButton.addEventListener("click", () => {
			if (!latest) return;
			const clipboard = options.clipboard ?? navigator.clipboard;
			void clipboard?.writeText(JSON.stringify(latest, null, 2)).then(() => {
				copyButton.textContent = "Copied";
				setTimeout(() => { if (!closed) copyButton.textContent = "Copy"; }, 1_200);
			}).catch(() => {
				copyButton.textContent = "Copy failed";
			});
		});
		closeButton.addEventListener("click", close);
		overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
		document.addEventListener("keydown", onKeyDown);
		void refresh();
	});
}

function renderDiagnostics(diagnostics: ConnectionDiagnostics, onConfigureRelay?: () => void): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const path = pathDescription(diagnostics.icePath);
	const overview = section("Overview");
	overview.append(factGrid([
		["Path", path.label, path.detail],
		["WebRTC", diagnostics.connectionState ?? "unknown"],
		["ICE", diagnostics.iceConnectionState ?? "unknown"],
		["Gathering", diagnostics.iceGatheringState ?? "unknown"],
		["DTLS", diagnostics.dtlsState ?? "unknown"],
		["Backend ID", diagnostics.backendId],
		["Rendezvous", diagnostics.rendezvousUrl],
		["Signaling", diagnostics.signalingUrl],
	]));
	fragment.append(overview);

	if (diagnostics.lastDisconnect) {
		const interruption = diagnostics.lastDisconnect;
		const previousPath = pathDescription(interruption.snapshot.icePath);
		const history = section("Last connection interruption");
		history.append(
			statusMessage(interruption.failure.message, true),
			factGrid([
				["Time", interruption.occurredAt],
				["Cause", interruption.failure.code],
				["Previous path", previousPath.label, previousPath.detail],
				["WebRTC", interruption.snapshot.connectionState ?? "unknown"],
				["ICE", interruption.snapshot.iceConnectionState ?? "unknown"],
				["DataChannel", interruption.snapshot.dataChannel.state ?? "unknown"],
			]),
		);
		fragment.append(history);
	}

	if (diagnostics.failure) {
		const recovery = section("Connection recovery");
		recovery.append(statusMessage(diagnostics.failure.message, true));
		if (diagnostics.failure.turnRecommended) {
			recovery.append(statusMessage(
				"Signaling reached the backend, but ICE could not establish a direct route. A TURN relay may carry the encrypted connection through this network.",
			));
		}
		if (onConfigureRelay && (diagnostics.failure.turnRecommended || diagnostics.failure.code === "relay_configuration")) {
			const configure = button(
				diagnostics.failure.code === "relay_configuration" ? "Edit TURN relay" : "Set up a TURN relay",
				"Configure TURN relay",
			);
			configure.addEventListener("click", onConfigureRelay);
			recovery.append(configure);
		}
		fragment.append(recovery);
	}

	const pairSection = section("Selected ICE path");
	if (diagnostics.selectedPair) {
		const pair = diagnostics.selectedPair;
		pairSection.append(factGrid([
			["Local candidate", formatCandidate(pair.local)],
			["Remote candidate", formatCandidate(pair.remote)],
			["Pair state", pair.state ?? "unknown"],
			["Nominated", pair.nominated === undefined ? "unknown" : pair.nominated ? "yes" : "no"],
			["Round-trip time", formatDuration(pair.currentRoundTripTimeMs)],
			["Outgoing bitrate", formatBitrate(pair.availableOutgoingBitrate)],
			["Transferred", `${formatBytes(pair.bytesSent)} sent · ${formatBytes(pair.bytesReceived)} received`],
		]));
	} else {
		pairSection.append(statusMessage("The browser has not exposed a selected ICE candidate pair yet."));
	}
	fragment.append(pairSection);

	const servers = section("Configured ICE servers");
	if (diagnostics.iceServerUrls.length > 0) {
		const list = element("ul", "connection-diagnostics-server-list");
		for (const url of diagnostics.iceServerUrls) list.append(element("li", "", url));
		servers.append(list);
	} else {
		servers.append(statusMessage("No STUN or TURN server was configured for this connection."));
	}
	if (onConfigureRelay && !diagnostics.failure?.turnRecommended && diagnostics.failure?.code !== "relay_configuration") {
		const configure = button("Configure TURN relay", "Configure TURN relay");
		configure.addEventListener("click", onConfigureRelay);
		servers.append(configure);
	}
	fragment.append(servers);

	const channel = section("DataChannel");
	channel.append(factGrid([
		["State", diagnostics.dataChannel.state ?? "unknown"],
		["Label / protocol", `${diagnostics.dataChannel.label ?? "unknown"} / ${diagnostics.dataChannel.protocol || "none"}`],
		["Ordered", diagnostics.dataChannel.ordered === undefined ? "unknown" : diagnostics.dataChannel.ordered ? "yes" : "no"],
		["SCTP max message", formatBytes(diagnostics.dataChannel.maxMessageSize)],
		["Currently buffered", formatBytes(diagnostics.dataChannel.bufferedAmount)],
		["Messages", `${formatNumber(diagnostics.dataChannel.messagesSent)} sent · ${formatNumber(diagnostics.dataChannel.messagesReceived)} received`],
		["Payload bytes", `${formatBytes(diagnostics.dataChannel.bytesSent)} sent · ${formatBytes(diagnostics.dataChannel.bytesReceived)} received`],
	]));
	fragment.append(channel);

	const candidates = section(`ICE candidates (${diagnostics.candidates.length})`);
	if (diagnostics.candidates.length > 0) {
		const list = element("div", "connection-diagnostics-candidates");
		for (const candidate of diagnostics.candidates) list.append(candidateCard(candidate, diagnostics));
		candidates.append(list);
	} else {
		candidates.append(statusMessage("No ICE candidate statistics are currently available."));
	}
	fragment.append(candidates);

	const raw = document.createElement("details");
	raw.className = "connection-diagnostics-raw";
	raw.append(element("summary", "", "Raw browser statistics snapshot"));
	raw.append(element("pre", "", JSON.stringify(diagnostics, null, 2)));
	fragment.append(raw);
	return fragment;
}

function candidateCard(candidate: IceCandidateDiagnostics, diagnostics: ConnectionDiagnostics): HTMLElement {
	const selected = diagnostics.selectedPair?.local?.id === candidate.id || diagnostics.selectedPair?.remote?.id === candidate.id;
	const card = element("article", `connection-diagnostics-candidate${selected ? " is-selected" : ""}`);
	const heading = element("div", "connection-diagnostics-candidate-heading");
	heading.append(
		element("strong", "", `${candidate.scope} · ${candidate.candidateType ?? "unknown"}`),
		element("span", "", selected ? "selected" : "discovered"),
	);
	card.append(heading, factGrid([
		["Address", formatAddress(candidate)],
		["Transport", [candidate.protocol, candidate.tcpType, candidate.relayProtocol].filter(Boolean).join(" / ") || "unknown"],
		["Network", candidate.networkType ?? "unknown"],
		["Related address", candidate.relatedAddress ? joinAddress(candidate.relatedAddress, candidate.relatedPort) : "not exposed"],
		["ICE server", candidate.url ?? "not exposed"],
		["Priority", formatNumber(candidate.priority)],
	]));
	return card;
}

function factGrid(rows: Array<[string, string, string?]>): HTMLElement {
	const grid = element("dl", "connection-diagnostics-grid");
	for (const [label, value, detail] of rows) {
		const item = element("div", "connection-diagnostics-fact");
		item.append(element("dt", "", label));
		const description = element("dd", "", value);
		description.title = value;
		item.append(description);
		if (detail) item.append(element("small", "", detail));
		grid.append(item);
	}
	return grid;
}

function section(title: string): HTMLElement {
	const value = element("section", "connection-diagnostics-section");
	value.append(element("h3", "", title));
	return value;
}

function statusMessage(message: string, error = false): HTMLElement {
	return element("p", `connection-diagnostics-message${error ? " is-error" : ""}`, message);
}

function button(text: string, label: string): HTMLButtonElement {
	const value = element("button", "connection-diagnostics-button", text);
	value.type = "button";
	value.setAttribute("aria-label", label);
	return value;
}

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	text?: string,
): HTMLElementTagNameMap[K] {
	const value = document.createElement(tag);
	if (className) value.className = className;
	if (text !== undefined) value.textContent = text;
	return value;
}

function pathDescription(path: IceConnectionPath): { label: string; detail: string } {
	switch (path) {
		case "direct-host": return { label: "Direct host", detail: "A host candidate was selected; STUN was not needed for the chosen route." };
		case "direct-stun": return { label: "Direct via STUN", detail: "The browser selected a server- or peer-reflexive candidate. This usually indicates direct NAT traversal, although browser-only statistics may not reveal a relay selected by the remote peer." };
		case "turn-relay": return { label: "TURN relay", detail: "At least one selected candidate is relayed through TURN." };
		case "unknown": return { label: "Unknown", detail: "The selected candidate pair is not available yet." };
	}
}

function formatCandidate(candidate: IceCandidateDiagnostics | undefined): string {
	if (!candidate) return "not exposed";
	return `${candidate.candidateType ?? "unknown"} · ${formatAddress(candidate)} · ${candidate.protocol ?? "unknown"}`;
}

function formatAddress(candidate: IceCandidateDiagnostics): string {
	return candidate.address ? joinAddress(candidate.address, candidate.port) : "not exposed";
}

function joinAddress(address: string, port?: number): string {
	const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
	return port === undefined ? host : `${host}:${port}`;
}

function formatDuration(value: number | undefined): string {
	return value === undefined ? "not exposed" : `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

function formatBitrate(value: number | undefined): string {
	if (value === undefined) return "not exposed";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(0)} Kbps`;
	return `${value.toFixed(0)} bps`;
}

function formatBytes(value: number | undefined): string {
	if (value === undefined) return "not exposed";
	if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
	return `${value.toFixed(0)} B`;
}

function formatNumber(value: number | undefined): string {
	return value === undefined ? "not exposed" : new Intl.NumberFormat().format(value);
}

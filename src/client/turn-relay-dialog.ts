import {
	defaultTurnRelayStore,
	parseStaticIceServers,
	parseTurnUrls,
	testTurnRelayProfile,
	validateTurnRelayProfile,
	type TurnRelayProfile,
	type TurnRelayStore,
	type TurnRelayTestResult,
} from "./turn-relay.js";

export interface TurnRelayDialogOptions {
	store?: Pick<TurnRelayStore, "load" | "save" | "clear">;
	subject?: string;
	testProfile?: (profile: TurnRelayProfile, subject: string) => Promise<TurnRelayTestResult>;
	onSaved?: (profile: TurnRelayProfile | undefined) => void | Promise<void>;
	saveLabel?: string;
}

type ProviderKind = TurnRelayProfile["kind"];

interface FormState {
	kind: ProviderKind;
	meteredApplication: string;
	meteredApiKey: string;
	coturnUrls: string;
	coturnSecret: string;
	coturnTtl: string;
	staticJson: string;
}

const EMPTY_STATIC_JSON = `{
  "iceServers": [
    {
      "urls": [
        "turn:turn.example.com:3478?transport=udp",
        "turns:turn.example.com:443?transport=tcp"
      ],
      "username": "your-username",
      "credential": "your-credential"
    }
  ]
}`;

export function openTurnRelayDialog(options: TurnRelayDialogOptions = {}): Promise<void> {
	return new Promise((resolve) => {
		const store = options.store ?? defaultTurnRelayStore;
		const testProfile = options.testProfile ?? testTurnRelayProfile;
		const overlay = element("div", "turn-relay-overlay");
		const panel = element("section", "turn-relay-panel");
		panel.dataset.testid = "turn-relay-dialog";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-modal", "true");
		panel.setAttribute("aria-labelledby", "turn-relay-title");
		const header = element("header", "turn-relay-header");
		const heading = element("div");
		const title = element("h2", "turn-relay-title", "TURN relay settings");
		title.id = "turn-relay-title";
		heading.append(title, element("p", "turn-relay-subtitle", "Connect through restrictive NATs and firewalls"));
		const closeButton = button("×", "turn-relay-close");
		closeButton.setAttribute("aria-label", "Close TURN relay settings");
		header.append(heading, closeButton);
		const providerNavigation = element("div", "turn-relay-providers");
		const content = element("div", "turn-relay-content");
		const status = element("p", "turn-relay-status");
		status.setAttribute("role", "status");
		const footer = element("footer", "turn-relay-footer");
		panel.append(header, providerNavigation, content, status, footer);
		overlay.append(panel);
		document.body.append(overlay);

		let closed = false;
		let busy = true;
		let storedProfile: TurnRelayProfile | undefined;
		const state: FormState = {
			kind: "metered",
			meteredApplication: "",
			meteredApiKey: "",
			coturnUrls: "turn:turn.example.com:3478?transport=udp\nturns:turn.example.com:443?transport=tcp",
			coturnSecret: "",
			coturnTtl: "3600",
			staticJson: EMPTY_STATIC_JSON,
		};

		const setStatus = (message: string, kind: "neutral" | "success" | "error" = "neutral"): void => {
			status.textContent = message;
			status.className = `turn-relay-status${kind === "neutral" ? "" : ` is-${kind}`}`;
		};
		const close = (): void => {
			if (closed) return;
			closed = true;
			document.removeEventListener("keydown", onKeyDown);
			overlay.remove();
			resolve();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && !busy) close();
		};

		const profileFromForm = (): TurnRelayProfile => {
			if (state.kind === "metered") {
				return validateTurnRelayProfile({
					version: 1,
					kind: "metered",
					application: state.meteredApplication,
					apiKey: state.meteredApiKey,
				});
			}
			if (state.kind === "coturn-rest") {
				return validateTurnRelayProfile({
					version: 1,
					kind: "coturn-rest",
					urls: parseTurnUrls(state.coturnUrls),
					sharedSecret: state.coturnSecret,
					ttlSeconds: Number.parseInt(state.coturnTtl, 10),
				});
			}
			return validateTurnRelayProfile({
				version: 1,
				kind: "static",
				iceServers: parseStaticIceServers(state.staticJson),
			});
		};

		const setBusy = (value: boolean): void => {
			busy = value;
			for (const control of panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button,input,textarea")) {
				control.disabled = value;
			}
			closeButton.disabled = false;
		};

		const render = (): void => {
			providerNavigation.replaceChildren();
			for (const provider of [
				{ kind: "metered" as const, label: "Metered", detail: "Recommended" },
				{ kind: "coturn-rest" as const, label: "Self-hosted coturn", detail: "REST secret" },
				{ kind: "static" as const, label: "Other provider", detail: "ICE credentials" },
			]) {
				const providerButton = button(provider.label, `turn-relay-provider${state.kind === provider.kind ? " is-active" : ""}`);
				providerButton.dataset.provider = provider.kind;
				providerButton.append(element("small", "", provider.detail));
				providerButton.addEventListener("click", () => {
					if (busy) return;
					state.kind = provider.kind;
					setStatus(privacyMessage());
					render();
				});
				providerNavigation.append(providerButton);
			}

			content.replaceChildren();
			if (state.kind === "metered") renderMetered(content, state);
			else if (state.kind === "coturn-rest") renderCoturn(content, state);
			else renderStatic(content, state);

			footer.replaceChildren();
			if (storedProfile) {
				const removeButton = button("Remove relay", "turn-relay-button is-danger");
				removeButton.addEventListener("click", () => {
					if (busy) return;
					setBusy(true);
					setStatus("Removing TURN relay settings…");
					void store.clear().then(async () => {
						storedProfile = undefined;
						await options.onSaved?.(undefined);
						close();
					}).catch((error) => {
						setStatus(errorMessage(error), "error");
						setBusy(false);
					});
				});
				footer.append(removeButton);
			}
			const spacer = element("span", "turn-relay-footer-spacer");
			const testButton = button("Test relay", "turn-relay-button");
			testButton.dataset.testid = "turn-relay-test";
			testButton.addEventListener("click", () => {
				if (busy) return;
				let profile: TurnRelayProfile;
				try {
					profile = profileFromForm();
				} catch (error) {
					setStatus(errorMessage(error), "error");
					return;
				}
				setBusy(true);
				setStatus("Requesting credentials and gathering a relay-only ICE candidate…");
				void testProfile(profile, options.subject ?? "d_turn_test").then((result) => {
					const route = [result.url, result.protocol, result.relayProtocol].filter(Boolean).join(" · ");
					setStatus(`Relay test passed${route ? ` · ${route}` : ""}. The backend will be tested when Pipane reconnects.`, "success");
				}).catch((error) => setStatus(errorMessage(error), "error")).finally(() => setBusy(false));
			});
			const saveButton = button(options.saveLabel ?? "Save", "turn-relay-button is-primary");
			saveButton.dataset.testid = "turn-relay-save";
			saveButton.addEventListener("click", () => {
				if (busy) return;
				let profile: TurnRelayProfile;
				try {
					profile = profileFromForm();
				} catch (error) {
					setStatus(errorMessage(error), "error");
					return;
				}
				setBusy(true);
				setStatus("Saving TURN relay settings in this browser…");
				void store.save(profile).then(async () => {
					storedProfile = profile;
					await options.onSaved?.(profile);
					close();
				}).catch((error) => {
					setStatus(errorMessage(error), "error");
					setBusy(false);
				});
			});
			footer.append(spacer, testButton, saveButton);
			setBusy(busy);
		};

		closeButton.addEventListener("click", close);
		overlay.addEventListener("click", (event) => { if (event.target === overlay && !busy) close(); });
		document.addEventListener("keydown", onKeyDown);
		setStatus("Loading browser-local relay settings…");
		void store.load().then((profile) => {
			storedProfile = profile;
			if (profile) applyProfile(state, profile);
			busy = false;
			setStatus(privacyMessage());
			render();
		}).catch((error) => {
			busy = false;
			setStatus(errorMessage(error), "error");
			render();
		});
	});
}

function renderMetered(content: HTMLElement, state: FormState): void {
	const heading = sectionHeading("Metered Open Relay", "Recommended for the simplest setup. Metered currently advertises 20 GB of free relay usage each month.");
	const link = document.createElement("a");
	link.href = "https://www.metered.ca/tools/openrelay/";
	link.target = "_blank";
	link.rel = "noreferrer noopener";
	link.className = "turn-relay-external-link";
	link.textContent = "1. Create a Metered account and TURN application ↗";
	const application = inputRow("2. Application name", "For example “my-pipane”; do not include .metered.live.", "text", state.meteredApplication, (value) => { state.meteredApplication = value; });
	application.input.autocomplete = "off";
	const apiKey = inputRow("3. TURN API key", "Use a dedicated application key. It stays in this browser.", "password", state.meteredApiKey, (value) => { state.meteredApiKey = value; });
	apiKey.input.autocomplete = "off";
	content.append(heading, link, application.row, apiKey.row, callout(
		"Pipane asks Metered for temporary credentials on every connection. The long-term API key is not sent to Pipane rendezvous or your backend.",
	));
}

function renderCoturn(content: HTMLElement, state: FormState): void {
	const urls = textareaRow("TURN URLs", "One URL per line. Include UDP and turns: over TCP/443 when available.", state.coturnUrls, (value) => { state.coturnUrls = value; });
	const secret = inputRow("REST shared secret", "The static-auth-secret configured on your coturn server.", "password", state.coturnSecret, (value) => { state.coturnSecret = value; });
	secret.input.autocomplete = "off";
	const ttl = inputRow("Credential lifetime (seconds)", "Between 60 and 86400; 3600 is recommended.", "number", state.coturnTtl, (value) => { state.coturnTtl = value; });
	ttl.input.min = "60";
	ttl.input.max = "86400";
	content.append(
		sectionHeading("Self-hosted coturn", "The server must be publicly reachable; a TURN server behind the same private NAT usually cannot help."),
		urls.row,
		secret.row,
		ttl.row,
		callout("Pipane generates standard expiring coturn REST credentials locally. Only the temporary username and HMAC credential are sent through rendezvous."),
	);
}

function renderStatic(content: HTMLElement, state: FormState): void {
	const json = textareaRow("ICE servers JSON", "Paste an iceServers array or an object containing iceServers. JavaScript snippets are not executed.", state.staticJson, (value) => { state.staticJson = value; });
	json.textarea.classList.add("turn-relay-json");
	content.append(
		sectionHeading("Another TURN provider", "Use standard TURN URLs, username, and credential from Xirsys, Twilio, or another compatible provider."),
		json.row,
		callout("Static credentials are stored in this browser and sent transiently through Pipane rendezvous for each backend connection. Revoke them at the provider if this browser is lost."),
	);
}

function applyProfile(state: FormState, profile: TurnRelayProfile): void {
	state.kind = profile.kind;
	if (profile.kind === "metered") {
		state.meteredApplication = profile.application;
		state.meteredApiKey = profile.apiKey;
	} else if (profile.kind === "coturn-rest") {
		state.coturnUrls = profile.urls.join("\n");
		state.coturnSecret = profile.sharedSecret;
		state.coturnTtl = String(profile.ttlSeconds);
	} else {
		state.staticJson = JSON.stringify({ iceServers: profile.iceServers }, null, 2);
	}
}

function privacyMessage(): string {
	return "Saved only in this browser. TURN relays encrypted WebRTC packets; the relay operator can still observe endpoint IPs, timing, and traffic volume.";
}

function sectionHeading(title: string, description: string): HTMLElement {
	const value = element("div", "turn-relay-section-heading");
	value.append(element("h3", "", title), element("p", "", description));
	return value;
}

function inputRow(
	label: string,
	description: string,
	type: string,
	value: string,
	onInput: (value: string) => void,
): { row: HTMLElement; input: HTMLInputElement } {
	const row = element("label", "turn-relay-field");
	row.append(element("span", "turn-relay-label", label), element("small", "", description));
	const input = document.createElement("input");
	input.type = type;
	input.value = value;
	input.addEventListener("input", () => onInput(input.value));
	row.append(input);
	return { row, input };
}

function textareaRow(
	label: string,
	description: string,
	value: string,
	onInput: (value: string) => void,
): { row: HTMLElement; textarea: HTMLTextAreaElement } {
	const row = element("label", "turn-relay-field");
	row.append(element("span", "turn-relay-label", label), element("small", "", description));
	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.rows = 5;
	textarea.addEventListener("input", () => onInput(textarea.value));
	row.append(textarea);
	return { row, textarea };
}

function callout(text: string): HTMLElement {
	return element("p", "turn-relay-callout", text);
}

function button(text: string, className: string): HTMLButtonElement {
	const value = element("button", className, text);
	value.type = "button";
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

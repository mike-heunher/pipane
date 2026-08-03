import { html, type TemplateResult } from "lit";
import type { WorkspaceBackendState } from "./backend-client.js";

export interface BackendUnavailableRecoveryOptions {
	errorMessage: string;
	backends: readonly WorkspaceBackendState[];
	backendDisplayName(backendId: string): string;
	onConfigureRelay(): void;
	onRetry(): void;
	onConnectionDetails(backendId: string): void;
	onRemoveBackend(backendId: string): void;
}

export function renderBackendUnavailableRecovery(options: BackendUnavailableRecoveryOptions): TemplateResult {
	const relayCandidate = options.backends.find((backend) => backend.connectionFailure?.turnRecommended
		|| backend.connectionFailure?.code === "relay_configuration");

	return html`
		<div class="w-full h-screen flex items-center justify-center bg-background text-foreground p-6">
			<div class="max-w-lg rounded-lg border border-border p-6" data-testid="backend-unavailable-recovery">
				<h1 class="text-lg font-semibold mb-2">Backends unavailable</h1>
				<p class="text-destructive mb-4">${options.errorMessage}</p>
				${relayCandidate ? html`
					<div class="rounded border border-border bg-muted/30 p-4 mb-4">
						<h2 class="font-semibold mb-2">${relayCandidate.connectionFailure?.code === "relay_configuration" ? "TURN relay settings need attention" : "No direct network path was found"}</h2>
						<p class="text-sm text-muted-foreground mb-3">
							${relayCandidate.connectionFailure?.code === "relay_configuration"
								? "Pipane could not obtain valid temporary credentials from the configured relay. Check its API key, URLs, credentials, or usage quota."
								: "Pipane reached the rendezvous service and the backend, but WebRTC could not establish a direct route. A TURN relay can carry the encrypted connection through restrictive NATs and firewalls. The relay operator can observe IP addresses, timing, and traffic volume, but not the encrypted conversation."}
						</p>
						<div class="flex flex-wrap gap-2">
							<button class="rounded bg-primary text-primary-foreground px-3 py-2 text-sm" data-testid="turn-relay-settings" type="button" @click=${options.onConfigureRelay}>Set up a relay</button>
							<button class="rounded border border-border px-3 py-2 text-sm" type="button" @click=${options.onRetry}>Try again</button>
							<button class="rounded border border-border px-3 py-2 text-sm" type="button" @click=${() => options.onConnectionDetails(relayCandidate.backendId)}>Connection details</button>
						</div>
					</div>
				` : ""}
				${options.backends.length > 0 ? html`
					<div class="grid gap-2 mb-4">
						${options.backends.map((backend) => html`
							<div class="flex items-center gap-3 rounded border border-border px-3 py-2">
								<span class="flex-1">${options.backendDisplayName(backend.backendId)}</span>
								<span class="text-sm text-muted-foreground">${backend.error || (backend.online ? "Unavailable" : "Offline")}</span>
								<button class="text-red-600 text-sm" type="button" @click=${() => options.onRemoveBackend(backend.backendId)}>Remove</button>
							</div>
						`)}
					</div>
				` : ""}
				${!relayCandidate ? html`
					<p class="text-sm text-muted-foreground mb-4">Run <code>pipane pair</code> on an owned backend to add or recover access. TURN helps only when an online backend cannot establish a direct network path; it cannot recover an offline backend or an authorization failure.</p>
					<div class="flex flex-wrap gap-2">
						<button class="rounded border border-border px-3 py-2 text-sm" data-testid="turn-relay-settings" type="button" @click=${options.onConfigureRelay}>TURN settings</button>
						<button class="rounded border border-border px-3 py-2 text-sm" type="button" @click=${options.onRetry}>Try again</button>
					</div>
				` : ""}
			</div>
		</div>
	`;
}

import type { BackendClient } from "./backend-client.js";
import type { BootstrapDiagnosticsController } from "./bootstrap-diagnostics-panel.js";

const ENABLED = import.meta.env.VITE_PIPANE_BOOTSTRAP_DIAGNOSTICS === "1";
type DiagnosticsAction = (diagnostics: BootstrapDiagnosticsController) => void;

let implementation: Promise<BootstrapDiagnosticsController> | undefined;

function schedule(action: DiagnosticsAction): void {
	if (!ENABLED) return;
	implementation ??= import("./bootstrap-diagnostics-panel.js")
		.then(({ BootstrapDiagnosticsController }) => new BootstrapDiagnosticsController({ enabled: true }));
	void implementation.then(action).catch(() => {
		// Preview diagnostics are best-effort and must never affect application startup.
	});
}

/** Build-flagged facade; production bundles compile every operation to a no-op. */
export const bootstrapDiagnostics = {
	enabled: ENABLED,
	mark(label: string, detail?: string): void {
		schedule((diagnostics) => diagnostics.mark(label, detail));
	},
	event(label: string, detail?: string): void {
		schedule((diagnostics) => diagnostics.event(label, detail));
	},
	attachClient(client: BackendClient): void {
		schedule((diagnostics) => diagnostics.attachClient(client));
	},
	fail(error: unknown): void {
		schedule((diagnostics) => diagnostics.fail(error));
	},
	complete(): void {
		schedule((diagnostics) => diagnostics.complete());
	},
};

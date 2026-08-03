import type { BackendClient } from "./backend-client.js";

export interface AppRuntime {
	client: BackendClient;
	/** Remote bootstrap starts transport negotiation while the UI chunk loads. */
	connection?: Promise<void>;
	/** Best-effort verified cached conversation restoration started before transport. */
	startupPreview?: Promise<boolean>;
}

let configured: AppRuntime | undefined;

export function configureAppRuntime(runtime: AppRuntime): void {
	if (configured) throw new Error("Application runtime is already configured");
	configured = runtime;
}

export function consumeAppRuntime(fallback: () => BackendClient): AppRuntime {
	return configured ?? { client: fallback() };
}

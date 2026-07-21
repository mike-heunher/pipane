import type { AuthorizedBackendDescriptor } from "../shared/trust-protocol.js";
import type { BackendClient } from "./backend-client.js";
import type { RemoteBackendManager } from "./remote-backend-manager.js";

export interface RemoteAppRuntime {
	backendId: string;
	backends: readonly AuthorizedBackendDescriptor[];
	manager: Pick<RemoteBackendManager, "revokeBackend">;
}

export interface AppRuntime {
	client: BackendClient;
	remote?: RemoteAppRuntime;
}

let configured: AppRuntime | undefined;

export function configureAppRuntime(runtime: AppRuntime): void {
	if (configured) throw new Error("Application runtime is already configured");
	configured = runtime;
}

export function consumeAppRuntime(fallback: () => BackendClient): AppRuntime {
	return configured ?? { client: fallback() };
}

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBackendState } from "./backend-client.js";
import { renderBackendUnavailableRecovery } from "./backend-unavailable-recovery.js";

function backend(overrides: Partial<WorkspaceBackendState> = {}): WorkspaceBackendState {
	return {
		backendId: "b_phone",
		name: "phone backend",
		softwareVersion: "0.1.16",
		protocolVersions: [1, 2],
		online: true,
		connected: false,
		reconnecting: false,
		...overrides,
	};
}

function recovery(backends: WorkspaceBackendState[]) {
	const onConfigureRelay = vi.fn();
	const onRetry = vi.fn();
	const onConnectionDetails = vi.fn();
	const onRemoveBackend = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	render(renderBackendUnavailableRecovery({
		errorMessage: "Could not connect to any authorized backend",
		backends,
		backendDisplayName: (backendId) => backends.find((item) => item.backendId === backendId)?.name ?? backendId,
		onConfigureRelay,
		onRetry,
		onConnectionDetails,
		onRemoveBackend,
	}), container);
	return { container, onConfigureRelay, onRetry, onConnectionDetails };
}

afterEach(() => document.body.replaceChildren());

describe("backend unavailable recovery", () => {
	it("keeps TURN settings reachable when the connection failure is unclassified", () => {
		const { container, onConfigureRelay, onRetry } = recovery([backend({
			error: "Connection failed",
			connectionFailure: { code: "unknown", message: "Connection failed", turnRecommended: false },
		})]);
		const turn = container.querySelector<HTMLButtonElement>("[data-testid='turn-relay-settings']")!;
		expect(turn.textContent).toBe("TURN settings");
		expect(container.textContent).toContain("TURN helps only when an online backend cannot establish a direct network path");
		turn.click();
		expect(onConfigureRelay).toHaveBeenCalledOnce();
		[...container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Try again")?.click();
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it("retains the actionable TURN recommendation for classified ICE failures", () => {
		const { container, onConnectionDetails } = recovery([backend({
			error: "ICE failed",
			connectionFailure: { code: "ice", message: "ICE failed", turnRecommended: true },
		})]);
		expect(container.querySelector("[data-testid='turn-relay-settings']")?.textContent).toBe("Set up a relay");
		expect(container.textContent).toContain("No direct network path was found");
		[...container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Connection details")?.click();
		expect(onConnectionDetails).toHaveBeenCalledWith("b_phone");
	});
});

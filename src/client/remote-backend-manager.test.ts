import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "./backend-client.js";
import type { BrowserDeviceIdentity } from "./device-identity.js";
import { RemoteBackendManager } from "./remote-backend-manager.js";

const identity = {
	deviceId: "d_browser",
	publicKey: "public",
	privateKey: {} as CryptoKey,
} satisfies BrowserDeviceIdentity;

function fakeClient(): BackendClient {
	return { disconnect: vi.fn() } as unknown as BackendClient;
}

describe("RemoteBackendManager", () => {
	it("discovers N backends, creates one cached client per active backend, and revokes independently", async () => {
		const one = fakeClient();
		const two = fakeClient();
		const listAuthorizedBackends = vi.fn(async () => [
			{ backendId: "b_one", name: "One", protocolVersions: [1, 2], online: true },
			{ backendId: "b_two", name: "Two", protocolVersions: [1, 2], online: true },
		]);
		const revokeBackend = vi.fn(async () => undefined);
		const createClient = vi.fn((backendId: string) => backendId === "b_one" ? one : two);
		const manager = new RemoteBackendManager("https://app.example", {
			loadIdentity: async () => identity,
			createTrustApi: () => ({
				listAuthorizedBackends,
				createConnectionTicket: vi.fn(),
				revokeBackend,
			}),
			createClient,
		});

		await expect(manager.initialize()).resolves.toHaveLength(2);
		expect(manager.getClient("b_one")).toBe(one);
		expect(manager.getClient("b_two")).toBe(two);
		expect(manager.getClient("b_one")).toBe(one);
		expect(createClient).toHaveBeenCalledTimes(2);

		await manager.revokeBackend("b_one");
		expect(revokeBackend).toHaveBeenCalledWith(identity, "b_one");
		expect(one.disconnect).toHaveBeenCalled();
		expect(manager.authorizedBackends.map((backend) => backend.backendId)).toEqual(["b_two"]);
	});

	it("refreshes backend presence without recreating cached clients", async () => {
		const client = fakeClient();
		const listAuthorizedBackends = vi.fn()
			.mockResolvedValueOnce([{ backendId: "b_one", protocolVersions: [2], online: false }])
			.mockResolvedValueOnce([{ backendId: "b_one", name: "Restarted", protocolVersions: [2], online: true }]);
		const createClient = vi.fn(() => client);
		const manager = new RemoteBackendManager("https://app.example", {
			loadIdentity: async () => identity,
			createTrustApi: () => ({
				listAuthorizedBackends,
				createConnectionTicket: vi.fn(),
				revokeBackend: vi.fn(),
			}),
			createClient,
		});

		await manager.initialize();
		expect(manager.getClient("b_one")).toBe(client);
		await expect(manager.refreshAuthorizedBackends()).resolves.toEqual([
			expect.objectContaining({ backendId: "b_one", name: "Restarted", online: true }),
		]);
		expect(manager.getClient("b_one")).toBe(client);
		expect(createClient).toHaveBeenCalledOnce();
	});

	it("refuses arbitrary backend IDs that are not in the signed account discovery result", async () => {
		const manager = new RemoteBackendManager("https://app.example", {
			loadIdentity: async () => identity,
			createTrustApi: () => ({
				listAuthorizedBackends: async () => [],
				createConnectionTicket: vi.fn(),
				revokeBackend: vi.fn(),
			}),
			createClient: () => fakeClient(),
		});
		await manager.initialize();
		expect(() => manager.getClient("b_unknown")).toThrow("not authorized");
	});
});

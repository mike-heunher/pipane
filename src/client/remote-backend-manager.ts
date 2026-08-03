import type { AuthorizedBackendDescriptor, IceServerConfiguration } from "../shared/trust-protocol.js";
import { BACKEND_PROTOCOL_VERSION } from "../shared/backend-protocol.js";
import type { BackendClient } from "./backend-client.js";
import { DataChannelBackendApi } from "./data-channel-backend-api.js";
import {
	loadOrCreateBrowserDeviceIdentity,
	type BrowserDeviceIdentity,
} from "./device-identity.js";
import { RendezvousTrustApi } from "./rendezvous-trust-api.js";
import { WebRtcFrameTransport } from "./webrtc-frame-transport.js";
import { WsAgentAdapter } from "./ws-agent-adapter.js";
import { resolveStoredTurnRelayIceServers } from "./turn-relay.js";

type RemoteTrustApi = Pick<RendezvousTrustApi, "listAuthorizedBackends" | "createConnectionTicket" | "revokeBackend">;

export interface RemoteBackendManagerDependencies {
	loadIdentity(): Promise<BrowserDeviceIdentity>;
	createTrustApi(): RemoteTrustApi;
	resolveTurnIceServers?(subject: string): Promise<IceServerConfiguration[]>;
	createClient?(backendId: string, identity: BrowserDeviceIdentity, api: RemoteTrustApi): BackendClient;
}

export class RemoteBackendManager {
	private identity: BrowserDeviceIdentity | undefined;
	private trustApi: RemoteTrustApi | undefined;
	private descriptors: AuthorizedBackendDescriptor[] = [];
	private readonly clients = new Map<string, BackendClient>();

	constructor(
		private readonly rendezvousUrl: string,
		private readonly dependencies: RemoteBackendManagerDependencies = {
			loadIdentity: () => loadOrCreateBrowserDeviceIdentity(),
			createTrustApi: () => new RendezvousTrustApi(rendezvousUrl),
		},
	) {}

	async initialize(): Promise<readonly AuthorizedBackendDescriptor[]> {
		this.identity ??= await this.dependencies.loadIdentity();
		this.trustApi ??= this.dependencies.createTrustApi();
		return this.refreshAuthorizedBackends();
	}

	async refreshAuthorizedBackends(): Promise<readonly AuthorizedBackendDescriptor[]> {
		if (!this.identity || !this.trustApi) throw new Error("Remote backend manager is not initialized");
		this.descriptors = await this.trustApi.listAuthorizedBackends(this.identity);
		return this.authorizedBackends;
	}

	get authorizedBackends(): readonly AuthorizedBackendDescriptor[] {
		return this.descriptors.map((descriptor) => ({ ...descriptor, protocolVersions: [...descriptor.protocolVersions] }));
	}

	getClient(backendId: string): BackendClient {
		const existing = this.clients.get(backendId);
		if (existing) return existing;
		if (!this.identity || !this.trustApi) throw new Error("Remote backend manager is not initialized");
		const descriptor = this.descriptors.find((candidate) => candidate.backendId === backendId);
		if (!descriptor) throw new Error("This browser is not authorized for the requested backend");
		if (descriptor.online && !descriptor.protocolVersions.includes(BACKEND_PROTOCOL_VERSION)) {
			throw new Error(`Backend does not support semantic protocol v${BACKEND_PROTOCOL_VERSION}`);
		}
		const client = this.dependencies.createClient
			? this.dependencies.createClient(backendId, this.identity, this.trustApi)
			: this.createClient(backendId, this.identity, this.trustApi);
		this.clients.set(backendId, client);
		return client;
	}

	async revokeBackend(backendId: string): Promise<void> {
		if (!this.identity || !this.trustApi) throw new Error("Remote backend manager is not initialized");
		await this.trustApi.revokeBackend(this.identity, backendId);
		this.clients.get(backendId)?.disconnect();
		this.clients.delete(backendId);
		this.descriptors = this.descriptors.filter((descriptor) => descriptor.backendId !== backendId);
	}

	disconnectAll(): void {
		for (const client of this.clients.values()) client.disconnect();
		this.clients.clear();
	}

	private createClient(
		backendId: string,
		identity: BrowserDeviceIdentity,
		trustApi: RemoteTrustApi,
	): BackendClient {
		const transport = new WebRtcFrameTransport({
			rendezvousUrl: this.rendezvousUrl,
			backendId,
			deviceIdentity: identity,
			authorize: async () => {
				const [authorization, supplementalIceServers] = await Promise.all([
					trustApi.createConnectionTicket(identity, backendId),
					(this.dependencies.resolveTurnIceServers ?? resolveStoredTurnRelayIceServers)(identity.deviceId),
				]);
				return { ...authorization, supplementalIceServers };
			},
		});
		const api = new DataChannelBackendApi(transport, backendId);
		return new WsAgentAdapter({ transport, api, cacheBackendId: backendId });
	}
}

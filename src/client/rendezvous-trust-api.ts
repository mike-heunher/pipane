import type {
	AuthorizedBackendDescriptor,
	ConnectionTicketResponse,
	DeviceChallenge,
	DeviceChallengeRequest,
} from "../shared/trust-protocol.js";
import {
	signDeviceChallenge,
	type BrowserDeviceIdentity,
} from "./device-identity.js";

export interface PairingCapabilityFromUrl {
	pairId: string;
	backendId: string;
	secret: string;
}

export type TrustFetch = typeof fetch;

export class RendezvousTrustApi {
	private readonly baseUrl: string;
	private readonly fetch: TrustFetch;

	constructor(baseUrl: string, fetchImplementation: TrustFetch = globalThis.fetch.bind(globalThis)) {
		const url = new URL(baseUrl);
		url.pathname = "/";
		url.search = "";
		url.hash = "";
		this.baseUrl = url.toString();
		this.fetch = fetchImplementation;
	}

	async createPairingTicket(
		identity: BrowserDeviceIdentity,
		capability: Omit<PairingCapabilityFromUrl, "secret">,
		connectionId = `c_${crypto.randomUUID()}`,
	): Promise<ConnectionTicketResponse> {
		const challenge = await this.createChallenge({
			purpose: "pair",
			deviceId: identity.deviceId,
			devicePublicKey: identity.publicKey,
			backendId: capability.backendId,
			connectionId,
			pairId: capability.pairId,
		});
		return this.completeTicket(
			`v1/pairings/${encodeURIComponent(capability.pairId)}/tickets`,
			identity,
			challenge,
		);
	}

	async createConnectionTicket(
		identity: BrowserDeviceIdentity,
		backendId: string,
		connectionId = `c_${crypto.randomUUID()}`,
	): Promise<ConnectionTicketResponse> {
		const challenge = await this.createChallenge({
			purpose: "connect",
			deviceId: identity.deviceId,
			backendId,
			connectionId,
		});
		return this.completeTicket("v1/connections/tickets", identity, challenge);
	}

	async listAuthorizedBackends(identity: BrowserDeviceIdentity): Promise<AuthorizedBackendDescriptor[]> {
		const challenge = await this.createChallenge({ purpose: "discover", deviceId: identity.deviceId });
		const response = await this.completeSignedRequest<{ backends?: AuthorizedBackendDescriptor[] }>(
			"v1/accounts/backends",
			identity,
			challenge,
		);
		if (!Array.isArray(response.backends) || !response.backends.every(isAuthorizedBackendDescriptor)) {
			throw new Error("Rendezvous returned an invalid backend list");
		}
		return response.backends;
	}

	async revokeDevice(identity: BrowserDeviceIdentity, backendId: string, targetDeviceId: string): Promise<void> {
		const challenge = await this.createChallenge({
			purpose: "revoke_device",
			deviceId: identity.deviceId,
			backendId,
			targetDeviceId,
		});
		await this.completeMutation("v1/revocations/devices", identity, challenge);
	}

	async revokeBackend(identity: BrowserDeviceIdentity, backendId: string): Promise<void> {
		const challenge = await this.createChallenge({ purpose: "revoke_backend", deviceId: identity.deviceId, backendId });
		await this.completeMutation("v1/revocations/backends", identity, challenge);
	}

	private async createChallenge(request: DeviceChallengeRequest): Promise<DeviceChallenge> {
		return this.requestJson<DeviceChallenge>("v1/auth/challenges", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
	}

	private async completeTicket(
		path: string,
		identity: BrowserDeviceIdentity,
		challenge: DeviceChallenge,
	): Promise<ConnectionTicketResponse> {
		const signature = await signDeviceChallenge(identity, challenge);
		const response = await this.requestJson<ConnectionTicketResponse>(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
		});
		if (!response || typeof response.ticket !== "string" || !Array.isArray(response.iceServers)) {
			throw new Error("Rendezvous returned an invalid connection ticket");
		}
		return response;
	}

	private async completeMutation(path: string, identity: BrowserDeviceIdentity, challenge: DeviceChallenge): Promise<void> {
		await this.completeSignedRequest(path, identity, challenge);
	}

	private async completeSignedRequest<T = unknown>(
		path: string,
		identity: BrowserDeviceIdentity,
		challenge: DeviceChallenge,
	): Promise<T> {
		const signature = await signDeviceChallenge(identity, challenge);
		return this.requestJson<T>(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
		});
	}

	private async requestJson<T = unknown>(relativePath: string, init: RequestInit): Promise<T> {
		const response = await this.fetch(new URL(relativePath, this.baseUrl), init);
		const value = await response.json().catch(() => undefined) as any;
		if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : `Rendezvous request failed (${response.status})`);
		return value as T;
	}
}

function isAuthorizedBackendDescriptor(value: unknown): value is AuthorizedBackendDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const descriptor = value as Record<string, unknown>;
	return typeof descriptor.backendId === "string"
		&& descriptor.backendId.length > 0
		&& (descriptor.name === undefined || typeof descriptor.name === "string")
		&& (descriptor.softwareVersion === undefined || typeof descriptor.softwareVersion === "string")
		&& Array.isArray(descriptor.protocolVersions)
		&& descriptor.protocolVersions.every((version) => Number.isSafeInteger(version) && (version as number) > 0)
		&& typeof descriptor.online === "boolean";
}

export function parsePairingUrl(value: string): PairingCapabilityFromUrl {
	const url = new URL(value);
	const match = /^\/pair\/([^/]+)$/u.exec(url.pathname);
	const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
	const backendId = fragment.get("backend");
	const secret = fragment.get("secret");
	if (!match?.[1] || !backendId || !secret) throw new Error("Pairing URL is malformed");
	return { pairId: decodeURIComponent(match[1]), backendId, secret };
}

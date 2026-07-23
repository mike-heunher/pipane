import {
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
	sign,
	timingSafeEqual,
	type KeyObject,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	CONNECTION_TICKET_VERSION,
	connectionTicketSignaturePayload,
	deviceChallengePayload,
	TRUST_PROTOCOL_VERSION,
	type ConnectionTicketClaims,
	type DeviceChallenge,
	type DeviceInviteAcceptance,
	type DeviceInviteCapability,
	type DeviceChallengeRequest,
	type IceServerConfiguration,
} from "../shared/trust-protocol.js";
import {
	assertP256Key,
	deriveDeviceId,
	verifyConnectionTicket,
	verifyDeviceSignature,
} from "../shared/node-trust-crypto.js";

export { deriveDeviceId, verifyConnectionTicket, verifyDeviceSignature } from "../shared/node-trust-crypto.js";

const STORE_VERSION = 1 as const;
const SIGNING_IDENTITY_VERSION = 1 as const;
const ACCOUNT_ID_PREFIX = "a_";
const TICKET_ID_PREFIX = "t_";
const CHALLENGE_ID_PREFIX = "ch_";
const DEVICE_INVITE_ID_PREFIX = "invite_";
const DEFAULT_CHALLENGE_TTL_MS = 2 * 60_000;
const DEFAULT_TICKET_TTL_MS = 60_000;
const DEVICE_INVITE_TTL_MS = 10 * 60_000;

interface StoredSigningIdentity {
	version: typeof SIGNING_IDENTITY_VERSION;
	algorithm: "ES256";
	privateKey: string;
}

interface StoredAccount {
	accountId: string;
	deviceIds: string[];
	backendIds: string[];
	createdAt: number;
}

interface StoredDevice {
	deviceId: string;
	publicKey: string;
	accountId: string;
	createdAt: number;
	revokedAt?: number;
}

interface PairingCompletion {
	pairId: string;
	ticketId: string;
	accountId: string;
	deviceId: string;
	backendId: string;
	completedAt: number;
}

interface StoredDeviceInvite {
	inviteId: string;
	secretHash: string;
	accountId: string;
	createdByDeviceId: string;
	createdAt: number;
	expiresAt: number;
}

interface StoredTrustState {
	version: typeof STORE_VERSION;
	accounts: Record<string, StoredAccount>;
	devices: Record<string, StoredDevice>;
	backendOwners: Record<string, string>;
	backendRevocations: Record<string, { accountId: string; revokedAt: number }>;
	pairingCompletions: Record<string, PairingCompletion>;
	deviceInvites: Record<string, StoredDeviceInvite>;
	usedTickets: Record<string, number>;
}

interface SigningIdentity {
	publicKey: string;
	privateKey: KeyObject;
}

export interface RendezvousTrustStoreOptions {
	dataDir?: string;
	now?: () => number;
	challengeTtlMs?: number;
	ticketTtlMs?: number;
}

export interface PairingConfirmation {
	accountId: string;
	deviceId: string;
	backendId: string;
}

export interface RevocationResult {
	accountId: string;
	deviceId?: string;
	backendId?: string;
}

export interface TurnCredentialOptions {
	urls: string[];
	secret: string;
	ttlSeconds?: number;
}

export class IceServerProvider {
	constructor(
		private readonly staticServers: IceServerConfiguration[] = [],
		private readonly turn?: TurnCredentialOptions,
		private readonly now: () => number = Date.now,
	) {}

	issue(subject: string): IceServerConfiguration[] {
		const result = this.staticServers.map((server) => ({
			...server,
			urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
		}));
		if (!this.turn || this.turn.urls.length === 0) return result;
		const expiresAtSeconds = Math.floor(this.now() / 1000) + (this.turn.ttlSeconds ?? 600);
		const username = `${expiresAtSeconds}:${subject}`;
		const credential = createHmac("sha1", this.turn.secret).update(username).digest("base64");
		result.push({ urls: [...this.turn.urls], username, credential });
		return result;
	}
}

export class RendezvousTrustStore {
	readonly ticketPublicKey: string;
	private readonly now: () => number;
	private readonly challengeTtlMs: number;
	private readonly ticketTtlMs: number;
	private readonly statePath: string;
	private readonly signing: SigningIdentity;
	private readonly challenges = new Map<string, DeviceChallenge>();
	private state: StoredTrustState;

	constructor(options: RendezvousTrustStoreOptions = {}) {
		const dataDir = options.dataDir ?? process.env.PIPANE_RENDEZVOUS_DATA_DIR ?? path.join(homedir(), ".config", "pipane-rendezvous");
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.now = options.now ?? Date.now;
		this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
		this.ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
		this.statePath = path.join(dataDir, "trust-store.json");
		this.signing = loadOrCreateSigningIdentity(path.join(dataDir, "ticket-identity.json"));
		this.ticketPublicKey = this.signing.publicKey;
		this.state = loadTrustState(this.statePath);
		this.persist();
	}

	createChallenge(request: DeviceChallengeRequest): DeviceChallenge {
		this.prune();
		this.validateChallengeContext(request);
		const identity = this.resolveChallengeIdentity(request);
		const challenge: DeviceChallenge = {
			version: TRUST_PROTOCOL_VERSION,
			challengeId: `${CHALLENGE_ID_PREFIX}${randomUUID()}`,
			nonce: randomBytes(32).toString("base64url"),
			purpose: request.purpose,
			deviceId: identity.deviceId,
			devicePublicKey: identity.publicKey,
			backendId: request.backendId,
			connectionId: request.connectionId,
			pairId: request.pairId,
			targetDeviceId: request.targetDeviceId,
			expiresAt: this.now() + this.challengeTtlMs,
		};
		this.challenges.set(challenge.challengeId, challenge);
		return challenge;
	}

	issuePairingTicket(challengeId: string, signature: string): { ticket: string; claims: ConnectionTicketClaims } {
		const challenge = this.consumeChallenge(challengeId, signature, "pair");
		const device = this.state.devices[challenge.deviceId];
		const claims: ConnectionTicketClaims = {
			version: CONNECTION_TICKET_VERSION,
			kind: "pairing",
			ticketId: `${TICKET_ID_PREFIX}${randomUUID()}`,
			backendId: challenge.backendId!,
			connectionId: challenge.connectionId!,
			deviceId: challenge.deviceId,
			devicePublicKey: challenge.devicePublicKey,
			...(device ? { accountId: device.accountId } : {}),
			pairId: challenge.pairId!,
			issuedAt: this.now(),
			expiresAt: this.now() + this.ticketTtlMs,
		};
		return { ticket: this.signTicket(claims), claims };
	}

	issueConnectionTicket(challengeId: string, signature: string): { ticket: string; claims: ConnectionTicketClaims } {
		const challenge = this.consumeChallenge(challengeId, signature, "connect");
		const device = this.requireActiveDevice(challenge.deviceId);
		if (this.state.backendOwners[challenge.backendId!] !== device.accountId) {
			throw new Error("Device account is not authorized for this backend");
		}
		const claims: ConnectionTicketClaims = {
			version: CONNECTION_TICKET_VERSION,
			kind: "connection",
			ticketId: `${TICKET_ID_PREFIX}${randomUUID()}`,
			backendId: challenge.backendId!,
			connectionId: challenge.connectionId!,
			deviceId: device.deviceId,
			devicePublicKey: device.publicKey,
			accountId: device.accountId,
			issuedAt: this.now(),
			expiresAt: this.now() + this.ticketTtlMs,
		};
		return { ticket: this.signTicket(claims), claims };
	}

	verifyTicket(ticket: string): ConnectionTicketClaims {
		return verifyConnectionTicket(ticket, this.ticketPublicKey, this.now());
	}

	consumeRouteTicket(ticket: string): ConnectionTicketClaims {
		const claims = this.verifyTicket(ticket);
		this.prune();
		if (this.state.usedTickets[claims.ticketId] !== undefined) throw new Error("Connection ticket was already used");
		this.state.usedTickets[claims.ticketId] = claims.expiresAt;
		this.persist();
		return claims;
	}

	confirmPairing(claims: ConnectionTicketClaims): PairingConfirmation {
		if (claims.kind !== "pairing" || !claims.pairId) throw new Error("Connection is not a pairing attempt");
		const prior = this.state.pairingCompletions[claims.pairId];
		if (prior) {
			if (prior.ticketId !== claims.ticketId) throw new Error("Pairing capability was already used");
			return { accountId: prior.accountId, deviceId: prior.deviceId, backendId: prior.backendId };
		}

		const currentOwner = this.state.backendOwners[claims.backendId];
		let accountId = claims.accountId ?? currentOwner;
		if (claims.accountId && currentOwner && claims.accountId !== currentOwner) {
			throw new Error("Backend is owned by another account");
		}
		const existingDevice = this.state.devices[claims.deviceId];
		if (existingDevice?.revokedAt) throw new Error("Device is revoked");
		if (existingDevice && existingDevice.publicKey !== claims.devicePublicKey) throw new Error("Device public key mismatch");
		if (existingDevice && claims.accountId !== existingDevice.accountId) throw new Error("Device account mismatch");
		if (!accountId) accountId = `${ACCOUNT_ID_PREFIX}${randomUUID()}`;
		if (existingDevice && existingDevice.accountId !== accountId) throw new Error("Device belongs to another account");

		const account = this.state.accounts[accountId] ?? {
			accountId,
			deviceIds: [],
			backendIds: [],
			createdAt: this.now(),
		};
		if (!account.deviceIds.includes(claims.deviceId)) account.deviceIds.push(claims.deviceId);
		if (!account.backendIds.includes(claims.backendId)) account.backendIds.push(claims.backendId);
		this.state.accounts[accountId] = account;
		this.state.devices[claims.deviceId] = existingDevice ?? {
			deviceId: claims.deviceId,
			publicKey: claims.devicePublicKey,
			accountId,
			createdAt: this.now(),
		};
		this.state.backendOwners[claims.backendId] = accountId;
		delete this.state.backendRevocations[claims.backendId];
		this.state.pairingCompletions[claims.pairId] = {
			pairId: claims.pairId,
			ticketId: claims.ticketId,
			accountId,
			deviceId: claims.deviceId,
			backendId: claims.backendId,
			completedAt: this.now(),
		};
		this.persist();
		return { accountId, deviceId: claims.deviceId, backendId: claims.backendId };
	}

	listAuthorizedBackendIds(challengeId: string, signature: string): string[] {
		const challenge = this.consumeChallenge(challengeId, signature, "discover");
		const device = this.requireActiveDevice(challenge.deviceId);
		return [...this.state.accounts[device.accountId].backendIds];
	}

	createDeviceInvite(challengeId: string, signature: string): DeviceInviteCapability {
		const challenge = this.consumeChallenge(challengeId, signature, "create_device_invite");
		const actor = this.requireActiveDevice(challenge.deviceId);
		const secret = randomBytes(32).toString("base64url");
		const invite: StoredDeviceInvite = {
			inviteId: `${DEVICE_INVITE_ID_PREFIX}${randomUUID()}`,
			secretHash: hashDeviceInviteSecret(secret),
			accountId: actor.accountId,
			createdByDeviceId: actor.deviceId,
			createdAt: this.now(),
			expiresAt: this.now() + DEVICE_INVITE_TTL_MS,
		};
		this.state.deviceInvites[invite.inviteId] = invite;
		this.persist();
		return { inviteId: invite.inviteId, secret, expiresAt: invite.expiresAt };
	}

	acceptDeviceInvite(
		challengeId: string,
		signature: string,
		inviteId: string,
		secret: string,
	): DeviceInviteAcceptance {
		const challenge = this.consumeChallenge(challengeId, signature, "accept_device_invite");
		if (challenge.pairId !== inviteId) throw new Error("Device challenge does not match this invite");
		const invite = this.state.deviceInvites[inviteId];
		if (!invite || invite.expiresAt <= this.now()) throw new Error("Device invite is missing or expired");
		if (!secretsEqual(hashDeviceInviteSecret(secret), invite.secretHash)) throw new Error("Invalid device invite secret");

		const existingDevice = this.state.devices[challenge.deviceId];
		if (existingDevice) {
			if (existingDevice.accountId === invite.accountId) throw new Error("This browser already has access to this account");
			throw new Error("This browser already belongs to another account");
		}
		const account = this.state.accounts[invite.accountId];
		if (!account) throw new Error("Device invite account is missing");
		account.deviceIds.push(challenge.deviceId);
		this.state.devices[challenge.deviceId] = {
			deviceId: challenge.deviceId,
			publicKey: challenge.devicePublicKey,
			accountId: account.accountId,
			createdAt: this.now(),
		};
		delete this.state.deviceInvites[inviteId];
		this.persist();
		return { accountId: account.accountId, deviceId: challenge.deviceId };
	}

	revokeDevice(challengeId: string, signature: string): RevocationResult {
		const challenge = this.consumeChallenge(challengeId, signature, "revoke_device");
		const actor = this.requireActiveDevice(challenge.deviceId);
		const target = this.state.devices[challenge.targetDeviceId!];
		if (!target || target.accountId !== actor.accountId) throw new Error("Target device does not belong to this account");
		target.revokedAt = this.now();
		this.persist();
		return { accountId: actor.accountId, deviceId: target.deviceId };
	}

	revokeBackend(challengeId: string, signature: string): RevocationResult {
		const challenge = this.consumeChallenge(challengeId, signature, "revoke_backend");
		const actor = this.requireActiveDevice(challenge.deviceId);
		if (this.state.backendOwners[challenge.backendId!] !== actor.accountId) {
			throw new Error("Backend does not belong to this account");
		}
		delete this.state.backendOwners[challenge.backendId!];
		this.state.backendRevocations[challenge.backendId!] = { accountId: actor.accountId, revokedAt: this.now() };
		const account = this.state.accounts[actor.accountId];
		account.backendIds = account.backendIds.filter((backendId) => backendId !== challenge.backendId);
		this.persist();
		return { accountId: actor.accountId, backendId: challenge.backendId };
	}

	isDeviceActive(deviceId: string): boolean {
		const device = this.state.devices[deviceId];
		return !!device && device.revokedAt === undefined;
	}

	getBackendOwner(backendId: string): string | undefined {
		return this.state.backendOwners[backendId];
	}

	getPendingBackendRevocation(backendId: string): RevocationResult | undefined {
		const revocation = this.state.backendRevocations[backendId];
		return revocation ? { accountId: revocation.accountId, backendId } : undefined;
	}

	private consumeChallenge(
		challengeId: string,
		signature: string,
		expectedPurpose: DeviceChallenge["purpose"],
	): DeviceChallenge {
		const challenge = this.challenges.get(challengeId);
		this.challenges.delete(challengeId);
		if (!challenge || challenge.expiresAt <= this.now()) throw new Error("Device challenge is missing or expired");
		if (challenge.purpose !== expectedPurpose) throw new Error("Device challenge has the wrong purpose");
		if (!verifyDeviceSignature(challenge.devicePublicKey, deviceChallengePayload(challenge), signature)) {
			throw new Error("Invalid device challenge signature");
		}
		return challenge;
	}

	private resolveChallengeIdentity(request: DeviceChallengeRequest): { deviceId: string; publicKey: string } {
		if (request.deviceId) {
			const device = this.state.devices[request.deviceId];
			if (device) {
				if (device.revokedAt !== undefined) throw new Error("Device is unknown or revoked");
				if (request.devicePublicKey && request.devicePublicKey !== device.publicKey) throw new Error("Device public key mismatch");
				return { deviceId: device.deviceId, publicKey: device.publicKey };
			}
			if ((request.purpose === "pair" || request.purpose === "accept_device_invite")
				&& request.devicePublicKey
				&& deriveDeviceId(request.devicePublicKey) === request.deviceId) {
				return { deviceId: request.deviceId, publicKey: request.devicePublicKey };
			}
			throw new Error("Device is unknown or revoked");
		}
		if ((request.purpose !== "pair" && request.purpose !== "accept_device_invite") || !request.devicePublicKey) {
			throw new Error("An existing device is required for this challenge");
		}
		return { deviceId: deriveDeviceId(request.devicePublicKey), publicKey: request.devicePublicKey };
	}

	private validateChallengeContext(request: DeviceChallengeRequest): void {
		if (request.purpose !== "pair"
			&& request.purpose !== "connect"
			&& request.purpose !== "discover"
			&& request.purpose !== "create_device_invite"
			&& request.purpose !== "accept_device_invite"
			&& request.purpose !== "revoke_device"
			&& request.purpose !== "revoke_backend") {
			throw new Error("Unsupported device challenge purpose");
		}
		if (request.purpose !== "discover"
			&& request.purpose !== "create_device_invite"
			&& request.purpose !== "accept_device_invite"
			&& !request.backendId) {
			throw new Error("backendId is required");
		}
		if (request.purpose === "pair" || request.purpose === "connect") {
			if (!request.connectionId) throw new Error("connectionId is required");
		}
		if (request.purpose === "pair" && !request.pairId) throw new Error("pairId is required");
		if (request.purpose === "accept_device_invite") {
			if (!request.pairId || !this.state.deviceInvites[request.pairId]) throw new Error("Device invite is missing or expired");
		}
		if (request.purpose === "revoke_device" && !request.targetDeviceId) throw new Error("targetDeviceId is required");
	}

	private requireActiveDevice(deviceId: string): StoredDevice {
		const device = this.state.devices[deviceId];
		if (!device || device.revokedAt !== undefined) throw new Error("Device is unknown or revoked");
		return device;
	}

	private signTicket(claims: ConnectionTicketClaims): string {
		const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const signature = sign("sha256", Buffer.from(connectionTicketSignaturePayload(encodedClaims)), {
			key: this.signing.privateKey,
			dsaEncoding: "ieee-p1363",
		}).toString("base64url");
		return `${encodedClaims}.${signature}`;
	}

	private prune(): void {
		const now = this.now();
		for (const [challengeId, challenge] of this.challenges) {
			if (challenge.expiresAt <= now) this.challenges.delete(challengeId);
		}
		let changed = false;
		for (const [inviteId, invite] of Object.entries(this.state.deviceInvites)) {
			if (invite.expiresAt > now) continue;
			delete this.state.deviceInvites[inviteId];
			changed = true;
		}
		for (const [ticketId, expiresAt] of Object.entries(this.state.usedTickets)) {
			if (expiresAt > now) continue;
			delete this.state.usedTickets[ticketId];
			changed = true;
		}
		if (changed) this.persist();
	}

	private persist(): void {
		const temporaryPath = `${this.statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, this.statePath);
		chmodSync(this.statePath, 0o600);
	}
}

function loadOrCreateSigningIdentity(filePath: string): SigningIdentity {
	let stored: StoredSigningIdentity | undefined;
	try {
		stored = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw new Error(`Invalid rendezvous signing identity: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!stored) {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		stored = {
			version: SIGNING_IDENTITY_VERSION,
			algorithm: "ES256",
			privateKey: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64url"),
		};
		writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	}
	if (stored.version !== SIGNING_IDENTITY_VERSION || stored.algorithm !== "ES256" || typeof stored.privateKey !== "string") {
		throw new Error("Invalid rendezvous signing identity");
	}
	chmodSync(filePath, 0o600);
	const privateKey = createPrivateKey({ key: Buffer.from(stored.privateKey, "base64url"), format: "der", type: "pkcs8" });
	assertP256Key(privateKey);
	const publicKeyObject = createPublicKey(privateKey.export({ type: "pkcs8", format: "pem" }));
	assertP256Key(publicKeyObject);
	return {
		privateKey,
		publicKey: Buffer.from(publicKeyObject.export({ type: "spki", format: "der" })).toString("base64url"),
	};
}

function loadTrustState(filePath: string): StoredTrustState {
	try {
		const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isTrustState(value)) throw new Error("unsupported or malformed state");
		value.backendRevocations ??= {};
		value.deviceInvites ??= {};
		if (!hasConsistentReferences(value)) throw new Error("unsupported or malformed state");
		return value;
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw new Error(`Invalid rendezvous trust store: ${error instanceof Error ? error.message : String(error)}`);
		return {
			version: STORE_VERSION,
			accounts: {},
			devices: {},
			backendOwners: {},
			backendRevocations: {},
			pairingCompletions: {},
			deviceInvites: {},
			usedTickets: {},
		};
	}
}

function isTrustState(value: unknown): value is StoredTrustState {
	if (!isRecord(value) || value.version !== STORE_VERSION) return false;
	return isRecordOf(value.accounts, (account, key) => isRecord(account)
		&& account.accountId === key
		&& isStringArray(account.deviceIds)
		&& isStringArray(account.backendIds)
		&& isNonNegativeInteger(account.createdAt))
		&& isRecordOf(value.devices, (device, key) => isRecord(device)
			&& device.deviceId === key
			&& isNonEmptyString(device.publicKey)
			&& isNonEmptyString(device.accountId)
			&& isNonNegativeInteger(device.createdAt)
			&& (device.revokedAt === undefined || isNonNegativeInteger(device.revokedAt)))
		&& isRecordOf(value.backendOwners, (accountId) => isNonEmptyString(accountId))
		&& (value.backendRevocations === undefined || isRecordOf(value.backendRevocations, (revocation) => isRecord(revocation)
			&& isNonEmptyString(revocation.accountId)
			&& isNonNegativeInteger(revocation.revokedAt)))
		&& isRecordOf(value.pairingCompletions, (completion, key) => isRecord(completion)
			&& completion.pairId === key
			&& isNonEmptyString(completion.ticketId)
			&& isNonEmptyString(completion.accountId)
			&& isNonEmptyString(completion.deviceId)
			&& isNonEmptyString(completion.backendId)
			&& isNonNegativeInteger(completion.completedAt))
		&& (value.deviceInvites === undefined || isRecordOf(value.deviceInvites, (invite, key) => isRecord(invite)
			&& invite.inviteId === key
			&& isNonEmptyString(invite.secretHash)
			&& isNonEmptyString(invite.accountId)
			&& isNonEmptyString(invite.createdByDeviceId)
			&& isNonNegativeInteger(invite.createdAt)
			&& isNonNegativeInteger(invite.expiresAt)
			&& invite.expiresAt > invite.createdAt))
		&& isRecordOf(value.usedTickets, (expiresAt) => isNonNegativeInteger(expiresAt));
}

function hasConsistentReferences(state: StoredTrustState): boolean {
	try {
		for (const device of Object.values(state.devices)) {
			if (deriveDeviceId(device.publicKey) !== device.deviceId) return false;
			const account = state.accounts[device.accountId];
			if (!account?.deviceIds.includes(device.deviceId)) return false;
		}
		for (const account of Object.values(state.accounts)) {
			if (account.deviceIds.some((deviceId) => state.devices[deviceId]?.accountId !== account.accountId)) return false;
			if (account.backendIds.some((backendId) => state.backendOwners[backendId] !== account.accountId)) return false;
		}
		for (const [backendId, accountId] of Object.entries(state.backendOwners)) {
			if (!state.accounts[accountId]?.backendIds.includes(backendId)) return false;
		}
		for (const invite of Object.values(state.deviceInvites)) {
			if (!state.accounts[invite.accountId]) return false;
			if (state.devices[invite.createdByDeviceId]?.accountId !== invite.accountId) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function hashDeviceInviteSecret(secret: string): string {
	return createHash("sha256").update(`pipane-device-invite-v1\n${secret}`).digest("base64url");
}

function secretsEqual(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRecordOf(
	value: unknown,
	predicate: (entry: unknown, key: string) => boolean,
): value is Record<string, unknown> {
	return isRecord(value) && Object.entries(value).every(([key, entry]) => predicate(entry, key));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

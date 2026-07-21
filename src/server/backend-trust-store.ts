import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ConnectionTicketClaims } from "../shared/trust-protocol.js";

const BACKEND_TRUST_VERSION = 1 as const;
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIRING_TTL_MS = 15 * 60_000;

interface StoredPairing {
	pairId: string;
	secretHash: string;
	expiresAt: number;
	usedAt?: number;
}

interface StoredBackendTrust {
	version: typeof BACKEND_TRUST_VERSION;
	ownerAccountId?: string;
	pairings: Record<string, StoredPairing>;
	usedTickets: Record<string, number>;
	revokedDevices: Record<string, number>;
}

export interface PairingCapability {
	pairId: string;
	secret: string;
	expiresAt: number;
}

export interface BackendTrustStoreOptions {
	filePath?: string;
	now?: () => number;
}

export function defaultBackendTrustPath(): string {
	const configDir = process.env.PIPANE_CONFIG_DIR || path.join(homedir(), ".config", "pipane");
	return path.join(configDir, "backend-trust.json");
}

export class BackendTrustStore {
	private readonly filePath: string;
	private readonly now: () => number;
	private state: StoredBackendTrust;

	constructor(options: BackendTrustStoreOptions = {}) {
		this.filePath = options.filePath ?? defaultBackendTrustPath();
		this.now = options.now ?? Date.now;
		mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		this.state = loadState(this.filePath);
		this.persist();
	}

	get ownerAccountId(): string | undefined {
		return this.state.ownerAccountId;
	}

	createPairing(ttlMs = DEFAULT_PAIRING_TTL_MS): PairingCapability {
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_PAIRING_TTL_MS) {
			throw new Error("Pairing lifetime is outside the allowed range");
		}
		this.prune();
		const secret = randomBytes(32).toString("base64url");
		const pairing: StoredPairing = {
			pairId: `pair_${randomUUID()}`,
			secretHash: hashSecret(secret),
			expiresAt: this.now() + ttlMs,
		};
		this.state.pairings[pairing.pairId] = pairing;
		this.persist();
		return { pairId: pairing.pairId, secret, expiresAt: pairing.expiresAt };
	}

	listActivePairings(): Array<Omit<PairingCapability, "secret">> {
		this.prune();
		return Object.values(this.state.pairings)
			.filter((pairing) => pairing.usedAt === undefined && pairing.expiresAt > this.now())
			.map(({ pairId, expiresAt }) => ({ pairId, expiresAt }));
	}

	consumePairing(pairId: string, secret: string): void {
		const pairing = this.state.pairings[pairId];
		if (!pairing || pairing.expiresAt <= this.now() || pairing.usedAt !== undefined) {
			throw new Error("Pairing capability is missing, expired, or already used");
		}
		const actual = Buffer.from(hashSecret(secret));
		const expected = Buffer.from(pairing.secretHash);
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid pairing secret");
		pairing.usedAt = this.now();
		this.persist();
	}

	authorizeTicket(claims: ConnectionTicketClaims): void {
		this.prune();
		if (this.state.usedTickets[claims.ticketId] !== undefined) throw new Error("Connection ticket was already used by this backend");
		if (claims.kind === "connection") {
			if (!claims.accountId || claims.accountId !== this.state.ownerAccountId) {
				throw new Error("Connection ticket account does not own this backend");
			}
			if (this.state.revokedDevices[claims.deviceId] !== undefined) throw new Error("Device authorization is revoked");
		}
	}

	markTicketUsed(claims: ConnectionTicketClaims): void {
		if (this.state.usedTickets[claims.ticketId] !== undefined) throw new Error("Connection ticket was already used by this backend");
		this.state.usedTickets[claims.ticketId] = claims.expiresAt;
		this.persist();
	}

	completePairing(accountId: string): void {
		if (this.state.ownerAccountId && this.state.ownerAccountId !== accountId) {
			throw new Error("Backend is already owned by another account");
		}
		this.state.ownerAccountId = accountId;
		this.persist();
	}

	applyRevocation(accountId: string, deviceId?: string): void {
		if (this.state.ownerAccountId !== accountId) return;
		if (deviceId) this.state.revokedDevices[deviceId] = this.now();
		else this.state.ownerAccountId = undefined;
		this.persist();
	}

	private prune(): void {
		const now = this.now();
		let changed = false;
		for (const [pairId, pairing] of Object.entries(this.state.pairings)) {
			if (pairing.expiresAt > now) continue;
			delete this.state.pairings[pairId];
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
		const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, this.filePath);
		chmodSync(this.filePath, 0o600);
	}
}

function loadState(filePath: string): StoredBackendTrust {
	try {
		const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isStoredBackendTrust(value)) throw new Error("unsupported or malformed state");
		return value;
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw new Error(`Invalid backend trust store: ${error instanceof Error ? error.message : String(error)}`);
		return { version: BACKEND_TRUST_VERSION, pairings: {}, usedTickets: {}, revokedDevices: {} };
	}
}

function isStoredBackendTrust(value: unknown): value is StoredBackendTrust {
	if (!isRecord(value) || value.version !== BACKEND_TRUST_VERSION) return false;
	return (value.ownerAccountId === undefined || isNonEmptyString(value.ownerAccountId))
		&& isRecordOf(value.pairings, (pairing, key) => isRecord(pairing)
			&& pairing.pairId === key
			&& isNonEmptyString(pairing.secretHash)
			&& isNonNegativeInteger(pairing.expiresAt)
			&& (pairing.usedAt === undefined || isNonNegativeInteger(pairing.usedAt)))
		&& isRecordOf(value.usedTickets, isNonNegativeInteger)
		&& isRecordOf(value.revokedDevices, isNonNegativeInteger);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRecordOf(value: unknown, predicate: (entry: unknown, key: string) => boolean): value is Record<string, unknown> {
	return isRecord(value) && Object.entries(value).every(([key, entry]) => predicate(entry, key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hashSecret(secret: string): string {
	return createHash("sha256").update(`pipane-pairing-secret-v1\n${secret}`).digest("base64url");
}

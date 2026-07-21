import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
	type KeyObject,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { backendRegistrationPayload } from "../shared/rendezvous-protocol.js";

const BACKEND_IDENTITY_VERSION = 1 as const;
const BACKEND_ID_PREFIX = "b_";

interface StoredBackendIdentity {
	version: typeof BACKEND_IDENTITY_VERSION;
	algorithm: "ES256";
	privateKey: string;
}

export interface BackendIdentity {
	backendId: string;
	algorithm: "ES256";
	/** DER-encoded SubjectPublicKeyInfo in base64url form. */
	publicKey: string;
	privateKey: KeyObject;
	filePath: string;
}

export function defaultBackendIdentityPath(): string {
	const configDir = process.env.PIPANE_CONFIG_DIR || path.join(homedir(), ".config", "pipane");
	return path.join(configDir, "backend-identity.json");
}

export function loadOrCreateBackendIdentity(
	filePath = defaultBackendIdentityPath(),
): BackendIdentity {
	try {
		return loadBackendIdentity(filePath);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}

	mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" });
	const stored: StoredBackendIdentity = {
		version: BACKEND_IDENTITY_VERSION,
		algorithm: "ES256",
		privateKey: Buffer.from(privateKeyDer).toString("base64url"),
	};

	try {
		writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
	} catch (error: any) {
		// Another pipane process may have created the identity concurrently.
		if (error?.code !== "EEXIST") throw error;
	}
	chmodSync(filePath, 0o600);
	return loadBackendIdentity(filePath);
}

export function loadBackendIdentity(filePath: string): BackendIdentity {
	let stored: unknown;
	try {
		stored = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error: any) {
		if (error?.code === "ENOENT") throw error;
		throw new Error(`Invalid backend identity file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isStoredBackendIdentity(stored)) {
		throw new Error(`Invalid backend identity file ${filePath}: unsupported or malformed identity`);
	}

	let privateKey: KeyObject;
	try {
		privateKey = createPrivateKey({
			key: Buffer.from(stored.privateKey, "base64url"),
			format: "der",
			type: "pkcs8",
		});
	} catch (error) {
		throw new Error(`Invalid backend identity file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	assertP256Key(privateKey);
	const publicKey = exportPublicKey(privateKey);
	return {
		backendId: deriveBackendId(publicKey),
		algorithm: "ES256",
		publicKey,
		privateKey,
		filePath,
	};
}

export function deriveBackendId(publicKey: string): string {
	const publicKeyBytes = decodePublicKey(publicKey);
	const key = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
	assertP256Key(key);
	return `${BACKEND_ID_PREFIX}${createHash("sha256").update(publicKeyBytes).digest("base64url")}`;
}

export function signBackendChallenge(identity: BackendIdentity, nonce: string): string {
	const signature = sign("sha256", Buffer.from(backendRegistrationPayload(nonce)), {
		key: identity.privateKey,
		dsaEncoding: "ieee-p1363",
	});
	return signature.toString("base64url");
}

export function verifyBackendChallenge(
	publicKey: string,
	nonce: string,
	signature: string,
): boolean {
	try {
		const key = createPublicKey({ key: decodePublicKey(publicKey), format: "der", type: "spki" });
		assertP256Key(key);
		return verify(
			"sha256",
			Buffer.from(backendRegistrationPayload(nonce)),
			{ key, dsaEncoding: "ieee-p1363" },
			Buffer.from(signature, "base64url"),
		);
	} catch {
		return false;
	}
}

function exportPublicKey(privateKey: KeyObject): string {
	const publicKey = createPublicKey(privateKey.export({ type: "pkcs8", format: "pem" }));
	assertP256Key(publicKey);
	return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url");
}

function decodePublicKey(publicKey: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) throw new Error("Invalid public key encoding");
	const bytes = Buffer.from(publicKey, "base64url");
	if (bytes.length === 0 || bytes.toString("base64url") !== publicKey) throw new Error("Invalid public key encoding");
	return bytes;
}

function assertP256Key(key: KeyObject): void {
	if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
		throw new Error("Backend identity must use a P-256 key");
	}
}

function isStoredBackendIdentity(value: unknown): value is StoredBackendIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === BACKEND_IDENTITY_VERSION
		&& record.algorithm === "ES256"
		&& typeof record.privateKey === "string"
		&& record.privateKey.length > 0;
}

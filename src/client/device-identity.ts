import {
	TRUST_PROTOCOL_VERSION,
	backendIdentityBindingPayload,
	deviceChallengePayload,
	deviceConnectionProofPayload,
	type BackendIdentityBinding,
	type DeviceChallenge,
} from "../shared/trust-protocol.js";

const DEVICE_DATABASE_VERSION = 1;
const DEVICE_STORE = "device-identities";
const DEVICE_RECORD_KEY = "default";

interface StoredBrowserDeviceIdentity {
	version: 1;
	privateKey: CryptoKey;
	publicKey: CryptoKey;
	publicKeySpki: string;
	deviceId: string;
}

export interface BrowserDeviceIdentity {
	deviceId: string;
	publicKey: string;
	privateKey: CryptoKey;
}

export async function loadBrowserDeviceIdentity(
	databaseName = "pipane-device-identity",
): Promise<BrowserDeviceIdentity | undefined> {
	const database = await openDatabase(databaseName);
	try {
		const stored = await readStoredIdentity(database);
		return stored ? await validateStoredIdentity(stored) : undefined;
	} finally {
		database.close();
	}
}

export async function loadOrCreateBrowserDeviceIdentity(
	databaseName = "pipane-device-identity",
): Promise<BrowserDeviceIdentity> {
	const database = await openDatabase(databaseName);
	try {
		const stored = await readStoredIdentity(database);
		if (stored) return validateStoredIdentity(stored);
		const generated = await generateBrowserDeviceIdentity();
		const publicKey = await crypto.subtle.importKey(
			"spki",
			decodeBase64Url(generated.publicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["verify"],
		);
		await writeStoredIdentity(database, {
			version: 1,
			privateKey: generated.privateKey,
			publicKey,
			publicKeySpki: generated.publicKey,
			deviceId: generated.deviceId,
		});
		return generated;
	} finally {
		database.close();
	}
}

export async function generateBrowserDeviceIdentity(): Promise<BrowserDeviceIdentity> {
	const keys = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	);
	if (keys.privateKey.extractable) throw new Error("Browser device private key must be non-exportable");
	const publicKeyBytes = await crypto.subtle.exportKey("spki", keys.publicKey);
	const publicKey = encodeBase64Url(publicKeyBytes);
	return {
		deviceId: `d_${encodeBase64Url(await crypto.subtle.digest("SHA-256", publicKeyBytes))}`,
		publicKey,
		privateKey: keys.privateKey,
	};
}

export async function signDeviceChallenge(identity: BrowserDeviceIdentity, challenge: DeviceChallenge): Promise<string> {
	if (challenge.deviceId !== identity.deviceId || challenge.devicePublicKey !== identity.publicKey) {
		throw new Error("Device challenge does not match this browser identity");
	}
	return signDevicePayload(identity.privateKey, deviceChallengePayload(challenge));
}

export async function signDeviceConnection(
	identity: BrowserDeviceIdentity,
	ticket: string,
	bindingSignature: string,
): Promise<string> {
	return signDevicePayload(identity.privateKey, deviceConnectionProofPayload(ticket, bindingSignature));
}

export async function verifyBrowserBackendBinding(
	binding: BackendIdentityBinding,
	expected: {
		backendId: string;
		connectionId: string;
		offerSdp: string;
		answerSdp: string;
		expiresAt: number;
		now?: number;
	},
): Promise<void> {
	const publicKeyBytes = decodeBase64Url(binding.publicKey);
	const backendId = `b_${encodeBase64Url(await crypto.subtle.digest("SHA-256", publicKeyBytes))}`;
	if (binding.version !== TRUST_PROTOCOL_VERSION
		|| backendId !== expected.backendId
		|| binding.backendId !== expected.backendId
		|| binding.connectionId !== expected.connectionId
		|| binding.offerSha256 !== await sha256(expected.offerSdp)
		|| binding.answerSha256 !== await sha256(expected.answerSdp)
		|| binding.dtlsFingerprint !== extractFingerprint(expected.answerSdp)
		|| binding.expiresAt !== expected.expiresAt
		|| binding.expiresAt <= (expected.now ?? Date.now())) {
		throw new Error("Backend identity binding does not match the negotiated connection");
	}
	const publicKey = await crypto.subtle.importKey(
		"spki",
		publicKeyBytes,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
	const { signature, ...unsigned } = binding;
	const valid = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		publicKey,
		decodeBase64Url(signature),
		new TextEncoder().encode(backendIdentityBindingPayload(unsigned)),
	);
	if (!valid) throw new Error("Backend identity binding signature is invalid");
}

async function validateStoredIdentity(stored: StoredBrowserDeviceIdentity): Promise<BrowserDeviceIdentity> {
	if (stored.version !== 1
		|| !(stored.privateKey instanceof CryptoKey)
		|| !(stored.publicKey instanceof CryptoKey)
		|| stored.privateKey.type !== "private"
		|| stored.privateKey.extractable
		|| stored.privateKey.algorithm.name !== "ECDSA"
		|| typeof stored.publicKeySpki !== "string"
		|| typeof stored.deviceId !== "string") {
		throw new Error("Stored browser device identity is malformed");
	}
	const publicKeyBytes = await crypto.subtle.exportKey("spki", stored.publicKey);
	if (encodeBase64Url(publicKeyBytes) !== stored.publicKeySpki) throw new Error("Stored browser device public key changed");
	const deviceId = `d_${encodeBase64Url(await crypto.subtle.digest("SHA-256", publicKeyBytes))}`;
	if (deviceId !== stored.deviceId) throw new Error("Stored browser device id is invalid");
	return { deviceId, publicKey: stored.publicKeySpki, privateKey: stored.privateKey };
}

async function signDevicePayload(privateKey: CryptoKey, payload: string): Promise<string> {
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		privateKey,
		new TextEncoder().encode(payload),
	);
	return encodeBase64Url(signature);
}

async function sha256(value: string): Promise<string> {
	return encodeBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function extractFingerprint(sdp: string): string {
	const match = /^a=fingerprint:(sha-(?:1|224|256|384|512)) ([A-Fa-f0-9:]+)\r?$/m.exec(sdp);
	if (!match) throw new Error("SDP answer is missing a DTLS certificate fingerprint");
	return `${match[1].toLowerCase()} ${match[2].toUpperCase()}`;
}

function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, DEVICE_DATABASE_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(DEVICE_STORE)) request.result.createObjectStore(DEVICE_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not open the browser device database"));
	});
}

function readStoredIdentity(database: IDBDatabase): Promise<StoredBrowserDeviceIdentity | undefined> {
	return new Promise((resolve, reject) => {
		const request = database.transaction(DEVICE_STORE, "readonly").objectStore(DEVICE_STORE).get(DEVICE_RECORD_KEY);
		request.onsuccess = () => resolve(request.result as StoredBrowserDeviceIdentity | undefined);
		request.onerror = () => reject(request.error ?? new Error("Could not read the browser device identity"));
	});
}

function writeStoredIdentity(database: IDBDatabase, identity: StoredBrowserDeviceIdentity): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(DEVICE_STORE, "readwrite");
		transaction.objectStore(DEVICE_STORE).put(identity, DEVICE_RECORD_KEY);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Could not store the browser device identity"));
	});
}

function encodeBase64Url(value: ArrayBuffer): string {
	const bytes = new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): ArrayBuffer {
	if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

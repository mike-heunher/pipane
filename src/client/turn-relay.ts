import type { IceServerConfiguration } from "../shared/trust-protocol.js";

const DATABASE_VERSION = 1;
const STORE_NAME = "turn-relay-settings";
const PROFILE_KEY = "default";
const DEFAULT_DATABASE_NAME = "pipane-turn-relay";
const DEFAULT_CREDENTIAL_TTL_SECONDS = 3_600;
const MAX_PROFILE_URLS = 8;

export type TurnRelayProfile = MeteredTurnRelayProfile | CoturnRestRelayProfile | StaticTurnRelayProfile;

export interface MeteredTurnRelayProfile {
	version: 1;
	kind: "metered";
	application: string;
	apiKey: string;
}

export interface CoturnRestRelayProfile {
	version: 1;
	kind: "coturn-rest";
	urls: string[];
	sharedSecret: string;
	ttlSeconds: number;
}

export interface StaticTurnRelayProfile {
	version: 1;
	kind: "static";
	iceServers: IceServerConfiguration[];
}

export interface TurnRelayTestResult {
	url?: string;
	protocol?: string;
	relayProtocol?: string;
}

export interface ResolveTurnRelayOptions {
	fetch?: typeof fetch;
	now?: () => number;
}

export interface TestTurnRelayOptions extends ResolveTurnRelayOptions {
	createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
	timeoutMs?: number;
}

export class TurnRelayConfigurationError extends Error {
	readonly code = "relay_configuration" as const;
	readonly turnRecommended = false;

	constructor(message: string) {
		super(message);
		this.name = "TurnRelayConfigurationError";
	}
}

export class TurnRelayStore {
	constructor(private readonly databaseName = DEFAULT_DATABASE_NAME) {}

	async load(): Promise<TurnRelayProfile | undefined> {
		if (typeof indexedDB === "undefined") return undefined;
		const database = await openDatabase(this.databaseName);
		try {
			const value = await readProfile(database);
			return value === undefined ? undefined : validateTurnRelayProfile(value);
		} finally {
			database.close();
		}
	}

	async save(profile: TurnRelayProfile): Promise<void> {
		const validated = validateTurnRelayProfile(profile);
		if (typeof indexedDB === "undefined") throw new TurnRelayConfigurationError("This browser cannot store TURN relay settings");
		const database = await openDatabase(this.databaseName);
		try {
			await writeProfile(database, validated);
		} finally {
			database.close();
		}
	}

	async clear(): Promise<void> {
		if (typeof indexedDB === "undefined") return;
		const database = await openDatabase(this.databaseName);
		try {
			await deleteProfile(database);
		} finally {
			database.close();
		}
	}
}

export const defaultTurnRelayStore = new TurnRelayStore();

export async function resolveStoredTurnRelayIceServers(
	subject: string,
	store: Pick<TurnRelayStore, "load"> = defaultTurnRelayStore,
	options: ResolveTurnRelayOptions = {},
): Promise<IceServerConfiguration[]> {
	const profile = await store.load();
	return profile ? resolveTurnRelayIceServers(profile, subject, options) : [];
}

export async function resolveTurnRelayIceServers(
	profile: TurnRelayProfile,
	subject: string,
	options: ResolveTurnRelayOptions = {},
): Promise<IceServerConfiguration[]> {
	const validated = validateTurnRelayProfile(profile);
	if (!subject) throw new TurnRelayConfigurationError("A browser device id is required for TURN credentials");
	if (validated.kind === "static") return cloneIceServers(validated.iceServers);
	if (validated.kind === "coturn-rest") {
		const expiresAt = Math.floor((options.now?.() ?? Date.now()) / 1_000) + validated.ttlSeconds;
		const username = `${expiresAt}:${subject}`;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(validated.sharedSecret),
			{ name: "HMAC", hash: "SHA-1" },
			false,
			["sign"],
		);
		const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
		return [{ urls: [...validated.urls], username, credential: encodeBase64(signature) }];
	}

	const request = options.fetch ?? globalThis.fetch;
	const endpoint = new URL(`https://${validated.application}.metered.live/api/v1/turn/credentials`);
	endpoint.searchParams.set("apiKey", validated.apiKey);
	let response: Response;
	try {
		response = await request(endpoint, {
			method: "GET",
			cache: "no-store",
			credentials: "omit",
			referrerPolicy: "no-referrer",
		});
	} catch {
		throw new TurnRelayConfigurationError("Could not reach Metered to request temporary TURN credentials");
	}
	if (!response.ok) {
		throw new TurnRelayConfigurationError(response.status === 401 || response.status === 403
			? "Metered rejected the TURN API key"
			: `Metered could not issue TURN credentials (HTTP ${response.status})`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new TurnRelayConfigurationError("Metered returned an invalid TURN credentials response");
	}
	const servers = isRecord(payload) && Array.isArray(payload.iceServers) ? payload.iceServers : payload;
	return validateIceServers(servers, true);
}

/** Verifies that this browser can allocate a relay candidate. The backend is exercised on reconnect. */
export async function testTurnRelayProfile(
	profile: TurnRelayProfile,
	subject: string,
	options: TestTurnRelayOptions = {},
): Promise<TurnRelayTestResult> {
	const iceServers = await resolveTurnRelayIceServers(profile, subject, options);
	const createPeer = options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration));
	const peer = createPeer({ iceServers, iceTransportPolicy: "relay" });
	const timeoutMs = options.timeoutMs ?? 10_000;
	try {
		peer.createDataChannel("pipane-turn-test", { ordered: true });
		const result = new Promise<TurnRelayTestResult>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				callback();
			};
			const timer = setTimeout(() => finish(() => reject(new TurnRelayConfigurationError(
				"No TURN relay candidate was received. Check the credentials, quota, and firewall ports.",
			))), timeoutMs);
			peer.onicecandidate = (event) => {
				const candidate = event.candidate;
				if (candidate?.type === "relay" || candidate?.candidate.includes(" typ relay ")) {
					const details = candidate as RTCIceCandidate & { url?: string; relayProtocol?: string };
					finish(() => resolve({
						url: details.url || undefined,
						protocol: details.protocol || undefined,
						relayProtocol: details.relayProtocol || undefined,
					}));
					return;
				}
				if (!candidate && peer.iceGatheringState === "complete") {
					finish(() => reject(new TurnRelayConfigurationError(
						"The TURN server did not provide a relay candidate. Check the credentials and supported transports.",
					)));
				}
			};
		});
		const offer = await peer.createOffer();
		await peer.setLocalDescription(offer);
		return await result;
	} finally {
		peer.close();
	}
}

export function validateTurnRelayProfile(value: unknown): TurnRelayProfile {
	if (!isRecord(value) || value.version !== 1) throw new TurnRelayConfigurationError("TURN relay settings are malformed");
	if (value.kind === "metered") {
		const application = normalizeMeteredApplication(value.application);
		if (typeof value.apiKey !== "string" || value.apiKey.trim().length === 0 || value.apiKey.length > 2_048) {
			throw new TurnRelayConfigurationError("A valid Metered TURN API key is required");
		}
		return { version: 1, kind: "metered", application, apiKey: value.apiKey.trim() };
	}
	if (value.kind === "coturn-rest") {
		const urls = validateTurnUrls(value.urls);
		if (typeof value.sharedSecret !== "string" || value.sharedSecret.length === 0 || value.sharedSecret.length > 1_024) {
			throw new TurnRelayConfigurationError("A valid coturn REST shared secret is required");
		}
		const ttlSeconds = value.ttlSeconds === undefined ? DEFAULT_CREDENTIAL_TTL_SECONDS : value.ttlSeconds;
		if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
			throw new TurnRelayConfigurationError("coturn credential lifetime must be between 60 and 86400 seconds");
		}
		return { version: 1, kind: "coturn-rest", urls, sharedSecret: value.sharedSecret, ttlSeconds };
	}
	if (value.kind === "static") {
		return { version: 1, kind: "static", iceServers: validateIceServers(value.iceServers, true) };
	}
	throw new TurnRelayConfigurationError("Choose a supported TURN relay provider");
}

export function parseTurnUrls(value: string): string[] {
	return validateTurnUrls(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean));
}

export function parseStaticIceServers(value: string): IceServerConfiguration[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TurnRelayConfigurationError("ICE server JSON is not valid JSON");
	}
	if (isRecord(parsed) && Array.isArray(parsed.iceServers)) parsed = parsed.iceServers;
	return validateIceServers(parsed, true);
}

function normalizeMeteredApplication(value: unknown): string {
	if (typeof value !== "string") throw new TurnRelayConfigurationError("A Metered application name is required");
	let application = value.trim().toLowerCase();
	application = application.replace(/^https?:\/\//u, "").replace(/\.metered\.live(?:\/.*)?$/u, "");
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(application)) {
		throw new TurnRelayConfigurationError("Enter the Metered application name, for example “my-app”");
	}
	return application;
}

function validateTurnUrls(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROFILE_URLS) {
		throw new TurnRelayConfigurationError("Add between one and eight TURN URLs");
	}
	const urls = [...new Set(value.map((item) => {
		if (typeof item !== "string" || !isTurnUrl(item)) throw new TurnRelayConfigurationError(`Unsupported TURN URL: ${String(item)}`);
		return item;
	}))];
	return urls;
}

function validateIceServers(value: unknown, requireTurn: boolean): IceServerConfiguration[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
		throw new TurnRelayConfigurationError("TURN credentials must contain between one and eight ICE server records");
	}
	let hasTurn = false;
	const result = value.map((entry) => {
		if (!isRecord(entry)) throw new TurnRelayConfigurationError("Every ICE server must be an object");
		const urls = typeof entry.urls === "string" ? [entry.urls] : entry.urls;
		if (!Array.isArray(urls) || urls.length === 0 || urls.length > 8 || !urls.every(isIceUrl)) {
			throw new TurnRelayConfigurationError("ICE server URLs contain an unsupported STUN or TURN URL");
		}
		const containsTurn = urls.some(isTurnUrl);
		hasTurn ||= containsTurn;
		if ((entry.username !== undefined && (typeof entry.username !== "string" || entry.username.length === 0 || entry.username.length > 512))
			|| (entry.credential !== undefined && (typeof entry.credential !== "string" || entry.credential.length === 0 || entry.credential.length > 1_024))) {
			throw new TurnRelayConfigurationError("TURN username or credential is invalid");
		}
		if (containsTurn && (typeof entry.username !== "string" || typeof entry.credential !== "string")) {
			throw new TurnRelayConfigurationError("TURN server records require a username and credential");
		}
		return {
			urls: typeof entry.urls === "string" ? entry.urls : [...urls],
			...(typeof entry.username === "string" ? { username: entry.username } : {}),
			...(typeof entry.credential === "string" ? { credential: entry.credential } : {}),
		};
	});
	if (requireTurn && !hasTurn) throw new TurnRelayConfigurationError("At least one turn: or turns: URL is required");
	return result;
}

function isIceUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || /\s/u.test(value)) return false;
	const match = /^(stun|turns?):(?:\/\/)?(\[[^\]]+\]|[^/?#:]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/iu.exec(value);
	if (!match) return false;
	if (!match[3]) return true;
	const port = Number.parseInt(match[3], 10);
	return port > 0 && port <= 65_535;
}

function isTurnUrl(value: unknown): value is string {
	return isIceUrl(value) && /^turns?:/iu.test(value);
}

function cloneIceServers(servers: IceServerConfiguration[]): IceServerConfiguration[] {
	return servers.map((server) => ({ ...server, urls: Array.isArray(server.urls) ? [...server.urls] : server.urls }));
}

function encodeBase64(value: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not open TURN relay settings"));
	});
}

function readProfile(database: IDBDatabase): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(PROFILE_KEY);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not read TURN relay settings"));
	});
}

function writeProfile(database: IDBDatabase, profile: TurnRelayProfile): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).put(profile, PROFILE_KEY);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Could not save TURN relay settings"));
	});
}

function deleteProfile(database: IDBDatabase): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).delete(PROFILE_KEY);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove TURN relay settings"));
	});
}

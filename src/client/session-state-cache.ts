import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { computeHash } from "../shared/jsonl-sync.js";
import { decodeSessionStateJson, type WireSessionState } from "../shared/ws-protocol.js";

const DATABASE_NAME = "pipane-session-state-cache-v1";
const DATABASE_VERSION = 1;
const MANIFEST_STORE = "manifests";
const SNAPSHOT_STORE = "snapshots";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 20;
const PREVIEW_RENDERABLE_MESSAGES = 50;
const MAX_PREVIEW_BYTES = 256 * 1024;

interface CacheManifest {
	key: string;
	backendId: string;
	sessionPath: string;
	hash: string;
	messageHashes: string[];
	previewJson?: string;
	previewHash?: string;
	byteSize: number;
	lastAccessedAt: number;
}

interface CacheSnapshot {
	key: string;
	json: string;
}

export interface CachedSessionState {
	json: string;
	hash: string;
	state: WireSessionState;
	messageHashes: string[];
	messageObjects: Map<string, AgentMessage>;
}

export interface CachedSessionPreview {
	hash: string;
	state: WireSessionState;
}

export interface SessionStateCache {
	loadPreview?(backendId: string, sessionPath: string): Promise<CachedSessionPreview | undefined>;
	load(backendId: string, sessionPath: string): Promise<CachedSessionState | undefined>;
	save(
		backendId: string,
		sessionPath: string,
		json: string,
		hash: string,
		messageHashes?: readonly string[],
	): Promise<void>;
	remove(backendId: string, sessionPath: string): Promise<void>;
}

export interface IndexedDbSessionStateCacheOptions {
	indexedDB?: IDBFactory;
	maxBytes?: number;
	maxSessions?: number;
}

function cacheKey(backendId: string, sessionPath: string): string {
	return `${backendId}\u0000${sessionPath}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
	});
}

async function hashMessages(messages: readonly AgentMessage[]): Promise<string[]> {
	const hashes: string[] = [];
	for (const message of messages) hashes.push(await computeHash(JSON.stringify(message)));
	return hashes;
}

async function createPreview(state: WireSessionState): Promise<{ json: string; hash: string; bytes: number } | undefined> {
	const starts: number[] = [];
	for (let index = state.messages.length - 1; index >= 0; index--) {
		if (state.messages[index].role !== "toolResult") starts.push(index);
		if (starts.length >= PREVIEW_RENDERABLE_MESSAGES) break;
	}
	if (starts.length === 0) starts.push(0);
	for (let count = starts.length; count > 0; count = Math.min(count - 1, Math.floor(count * 0.75))) {
		const start = starts[count - 1];
		const json = JSON.stringify({ ...state, messages: state.messages.slice(start) });
		const bytes = new TextEncoder().encode(json).byteLength;
		if (bytes <= MAX_PREVIEW_BYTES) return { json, hash: await computeHash(json), bytes };
	}
	return undefined;
}

export class IndexedDbSessionStateCache implements SessionStateCache {
	private readonly factory: IDBFactory;
	private readonly maxBytes: number;
	private readonly maxSessions: number;
	private database?: Promise<IDBDatabase>;

	constructor(options: IndexedDbSessionStateCacheOptions = {}) {
		const factory = options.indexedDB ?? globalThis.indexedDB;
		if (!factory) throw new Error("IndexedDB is unavailable");
		this.factory = factory;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
	}

	async loadPreview(backendId: string, sessionPath: string): Promise<CachedSessionPreview | undefined> {
		const db = await this.open();
		const key = cacheKey(backendId, sessionPath);
		const transaction = db.transaction(MANIFEST_STORE, "readonly");
		const manifest = await requestResult(transaction.objectStore(MANIFEST_STORE).get(key)) as CacheManifest | undefined;
		await transactionComplete(transaction);
		if (!manifest?.previewJson || !manifest.previewHash) return undefined;
		const decoded = decodeSessionStateJson(manifest.previewJson);
		const actualHash = decoded.ok ? await computeHash(manifest.previewJson) : undefined;
		if (!decoded.ok || actualHash !== manifest.previewHash) return undefined;
		void this.touch(key);
		return { hash: manifest.hash, state: decoded.value };
	}

	async load(backendId: string, sessionPath: string): Promise<CachedSessionState | undefined> {
		const db = await this.open();
		const key = cacheKey(backendId, sessionPath);
		const transaction = db.transaction([MANIFEST_STORE, SNAPSHOT_STORE], "readonly");
		const manifest = await requestResult(transaction.objectStore(MANIFEST_STORE).get(key)) as CacheManifest | undefined;
		const snapshot = await requestResult(transaction.objectStore(SNAPSHOT_STORE).get(key)) as CacheSnapshot | undefined;
		await transactionComplete(transaction);
		if (!manifest || !snapshot) {
			if (manifest || snapshot) await this.remove(backendId, sessionPath);
			return undefined;
		}

		const decoded = decodeSessionStateJson(snapshot.json);
		const actualHash = decoded.ok ? await computeHash(snapshot.json) : undefined;
		if (!decoded.ok || actualHash !== manifest.hash || decoded.value.messages.length !== manifest.messageHashes.length) {
			await this.remove(backendId, sessionPath);
			return undefined;
		}
		const messageObjects = new Map<string, AgentMessage>();
		for (let index = 0; index < manifest.messageHashes.length; index++) {
			messageObjects.set(manifest.messageHashes[index], decoded.value.messages[index]);
		}
		if (!manifest.previewJson) void this.backfillPreview(key, manifest.hash, decoded.value);
		void this.touch(key);
		return {
			json: snapshot.json,
			hash: manifest.hash,
			state: decoded.value,
			messageHashes: manifest.messageHashes,
			messageObjects,
		};
	}

	async save(
		backendId: string,
		sessionPath: string,
		json: string,
		hash: string,
		messageHashes?: readonly string[],
	): Promise<void> {
		const decoded = decodeSessionStateJson(json);
		if (!decoded.ok) return;
		const hashes = messageHashes?.length === decoded.value.messages.length
			? [...messageHashes]
			: await hashMessages(decoded.value.messages);
		const key = cacheKey(backendId, sessionPath);
		const preview = await createPreview(decoded.value);
		const manifest: CacheManifest = {
			key,
			backendId,
			sessionPath,
			hash,
			messageHashes: hashes,
			...(preview ? { previewJson: preview.json, previewHash: preview.hash } : {}),
			byteSize: new TextEncoder().encode(json).byteLength + (preview?.bytes ?? 0),
			lastAccessedAt: Date.now(),
		};
		const db = await this.open();
		const transaction = db.transaction([MANIFEST_STORE, SNAPSHOT_STORE], "readwrite");
		transaction.objectStore(MANIFEST_STORE).put(manifest);
		transaction.objectStore(SNAPSHOT_STORE).put({ key, json } satisfies CacheSnapshot);
		await transactionComplete(transaction);
		await this.prune();
	}

	async remove(backendId: string, sessionPath: string): Promise<void> {
		const db = await this.open();
		const key = cacheKey(backendId, sessionPath);
		const transaction = db.transaction([MANIFEST_STORE, SNAPSHOT_STORE], "readwrite");
		transaction.objectStore(MANIFEST_STORE).delete(key);
		transaction.objectStore(SNAPSHOT_STORE).delete(key);
		await transactionComplete(transaction);
	}

	private open(): Promise<IDBDatabase> {
		this.database ??= new Promise((resolve, reject) => {
			const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(MANIFEST_STORE)) db.createObjectStore(MANIFEST_STORE, { keyPath: "key" });
				if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("Could not open the session cache"));
		});
		return this.database;
	}

	private async backfillPreview(key: string, snapshotHash: string, state: WireSessionState): Promise<void> {
		try {
			const preview = await createPreview(state);
			if (!preview) return;
			const db = await this.open();
			const transaction = db.transaction(MANIFEST_STORE, "readwrite");
			const store = transaction.objectStore(MANIFEST_STORE);
			const current = await requestResult(store.get(key)) as CacheManifest | undefined;
			if (current?.hash === snapshotHash && !current.previewJson) {
				store.put({
					...current,
					previewJson: preview.json,
					previewHash: preview.hash,
					byteSize: current.byteSize + preview.bytes,
				});
			}
			await transactionComplete(transaction);
			await this.prune();
		} catch {
			// Lazy preview migration is optional; the complete snapshot remains valid.
		}
	}

	private async touch(key: string): Promise<void> {
		try {
			const db = await this.open();
			const transaction = db.transaction(MANIFEST_STORE, "readwrite");
			const store = transaction.objectStore(MANIFEST_STORE);
			const manifest = await requestResult(store.get(key)) as CacheManifest | undefined;
			if (manifest) store.put({ ...manifest, lastAccessedAt: Date.now() });
			await transactionComplete(transaction);
		} catch {
			// Cache recency is best-effort and must never affect session loading.
		}
	}

	private async prune(): Promise<void> {
		const db = await this.open();
		const read = db.transaction(MANIFEST_STORE, "readonly");
		const manifests = await requestResult(read.objectStore(MANIFEST_STORE).getAll()) as CacheManifest[];
		await transactionComplete(read);
		manifests.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
		let retainedBytes = 0;
		const evicted: CacheManifest[] = [];
		for (let index = 0; index < manifests.length; index++) {
			const manifest = manifests[index];
			if (index < this.maxSessions && retainedBytes + manifest.byteSize <= this.maxBytes) {
				retainedBytes += manifest.byteSize;
			} else {
				evicted.push(manifest);
			}
		}
		if (evicted.length === 0) return;
		const write = db.transaction([MANIFEST_STORE, SNAPSHOT_STORE], "readwrite");
		for (const manifest of evicted) {
			write.objectStore(MANIFEST_STORE).delete(manifest.key);
			write.objectStore(SNAPSHOT_STORE).delete(manifest.key);
		}
		await transactionComplete(write);
	}
}

export function createBrowserSessionStateCache(): SessionStateCache | undefined {
	try {
		return typeof globalThis.indexedDB === "undefined" ? undefined : new IndexedDbSessionStateCache();
	} catch {
		return undefined;
	}
}

const DATABASE_VERSION = 1;
const STORE_NAME = "session-sync";
const UPDATED_INDEX = "updatedAt";
const DEFAULT_DATABASE_NAME = "pipane-session-sync-cache-v1";
const DEFAULT_WRITE_DELAY_MS = 1_500;
const MAX_PERSISTED_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PERSISTED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PERSISTED_RECORDS = 20;

export interface SessionSyncCacheRecord {
	json: string;
	hash: string;
	revision: number;
	updatedAt: number;
}

export interface SessionSyncCache {
	get(sessionPath: string): Promise<SessionSyncCacheRecord | undefined>;
	set(sessionPath: string, record: SessionSyncCacheRecord): void;
	delete(sessionPath: string): void;
}

interface StoredSessionSyncCacheRecord extends SessionSyncCacheRecord {
	key: string;
	scope: string;
	sessionPath: string;
	byteLength: number;
}

export class MemorySessionSyncCache implements SessionSyncCache {
	private readonly records = new Map<string, SessionSyncCacheRecord>();

	async get(sessionPath: string): Promise<SessionSyncCacheRecord | undefined> {
		const record = this.records.get(sessionPath);
		return record ? { ...record } : undefined;
	}

	set(sessionPath: string, record: SessionSyncCacheRecord): void {
		this.records.set(sessionPath, { ...record });
	}

	delete(sessionPath: string): void {
		this.records.delete(sessionPath);
	}
}

export interface BrowserSessionSyncCacheOptions {
	databaseName?: string;
	writeDelayMs?: number;
}

/**
 * Per-backend conversation baselines. Memory handles ordinary reconnects and
 * session switches; bounded IndexedDB persistence survives reloads without
 * writing every streaming token to disk.
 */
export class BrowserSessionSyncCache implements SessionSyncCache {
	private readonly memory = new Map<string, SessionSyncCacheRecord>();
	private readonly pending = new Map<string, StoredSessionSyncCacheRecord>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly databaseName: string;
	private readonly writeDelayMs: number;

	constructor(
		private readonly scope: string,
		options: BrowserSessionSyncCacheOptions = {},
	) {
		this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
		this.writeDelayMs = options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS;
	}

	async get(sessionPath: string): Promise<SessionSyncCacheRecord | undefined> {
		const memory = this.memory.get(sessionPath);
		if (memory) return { ...memory };
		if (!hasIndexedDb()) return undefined;
		try {
			const database = await openDatabase(this.databaseName);
			try {
				const stored = await readRecord(database, this.key(sessionPath));
				if (!isStoredRecord(stored, this.scope, sessionPath)) return undefined;
				const record = toPublicRecord(stored);
				this.memory.set(sessionPath, record);
				return { ...record };
			} finally {
				database.close();
			}
		} catch {
			return undefined;
		}
	}

	set(sessionPath: string, record: SessionSyncCacheRecord): void {
		const copy = { ...record };
		this.memory.set(sessionPath, copy);
		if (!hasIndexedDb()) return;
		const stored: StoredSessionSyncCacheRecord = {
			...copy,
			key: this.key(sessionPath),
			scope: this.scope,
			sessionPath,
			byteLength: new TextEncoder().encode(copy.json).byteLength,
		};
		this.pending.set(sessionPath, stored);
		const previous = this.timers.get(sessionPath);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			this.timers.delete(sessionPath);
			void this.flush(sessionPath);
		}, this.writeDelayMs);
		(timer as any).unref?.();
		this.timers.set(sessionPath, timer);
	}

	delete(sessionPath: string): void {
		this.memory.delete(sessionPath);
		this.pending.delete(sessionPath);
		const timer = this.timers.get(sessionPath);
		if (timer) clearTimeout(timer);
		this.timers.delete(sessionPath);
		if (!hasIndexedDb()) return;
		void (async () => {
			try {
				const database = await openDatabase(this.databaseName);
				try {
					await deleteRecord(database, this.key(sessionPath));
				} finally {
					database.close();
				}
			} catch {
				// A cache failure must never affect the authoritative session stream.
			}
		})();
	}

	/** Flush pending writes; public for deterministic persistence tests. */
	async flush(sessionPath?: string): Promise<void> {
		const paths = sessionPath ? [sessionPath] : [...this.pending.keys()];
		for (const path of paths) {
			const stored = this.pending.get(path);
			if (!stored) continue;
			this.pending.delete(path);
			try {
				const database = await openDatabase(this.databaseName);
				try {
					if (stored.byteLength <= MAX_PERSISTED_RECORD_BYTES) await writeRecord(database, stored);
					else await deleteRecord(database, stored.key);
					await trimDatabase(database);
				} finally {
					database.close();
				}
			} catch {
				// Memory remains useful if persistence is unavailable or over quota.
			}
		}
	}

	private key(sessionPath: string): string {
		return `${this.scope}\u0000${sessionPath}`;
	}
}

function hasIndexedDb(): boolean {
	return typeof indexedDB !== "undefined";
}

function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const store = request.result.objectStoreNames.contains(STORE_NAME)
				? request.transaction!.objectStore(STORE_NAME)
				: request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
			if (!store.indexNames.contains(UPDATED_INDEX)) store.createIndex(UPDATED_INDEX, UPDATED_INDEX);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not open the session cache"));
	});
}

function readRecord(database: IDBDatabase, key: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not read the session cache"));
	});
}

function writeRecord(database: IDBDatabase, record: StoredSessionSyncCacheRecord): Promise<void> {
	return transactionPromise(database, (store) => store.put(record));
}

function deleteRecord(database: IDBDatabase, key: string): Promise<void> {
	return transactionPromise(database, (store) => store.delete(key));
}

function transactionPromise(
	database: IDBDatabase,
	mutate: (store: IDBObjectStore) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, "readwrite");
		mutate(transaction.objectStore(STORE_NAME));
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Could not update the session cache"));
	});
}

function trimDatabase(database: IDBDatabase): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, "readwrite");
		const store = transaction.objectStore(STORE_NAME);
		const request = store.index(UPDATED_INDEX).openCursor(null, "prev");
		let records = 0;
		let bytes = 0;
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			const value = cursor.value as Partial<StoredSessionSyncCacheRecord>;
			records++;
			bytes += typeof value.byteLength === "number" ? value.byteLength : MAX_PERSISTED_RECORD_BYTES;
			if (records > MAX_PERSISTED_RECORDS || bytes > MAX_PERSISTED_TOTAL_BYTES) cursor.delete();
			cursor.continue();
		};
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Could not trim the session cache"));
	});
}

function isStoredRecord(
	value: unknown,
	scope: string,
	sessionPath: string,
): value is StoredSessionSyncCacheRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<StoredSessionSyncCacheRecord>;
	return record.scope === scope
		&& record.sessionPath === sessionPath
		&& typeof record.json === "string"
		&& typeof record.hash === "string"
		&& /^[a-f0-9]{64}$/u.test(record.hash)
		&& Number.isSafeInteger(record.revision)
		&& (record.revision as number) >= 0
		&& typeof record.updatedAt === "number";
}

function toPublicRecord(record: StoredSessionSyncCacheRecord): SessionSyncCacheRecord {
	return {
		json: record.json,
		hash: record.hash,
		revision: record.revision,
		updatedAt: record.updatedAt,
	};
}

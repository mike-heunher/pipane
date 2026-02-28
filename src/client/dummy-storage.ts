/**
 * Dummy StorageBackend for server-managed mode.
 *
 * The provider-keys store always returns a placeholder key
 * so AgentInterface's API key check passes (actual keys are server-side).
 * All other stores behave as empty in-memory stores.
 */

import type { StorageBackend, StorageTransaction } from "@mariozechner/pi-web-ui";

export class DummyStorageBackend implements StorageBackend {
	private data = new Map<string, Map<string, any>>();

	private getStore(name: string): Map<string, any> {
		if (!this.data.has(name)) {
			this.data.set(name, new Map());
		}
		return this.data.get(name)!;
	}

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		// Always return a dummy key for provider-keys so the API key check passes
		if (storeName === "provider-keys") {
			return "server-managed" as T;
		}
		return this.getStore(storeName).get(key) ?? null;
	}

	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		this.getStore(storeName).set(key, value);
	}

	async delete(storeName: string, key: string): Promise<void> {
		this.getStore(storeName).delete(key);
	}

	async keys(storeName: string, prefix?: string): Promise<string[]> {
		const store = this.getStore(storeName);
		const allKeys = Array.from(store.keys());
		if (prefix) return allKeys.filter((k) => k.startsWith(prefix));
		return allKeys;
	}

	async getAllFromIndex<T = unknown>(_storeName: string, _indexName: string, _direction?: "asc" | "desc"): Promise<T[]> {
		return [];
	}

	async clear(storeName: string): Promise<void> {
		this.getStore(storeName).clear();
	}

	async has(storeName: string, key: string): Promise<boolean> {
		if (storeName === "provider-keys") return true;
		return this.getStore(storeName).has(key);
	}

	async transaction<T>(
		_storeNames: string[],
		_mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T> {
		const self = this;
		const tx: StorageTransaction = {
			get: (s, k) => self.get(s, k),
			set: (s, k, v) => self.set(s, k, v),
			delete: (s, k) => self.delete(s, k),
		};
		return operation(tx);
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return { usage: 0, quota: Infinity, percent: 0 };
	}

	async requestPersistence(): Promise<boolean> {
		return true;
	}
}

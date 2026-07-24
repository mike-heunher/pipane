import {
	computeSyncOp,
	type DeltaSync,
	type Patch,
	type SyncOp,
} from "../shared/jsonl-sync.js";

const MAX_TRANSITIONS_PER_SESSION = 4_096;
const MAX_TRANSITION_BYTES_PER_SESSION = 8 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 96 * 1024 * 1024;

interface Transition {
	baseHash: string;
	hash: string;
	patches: Patch[];
	byteLength: number;
}

interface JournalEntry {
	revision: number;
	hash: string;
	json: string;
	jsonBytes: number;
	transitions: Transition[];
	transitionBytes: number;
}

export interface SessionSyncPlan {
	revision: number;
	op: SyncOp;
	resumed: boolean;
}

/**
 * Bounded server-side patch journal. It lets a browser prove a cached SHA-256
 * baseline after reconnect or a session switch and receive only the intervening
 * patches. A missing/evicted chain safely falls back to a full snapshot.
 */
export class SessionSyncJournal {
	private readonly entries = new Map<string, JournalEntry>();
	private totalBytes = 0;

	record(sessionPath: string, json: string, hash: string, protectedPaths: ReadonlySet<string> = new Set()): number {
		const current = this.entries.get(sessionPath);
		if (current?.hash === hash) {
			this.touch(sessionPath, current);
			return current.revision;
		}

		const jsonBytes = Buffer.byteLength(json);
		if (!current) {
			const created: JournalEntry = {
				revision: 1,
				hash,
				json,
				jsonBytes,
				transitions: [],
				transitionBytes: 0,
			};
			this.entries.set(sessionPath, created);
			this.totalBytes += jsonBytes;
			this.trim(protectedPaths);
			return created.revision;
		}

		const revision = current.revision + 1;
		const operation = computeSyncOp(current.json, json, current.hash, hash);
		this.totalBytes -= current.jsonBytes + current.transitionBytes;
		if (operation.op === "delta") {
			const byteLength = Buffer.byteLength(JSON.stringify(operation.patches));
			current.transitions.push({
				baseHash: current.hash,
				hash,
				patches: operation.patches,
				byteLength,
			});
			current.transitionBytes += byteLength;
			while (current.transitions.length > MAX_TRANSITIONS_PER_SESSION
				|| current.transitionBytes > MAX_TRANSITION_BYTES_PER_SESSION) {
				const removed = current.transitions.shift();
				if (!removed) break;
				current.transitionBytes -= removed.byteLength;
			}
		} else {
			// A compaction or wholesale rewrite cannot be bridged economically.
			current.transitions = [];
			current.transitionBytes = 0;
		}
		current.revision = revision;
		current.hash = hash;
		current.json = json;
		current.jsonBytes = jsonBytes;
		this.totalBytes += current.jsonBytes + current.transitionBytes;
		this.touch(sessionPath, current);
		this.trim(protectedPaths);
		return revision;
	}

	plan(sessionPath: string, baseHash?: string): SessionSyncPlan {
		const entry = this.entries.get(sessionPath);
		if (!entry) throw new Error("Session sync state has not been recorded");
		this.touch(sessionPath, entry);
		if (!baseHash) return this.full(entry);
		if (baseHash === entry.hash) {
			return {
				revision: entry.revision,
				op: { op: "delta", patches: [], baseHash, hash: entry.hash },
				resumed: true,
			};
		}

		const start = entry.transitions.findIndex((transition) => transition.baseHash === baseHash);
		if (start < 0) return this.full(entry);
		const patches: Patch[] = [];
		let expectedHash = baseHash;
		for (const transition of entry.transitions.slice(start)) {
			if (transition.baseHash !== expectedHash) return this.full(entry);
			patches.push(...transition.patches);
			expectedHash = transition.hash;
		}
		if (expectedHash !== entry.hash) return this.full(entry);

		const delta: DeltaSync = { op: "delta", patches, baseHash, hash: entry.hash };
		if (Buffer.byteLength(JSON.stringify(delta)) > entry.jsonBytes * 0.8) return this.full(entry);
		return { revision: entry.revision, op: delta, resumed: true };
	}

	private full(entry: JournalEntry): SessionSyncPlan {
		return {
			revision: entry.revision,
			op: { op: "full", data: entry.json, hash: entry.hash },
			resumed: false,
		};
	}

	private touch(sessionPath: string, entry: JournalEntry): void {
		this.entries.delete(sessionPath);
		this.entries.set(sessionPath, entry);
	}

	private trim(protectedPaths: ReadonlySet<string>): void {
		if (this.totalBytes <= MAX_JOURNAL_BYTES) return;
		for (const [sessionPath, entry] of this.entries) {
			if (protectedPaths.has(sessionPath)) continue;
			this.entries.delete(sessionPath);
			this.totalBytes -= entry.jsonBytes + entry.transitionBytes;
			if (this.totalBytes <= MAX_JOURNAL_BYTES) break;
		}
	}
}

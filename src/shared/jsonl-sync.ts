/**
 * JSONL sync protocol: hash-verified text diffs.
 *
 * The server maintains a canonical JSON string representing the full session state.
 * It sends diffs (patches) to the client, which applies them and verifies integrity
 * via SHA-256 hashes.
 *
 * Patch format: array of operations that transform the old string into the new one.
 * Each operation is { offset, deleteCount, insert } applied sequentially.
 *
 * This module is isomorphic — works in both Node.js and browser.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface Patch {
	/** Byte offset in the current (already-patched) string where this op applies */
	offset: number;
	/** Number of characters to delete at offset */
	deleteCount: number;
	/** String to insert at offset (after deletion) */
	insert: string;
}

export interface FullSync {
	op: "full";
	data: string;
	hash: string;
}

export interface DeltaSync {
	op: "delta";
	patches: Patch[];
	/** Hash of the resulting string after patches are applied */
	hash: string;
	/** Hash of the string the patches should be applied to */
	baseHash: string;
}

export type SyncOp = FullSync | DeltaSync;

// ── Hashing ────────────────────────────────────────────────────────────────

/**
 * Compute a hex SHA-256 hash of a string.
 * Works in both Node.js (crypto) and browser (SubtleCrypto).
 */
export async function computeHash(data: string): Promise<string> {
	if (typeof globalThis.crypto?.subtle?.digest === "function") {
		// Browser or Node 20+
		const encoded = new TextEncoder().encode(data);
		const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
		const hashArray = new Uint8Array(hashBuffer);
		return Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
	}
	// Node.js fallback
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(data, "utf8").digest("hex");
}

// Note: computeHashSync is NOT in this shared module because it depends on
// node:crypto which is stubbed in the client Vite build. It lives in
// session-jsonl.ts (server-only).

// ── Diffing ────────────────────────────────────────────────────────────────

/**
 * Compute patches to transform `oldStr` into `newStr`.
 *
 * Uses a simple but effective approach:
 * 1. Find common prefix
 * 2. Find common suffix (after prefix)
 * 3. The middle part is a single replace operation
 *
 * This is O(n) and produces at most one patch, which is ideal for our use case
 * where changes are typically appended (streaming) or localized (tool updates).
 *
 * For cases where the strings are identical, returns an empty array.
 */
export function computePatches(oldStr: string, newStr: string): Patch[] {
	if (oldStr === newStr) return [];

	// Find common prefix length
	const minLen = Math.min(oldStr.length, newStr.length);
	let prefixLen = 0;
	while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
		prefixLen++;
	}

	// Find common suffix length (don't overlap with prefix)
	let suffixLen = 0;
	const maxSuffix = minLen - prefixLen;
	while (
		suffixLen < maxSuffix &&
		oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	const deleteCount = oldStr.length - prefixLen - suffixLen;
	const insert = newStr.slice(prefixLen, newStr.length - suffixLen);

	// If nothing to delete and nothing to insert, strings must be equal (shouldn't happen)
	if (deleteCount === 0 && insert.length === 0) return [];

	return [{ offset: prefixLen, deleteCount, insert }];
}

// ── Patching ───────────────────────────────────────────────────────────────

/**
 * Apply patches to a string.
 * Patches are applied sequentially (each operates on the result of the previous).
 */
export function applyPatches(str: string, patches: Patch[]): string {
	let result = str;
	for (const patch of patches) {
		result =
			result.slice(0, patch.offset) +
			patch.insert +
			result.slice(patch.offset + patch.deleteCount);
	}
	return result;
}

// ── Sync helpers ───────────────────────────────────────────────────────────

/**
 * Server-side: compute a SyncOp to send to the client.
 *
 * If the client's baseHash doesn't match (or is empty), sends a full sync.
 * Otherwise computes patches.
 *
 * @param oldStr - The previous string the client has (empty if first sync)
 * @param newStr - The new string to sync to
 * @param oldHash - Hash of oldStr (client's current hash)
 * @param newHash - Pre-computed hash of newStr
 * @returns The sync operation to send
 */
export function computeSyncOp(
	oldStr: string,
	newStr: string,
	oldHash: string,
	newHash: string,
): SyncOp {
	if (!oldHash || oldStr.length === 0) {
		return { op: "full", data: newStr, hash: newHash };
	}

	const patches = computePatches(oldStr, newStr);

	// If the delta is larger than 80% of the full string, just send full
	const deltaSize = patches.reduce((sum, p) => sum + p.insert.length + 20, 0);
	if (deltaSize > newStr.length * 0.8) {
		return { op: "full", data: newStr, hash: newHash };
	}

	return { op: "delta", patches, hash: newHash, baseHash: oldHash };
}

/**
 * Client-side: apply a SyncOp to the current state.
 *
 * Returns the new string and hash, or null if verification failed
 * (caller should request a full sync).
 */
export async function applySyncOp(
	currentStr: string,
	currentHash: string,
	op: SyncOp,
): Promise<{ data: string; hash: string } | null> {
	if (op.op === "full") {
		// Verify the full data matches the declared hash
		const actualHash = await computeHash(op.data);
		if (actualHash !== op.hash) {
			console.error("[jsonl-sync] Full sync hash mismatch", { expected: op.hash, actual: actualHash });
			return null;
		}
		return { data: op.data, hash: op.hash };
	}

	// Delta sync
	if (op.baseHash !== currentHash) {
		console.warn("[jsonl-sync] Base hash mismatch, need full sync", {
			expected: op.baseHash,
			actual: currentHash,
		});
		return null;
	}

	const newStr = applyPatches(currentStr, op.patches);
	const actualHash = await computeHash(newStr);
	if (actualHash !== op.hash) {
		console.error("[jsonl-sync] Post-patch hash mismatch", { expected: op.hash, actual: actualHash });
		return null;
	}

	return { data: newStr, hash: op.hash };
}

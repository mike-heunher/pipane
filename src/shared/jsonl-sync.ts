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
 * Pure JS SHA-256 for environments without SubtleCrypto (HTTP browser contexts).
 */
function sha256js(str: string): string {
	const K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	const rr = (v: number, n: number) => (v >>> n) | (v << (32 - n));

	// UTF-8 encode
	const bytes = new TextEncoder().encode(str);
	const bitLen = bytes.length * 8;

	// Padding
	const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 4, bitLen, false);
	if (bitLen > 0xffffffff) dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

	let [h0, h1, h2, h3, h4, h5, h6, h7] = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	];

	const w = new Int32Array(64);
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
		for (let i = 0; i < 64; i++) {
			const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
			const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) | 0;
			h = g; g = f; f = e; e = (d + t1) | 0;
			d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
	}

	return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * Compute a hex SHA-256 hash of a string.
 * Works in both Node.js (crypto) and browser (SubtleCrypto).
 */
export async function computeHash(data: string): Promise<string> {
	if (typeof globalThis.crypto?.subtle?.digest === "function") {
		// Browser or Node 20+ (requires secure context in browsers)
		const encoded = new TextEncoder().encode(data);
		const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
		const hashArray = new Uint8Array(hashBuffer);
		return Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
	}
	// Node.js fallback
	if (typeof globalThis.process !== "undefined") {
		const { createHash } = await import("node:crypto");
		return createHash("sha256").update(data, "utf8").digest("hex");
	}
	// Browser insecure context fallback (no SubtleCrypto) — pure JS SHA-256
	return sha256js(data);
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

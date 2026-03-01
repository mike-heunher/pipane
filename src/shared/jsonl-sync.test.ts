/**
 * Tests for the JSONL sync protocol: hash-verified text diffs.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
	computePatches,
	applyPatches,
	computeHash,
	computeSyncOp,
	applySyncOp,
	type Patch,
} from "./jsonl-sync.js";

/** Synchronous SHA-256 hash for tests (uses node:crypto directly). */
function computeHashSync(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

// ── computePatches ─────────────────────────────────────────────────────────

describe("computePatches", () => {
	it("returns empty array for identical strings", () => {
		expect(computePatches("hello", "hello")).toEqual([]);
	});

	it("handles append (common case for streaming)", () => {
		const patches = computePatches("hello", "hello world");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 5, deleteCount: 0, insert: " world" });
	});

	it("handles prepend", () => {
		const patches = computePatches("world", "hello world");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 0, deleteCount: 0, insert: "hello " });
	});

	it("handles complete replacement", () => {
		const patches = computePatches("abc", "xyz");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 0, deleteCount: 3, insert: "xyz" });
	});

	it("handles middle change", () => {
		const patches = computePatches("hello world!", "hello there!");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 6, deleteCount: 5, insert: "there" });
	});

	it("handles deletion", () => {
		const patches = computePatches("hello world", "hello");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 5, deleteCount: 6, insert: "" });
	});

	it("handles empty to non-empty", () => {
		const patches = computePatches("", "hello");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 0, deleteCount: 0, insert: "hello" });
	});

	it("handles non-empty to empty", () => {
		const patches = computePatches("hello", "");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 0, deleteCount: 5, insert: "" });
	});

	it("handles single character change", () => {
		const patches = computePatches("cat", "bat");
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({ offset: 0, deleteCount: 1, insert: "b" });
	});

	it("handles JSONL append (realistic streaming case)", () => {
		const old = '{"role":"user","content":"hi"}\n';
		const added = '{"role":"assistant","content":"hello"}\n';
		const patches = computePatches(old, old + added);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toEqual({
			offset: old.length,
			deleteCount: 0,
			insert: added,
		});
	});

	it("handles JSONL line replacement (tool partial update)", () => {
		const line1 = '{"role":"user","content":"hi"}\n';
		const oldLine2 = '{"role":"toolResult","partial":true,"content":"output so"}\n';
		const newLine2 = '{"role":"toolResult","partial":true,"content":"output so far..."}\n';
		const old = line1 + oldLine2;
		const newStr = line1 + newLine2;
		const patches = computePatches(old, newStr);
		expect(patches).toHaveLength(1);
		// Apply and verify
		expect(applyPatches(old, patches)).toBe(newStr);
	});

	it("handles unicode content", () => {
		const old = '{"text":"hello 🌍"}\n';
		const newStr = '{"text":"hello 🌍🎉"}\n';
		const patches = computePatches(old, newStr);
		expect(applyPatches(old, patches)).toBe(newStr);
	});

	it("handles large strings efficiently", () => {
		const base = "x".repeat(100000);
		const newStr = base + "appended";
		const patches = computePatches(base, newStr);
		expect(patches).toHaveLength(1);
		expect(patches[0].offset).toBe(100000);
		expect(patches[0].deleteCount).toBe(0);
		expect(patches[0].insert).toBe("appended");
	});
});

// ── applyPatches ───────────────────────────────────────────────────────────

describe("applyPatches", () => {
	it("returns original string for empty patches", () => {
		expect(applyPatches("hello", [])).toBe("hello");
	});

	it("applies a single insert patch", () => {
		const result = applyPatches("hello", [{ offset: 5, deleteCount: 0, insert: " world" }]);
		expect(result).toBe("hello world");
	});

	it("applies a single delete patch", () => {
		const result = applyPatches("hello world", [{ offset: 5, deleteCount: 6, insert: "" }]);
		expect(result).toBe("hello");
	});

	it("applies a single replace patch", () => {
		const result = applyPatches("hello world!", [{ offset: 6, deleteCount: 5, insert: "there" }]);
		expect(result).toBe("hello there!");
	});

	it("applies multiple sequential patches", () => {
		// First: insert " wonderful" at offset 5
		// After first: "hello wonderful world"
		// Second: replace "world" (at offset 16 in the new string) with "day"
		const result = applyPatches("hello world", [
			{ offset: 5, deleteCount: 0, insert: " wonderful" },
			{ offset: 16, deleteCount: 5, insert: "day" },
		]);
		expect(result).toBe("hello wonderful day");
	});

	it("handles patch at start of string", () => {
		const result = applyPatches("world", [{ offset: 0, deleteCount: 0, insert: "hello " }]);
		expect(result).toBe("hello world");
	});

	it("handles patch replacing entire string", () => {
		const result = applyPatches("old", [{ offset: 0, deleteCount: 3, insert: "new" }]);
		expect(result).toBe("new");
	});

	it("roundtrips with computePatches", () => {
		const testCases = [
			["", "hello"],
			["hello", ""],
			["hello", "hello world"],
			["hello world", "hello"],
			["aaa bbb ccc", "aaa xxx ccc"],
			['{"a":1}\n', '{"a":1}\n{"b":2}\n'],
			['{"a":1}\n{"b":"old"}\n', '{"a":1}\n{"b":"new"}\n'],
		];

		for (const [old, newStr] of testCases) {
			const patches = computePatches(old, newStr);
			const result = applyPatches(old, patches);
			expect(result).toBe(newStr);
		}
	});
});

// ── computeHash ────────────────────────────────────────────────────────────

describe("computeHash", () => {
	it("produces consistent hashes", async () => {
		const h1 = await computeHash("hello");
		const h2 = await computeHash("hello");
		expect(h1).toBe(h2);
	});

	it("produces different hashes for different inputs", async () => {
		const h1 = await computeHash("hello");
		const h2 = await computeHash("world");
		expect(h1).not.toBe(h2);
	});

	it("produces a 64-character hex string", async () => {
		const hash = await computeHash("test");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("handles empty string", async () => {
		const hash = await computeHash("");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("handles unicode", async () => {
		const hash = await computeHash("hello 🌍");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("computeHashSync", () => {
	it("matches async hash", async () => {
		const syncHash = computeHashSync("hello");
		const asyncHash = await computeHash("hello");
		expect(syncHash).toBe(asyncHash);
	});

	it("handles empty string", () => {
		const hash = computeHashSync("");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

// ── computeSyncOp ──────────────────────────────────────────────────────────

describe("computeSyncOp", () => {
	it("returns full sync when oldHash is empty", () => {
		const op = computeSyncOp("", "hello", "", "hash_of_hello");
		expect(op.op).toBe("full");
		if (op.op === "full") {
			expect(op.data).toBe("hello");
			expect(op.hash).toBe("hash_of_hello");
		}
	});

	it("returns delta sync for small changes", () => {
		const old = "x".repeat(1000);
		const newStr = old + "appended";
		const op = computeSyncOp(old, newStr, "old_hash", "new_hash");
		expect(op.op).toBe("delta");
		if (op.op === "delta") {
			expect(op.baseHash).toBe("old_hash");
			expect(op.hash).toBe("new_hash");
			expect(op.patches).toHaveLength(1);
			expect(op.patches[0].insert).toBe("appended");
		}
	});

	it("returns full sync when delta is too large", () => {
		const old = "a";
		const newStr = "b".repeat(100);
		const op = computeSyncOp(old, newStr, "old_hash", "new_hash");
		// delta would be ~100 chars + overhead > 80% of 100 chars
		expect(op.op).toBe("full");
	});

	it("returns delta with empty patches for identical strings", () => {
		const str = "hello";
		const op = computeSyncOp(str, str, "hash", "hash");
		expect(op.op).toBe("delta");
		if (op.op === "delta") {
			expect(op.patches).toEqual([]);
		}
	});
});

// ── applySyncOp ────────────────────────────────────────────────────────────

describe("applySyncOp", () => {
	it("applies full sync", async () => {
		const hash = await computeHash("hello");
		const result = await applySyncOp("old", "old_hash", {
			op: "full",
			data: "hello",
			hash,
		});
		expect(result).not.toBeNull();
		expect(result!.data).toBe("hello");
		expect(result!.hash).toBe(hash);
	});

	it("rejects full sync with wrong hash", async () => {
		const result = await applySyncOp("old", "old_hash", {
			op: "full",
			data: "hello",
			hash: "wrong_hash",
		});
		expect(result).toBeNull();
	});

	it("applies delta sync", async () => {
		const oldStr = "hello";
		const newStr = "hello world";
		const oldHash = await computeHash(oldStr);
		const newHash = await computeHash(newStr);
		const patches = computePatches(oldStr, newStr);

		const result = await applySyncOp(oldStr, oldHash, {
			op: "delta",
			patches,
			hash: newHash,
			baseHash: oldHash,
		});
		expect(result).not.toBeNull();
		expect(result!.data).toBe(newStr);
		expect(result!.hash).toBe(newHash);
	});

	it("rejects delta sync with wrong baseHash", async () => {
		const result = await applySyncOp("hello", "wrong_hash", {
			op: "delta",
			patches: [{ offset: 5, deleteCount: 0, insert: " world" }],
			hash: "new_hash",
			baseHash: "expected_hash",
		});
		expect(result).toBeNull();
	});

	it("rejects delta sync with corrupted patch", async () => {
		const oldStr = "hello";
		const oldHash = await computeHash(oldStr);
		const wrongNewHash = await computeHash("hello world");

		// Patch produces "hello there" but hash expects "hello world"
		const result = await applySyncOp(oldStr, oldHash, {
			op: "delta",
			patches: [{ offset: 5, deleteCount: 0, insert: " there" }],
			hash: wrongNewHash,
			baseHash: oldHash,
		});
		expect(result).toBeNull();
	});

	it("handles no-op delta (identical strings)", async () => {
		const str = "hello";
		const hash = await computeHash(str);

		const result = await applySyncOp(str, hash, {
			op: "delta",
			patches: [],
			hash,
			baseHash: hash,
		});
		expect(result).not.toBeNull();
		expect(result!.data).toBe(str);
	});

	it("end-to-end: computeSyncOp → applySyncOp roundtrip", async () => {
		const oldStr = '{"role":"user","content":"hi"}\n';
		const newStr = oldStr + '{"role":"assistant","content":"hello"}\n';
		const oldHash = await computeHash(oldStr);
		const newHash = await computeHash(newStr);

		const op = computeSyncOp(oldStr, newStr, oldHash, newHash);
		const result = await applySyncOp(oldStr, oldHash, op);

		expect(result).not.toBeNull();
		expect(result!.data).toBe(newStr);
		expect(result!.hash).toBe(newHash);
	});

	it("end-to-end: multiple incremental syncs", async () => {
		let current = "";
		let hash = await computeHash(current);

		const updates = [
			'{"role":"user","content":"hi"}\n',
			'{"role":"user","content":"hi"}\n{"role":"assistant","content":"hel"}\n',
			'{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}\n',
			'{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}\n{"type":"meta","pending":["tool_1"]}\n',
			'{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}\n{"role":"toolResult","partial":true,"content":"output..."}\n{"type":"meta","pending":["tool_1"]}\n',
		];

		for (const newStr of updates) {
			const newHash = await computeHash(newStr);
			const op = computeSyncOp(current, newStr, hash, newHash);
			const result = await applySyncOp(current, hash, op);

			expect(result).not.toBeNull();
			expect(result!.data).toBe(newStr);
			expect(result!.hash).toBe(newHash);

			current = result!.data;
			hash = result!.hash;
		}
	});

	it("end-to-end: simulates bash streaming updates", async () => {
		const baseMessages = '{"role":"user","content":"run a loop"}\n{"role":"assistant","content":"","toolCalls":[{"id":"call_1","name":"Bash","args":"{\\"command\\":\\"for i in 1 2 3; do echo $i; sleep 1; done\\"}"}]}\n';

		let current = baseMessages;
		let hash = await computeHash(current);

		// Simulate bash streaming partial results
		const partialOutputs = [
			"1\n",
			"1\n2\n",
			"1\n2\n3\n",
		];

		for (const output of partialOutputs) {
			const newStr = baseMessages +
				`{"role":"toolResult","partial":true,"toolCallId":"call_1","toolName":"Bash","content":[{"type":"text","text":${JSON.stringify(output)}}]}\n`;

			const newHash = await computeHash(newStr);
			const op = computeSyncOp(current, newStr, hash, newHash);

			// Delta should be small since only the partial output changes
			if (op.op === "delta") {
				const totalPatchSize = op.patches.reduce((sum, p) => sum + p.insert.length, 0);
				expect(totalPatchSize).toBeLessThan(newStr.length);
			}

			const result = await applySyncOp(current, hash, op);
			expect(result).not.toBeNull();
			expect(result!.data).toBe(newStr);

			current = result!.data;
			hash = result!.hash;
		}

		// Final: replace partial with real result
		const finalStr = baseMessages +
			'{"role":"toolResult","toolCallId":"call_1","toolName":"Bash","content":[{"type":"text","text":"1\\n2\\n3\\n"}]}\n';
		const finalHash = await computeHash(finalStr);
		const finalOp = computeSyncOp(current, finalStr, hash, finalHash);
		const finalResult = await applySyncOp(current, hash, finalOp);
		expect(finalResult).not.toBeNull();
		expect(finalResult!.data).toBe(finalStr);
	});
});

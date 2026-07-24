// @vitest-environment node

import { describe, expect, it } from "vitest";
import { applySyncOp, computeHash } from "../shared/jsonl-sync.js";
import { SessionSyncJournal } from "./session-sync-journal.js";

describe("SessionSyncJournal", () => {
	it("resumes a cached hash through multiple updates in one delta", async () => {
		const journal = new SessionSyncJournal();
		const base = "history ".repeat(1_000);
		const states = [
			JSON.stringify({ messages: [base], isStreaming: true }),
			JSON.stringify({ messages: [`${base}two`], isStreaming: true }),
			JSON.stringify({ messages: [`${base}two three`], isStreaming: false }),
		];
		const hashes = await Promise.all(states.map(computeHash));
		states.forEach((state, index) => journal.record("/session.jsonl", state, hashes[index]));

		const plan = journal.plan("/session.jsonl", hashes[0]);
		expect(plan).toMatchObject({ revision: 3, resumed: true, op: { op: "delta", baseHash: hashes[0], hash: hashes[2] } });
		const result = await applySyncOp(states[0], hashes[0], plan.op);
		expect(result).toEqual({ data: states[2], hash: hashes[2] });
	});

	it("uses an empty delta when the browser already has current state", async () => {
		const journal = new SessionSyncJournal();
		const json = JSON.stringify({ messages: ["current"] });
		const hash = await computeHash(json);
		journal.record("/session.jsonl", json, hash);
		expect(journal.plan("/session.jsonl", hash)).toEqual({
			revision: 1,
			resumed: true,
			op: { op: "delta", patches: [], baseHash: hash, hash },
		});
	});

	it("falls back to full state for an unknown or rewrite-separated hash", async () => {
		const journal = new SessionSyncJournal();
		const first = "a".repeat(10_000);
		const rewrite = "b".repeat(10_000);
		const firstHash = await computeHash(first);
		const rewriteHash = await computeHash(rewrite);
		journal.record("/session.jsonl", first, firstHash);
		journal.record("/session.jsonl", rewrite, rewriteHash);

		expect(journal.plan("/session.jsonl", firstHash)).toMatchObject({
			resumed: false,
			op: { op: "full", data: rewrite, hash: rewriteHash },
		});
		expect(journal.plan("/session.jsonl", "0".repeat(64))).toMatchObject({
			resumed: false,
			op: { op: "full" },
		});
	});
});

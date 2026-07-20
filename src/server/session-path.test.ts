/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionPathError, SessionPathGuard } from "./session-path.js";

describe("SessionPathGuard", () => {
	let tmpDir: string;
	let sessionsRoot: string;
	let outsidePath: string;
	let guard: SessionPathGuard;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "pipane-session-path-"));
		sessionsRoot = path.join(tmpDir, "agent", "sessions");
		mkdirSync(sessionsRoot, { recursive: true });
		outsidePath = path.join(tmpDir, "outside.jsonl");
		writeFileSync(outsidePath, "outside\n");
		guard = new SessionPathGuard(sessionsRoot);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns the canonical path for a real session file", () => {
		const sessionPath = path.join(sessionsRoot, "session.jsonl");
		writeFileSync(sessionPath, "session\n");
		const nonCanonical = path.join(sessionsRoot, "unused", "..", "session.jsonl");

		expect(guard.resolveExisting(nonCanonical)).toBe(sessionPath);
	});

	it("rejects absolute and traversal paths outside the configured root", () => {
		const traversal = path.join(sessionsRoot, "..", "..", "outside.jsonl");

		expect(() => guard.resolveExisting(outsidePath)).toThrow(SessionPathError);
		expect(() => guard.resolveExisting(traversal)).toThrow("within the Pi sessions directory");
		expect(() => guard.resolveExisting("relative.jsonl")).toThrow("absolute");
	});

	it("rejects a symlink escape even though the link is beneath the root", () => {
		const symlinkPath = path.join(sessionsRoot, "linked.jsonl");
		symlinkSync(outsidePath, symlinkPath);

		expect(() => guard.resolveExisting(symlinkPath)).toThrow("escapes the Pi sessions directory");
	});

	it("canonicalizes a symlink that remains within the sessions root", () => {
		const targetPath = path.join(sessionsRoot, "target.jsonl");
		const symlinkPath = path.join(sessionsRoot, "alias.jsonl");
		writeFileSync(targetPath, "session\n");
		symlinkSync(targetPath, symlinkPath);

		expect(guard.resolveExisting(symlinkPath)).toBe(targetPath);
	});

	it("distinguishes missing files from invalid session paths", () => {
		const missing = path.join(sessionsRoot, "missing.jsonl");
		const wrongExtension = path.join(sessionsRoot, "session.txt");
		const directory = path.join(sessionsRoot, "directory.jsonl");
		mkdirSync(directory);

		try {
			guard.resolveExisting(missing);
			throw new Error("Expected missing path to fail");
		} catch (error) {
			expect(error).toMatchObject({ code: "not_found" });
		}
		expect(() => guard.resolveExisting(wrongExtension)).toThrow(".jsonl file");
		expect(() => guard.resolveExisting(directory)).toThrow("not a file");
	});

	it("canonicalizes Pi-allocated paths before their files are flushed", () => {
		const projectDir = path.join(sessionsRoot, "--project--");
		mkdirSync(projectDir);
		const pendingPath = path.join(projectDir, "pending.jsonl");
		expect(guard.resolvePending(pendingPath)).toBe(pendingPath);

		const outsideDir = path.join(tmpDir, "outside-sessions");
		const escapedParent = path.join(sessionsRoot, "escaped-parent");
		mkdirSync(outsideDir);
		symlinkSync(outsideDir, escapedParent);
		expect(() => guard.resolvePending(path.join(escapedParent, "pending.jsonl")))
			.toThrow("escapes the Pi sessions directory");
	});

	it("creates generated destinations only beneath the canonical root", () => {
		expect(guard.createPath("fork.jsonl")).toBe(path.join(sessionsRoot, "fork.jsonl"));
		expect(() => guard.createPath("../fork.jsonl")).toThrow("generated session filename");
		expect(() => guard.createPath("fork.txt")).toThrow("generated session filename");
	});
});

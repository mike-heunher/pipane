/** @vitest-environment node */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	unwatchFile,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalSettingsStore } from "./local-settings.js";
import { registerRestApi } from "./rest-api.js";
import { SessionPathGuard } from "./session-path.js";

describe("REST session path confinement", () => {
	let tmpDir: string;
	let sessionsRoot: string;
	let sessionPath: string;
	let deletePath: string;
	let outsidePath: string;
	let traversalPath: string;
	let symlinkPath: string;
	let settingsPath: string;
	let projectRoot: string;
	let previewPath: string;
	let projectEscapePath: string;
	let mentionedOutsidePath: string;
	let relativeMentionedOutsidePath: string;
	let unmentionedOutsidePath: string;
	let server: Server;
	let baseUrl: string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "pipane-rest-path-"));
		sessionsRoot = path.join(tmpDir, "agent", "sessions");
		mkdirSync(sessionsRoot, { recursive: true });
		sessionPath = path.join(sessionsRoot, "session.jsonl");
		deletePath = path.join(sessionsRoot, "delete.jsonl");
		outsidePath = path.join(tmpDir, "agent", "outside.jsonl");
		traversalPath = `${sessionsRoot}${path.sep}..${path.sep}outside.jsonl`;
		symlinkPath = path.join(sessionsRoot, "escape.jsonl");
		settingsPath = path.join(tmpDir, "settings.json");
		projectRoot = path.join(tmpDir, "projects", "project-a");
		previewPath = path.join(projectRoot, "docs", "guide.md");
		projectEscapePath = path.join(projectRoot, "outside.md");
		mentionedOutsidePath = path.join(tmpDir, "shared", "review notes.md");
		relativeMentionedOutsidePath = path.join(tmpDir, "shared", "relative.md");
		unmentionedOutsidePath = path.join(tmpDir, "shared", "secret.md");
		mkdirSync(path.dirname(previewPath), { recursive: true });
		mkdirSync(path.dirname(mentionedOutsidePath), { recursive: true });
		writeFileSync(previewPath, "# Guide\n\nProject documentation.\n");
		writeFileSync(mentionedOutsidePath, "# Review notes\n");
		writeFileSync(relativeMentionedOutsidePath, "# Relative review\n");
		writeFileSync(unmentionedOutsidePath, "private\n");
		writeFileSync(path.join(tmpDir, "outside.md"), "private\n");
		symlinkSync(path.join(tmpDir, "outside.md"), projectEscapePath);

		const sessionLines = [
			{
				type: "session",
				version: 3,
				id: "session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: projectRoot,
			},
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "user",
					content: `Open \`${path.relative(projectRoot, relativeMentionedOutsidePath)}\`.`,
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "message-2",
				parentId: "message-1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{
						type: "text",
						text: `Review \`${mentionedOutsidePath}\`; ignore \`${unmentionedOutsidePath}.backup\`.`,
					}],
					timestamp: 2,
				},
			},
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		writeFileSync(sessionPath, sessionLines);
		writeFileSync(deletePath, sessionLines);
		writeFileSync(outsidePath, "outside\n");
		symlinkSync(outsidePath, symlinkPath);

		const app = express();
		registerRestApi(app, {
			localSettingsStore: new LocalSettingsStore({ homeDir: tmpDir, settingsPath }),
			sessionPaths: new SessionPathGuard(sessionsRoot),
		});
		server = await new Promise<Server>((resolve) => {
			const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Failed to start test server");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		unwatchFile(settingsPath);
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function requestSessionEndpoint(endpoint: string, candidate: string): Promise<Response> {
		if (endpoint === "/api/sessions") {
			return fetch(`${baseUrl}${endpoint}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: candidate }),
			});
		}
		const query = new URLSearchParams({ path: candidate });
		return fetch(`${baseUrl}${endpoint}?${query}`);
	}

	it("allows raw and message reads for a real session", async () => {
		const raw = await requestSessionEndpoint("/api/sessions/raw", sessionPath);
		expect(raw.status).toBe(200);
		expect(await raw.text()).toContain('"id":"session"');

		const messages = await requestSessionEndpoint("/api/sessions/fork-messages", sessionPath);
		expect(messages.status).toBe(200);
		expect(await messages.json()).toEqual({
			messages: [{
				entryId: "message-1",
				text: `Open \`${path.relative(projectRoot, relativeMentionedOutsidePath)}\`.`,
			}],
		});
	});

	it.each([
		["delete", "/api/sessions"],
		["raw read", "/api/sessions/raw"],
		["message read", "/api/sessions/fork-messages"],
	])("rejects outside, traversal, and symlink escapes for %s", async (_name, endpoint) => {
		for (const maliciousPath of [outsidePath, traversalPath, symlinkPath]) {
			const response = await requestSessionEndpoint(endpoint, maliciousPath);
			expect(response.status).toBe(400);
		}
	});

	it("returns not found for confined session paths that do not exist", async () => {
		const response = await requestSessionEndpoint(
			"/api/sessions/raw",
			path.join(sessionsRoot, "missing.jsonl"),
		);
		expect(response.status).toBe(404);
	});

	it("deletes a validated session file", async () => {
		const response = await requestSessionEndpoint("/api/sessions", deletePath);
		expect(response.status).toBe(200);
		expect(existsSync(deletePath)).toBe(false);
	});

	it("retrieves previewable text files within the supplied session cwd", async () => {
		const query = new URLSearchParams({ sessionPath, path: "docs/guide.md" });
		const response = await fetch(`${baseUrl}/api/files/content?${query}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path: previewPath,
			content: "# Guide\n\nProject documentation.\n",
		});
	});

	it("retrieves outside-CWD files explicitly mentioned in the conversation", async () => {
		for (const candidate of [mentionedOutsidePath, relativeMentionedOutsidePath]) {
			const query = new URLSearchParams({ sessionPath, path: candidate });
			const response = await fetch(`${baseUrl}/api/files/content?${query}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ path: candidate });
		}
	});

	it("rejects file previews that escape the CWD without an exact conversation mention", async () => {
		for (const candidate of [
			path.join(projectRoot, "..", "..", "outside.md"),
			projectEscapePath,
			unmentionedOutsidePath,
		]) {
			const query = new URLSearchParams({ sessionPath, path: candidate });
			const response = await fetch(`${baseUrl}/api/files/content?${query}`);
			expect(response.status).toBe(403);
		}
	});

	it("requires a guarded session path before retrieving file content", async () => {
		for (const maliciousPath of [outsidePath, traversalPath, symlinkPath]) {
			const query = new URLSearchParams({ sessionPath: maliciousPath, path: previewPath });
			const response = await fetch(`${baseUrl}/api/files/content?${query}`);
			expect(response.status).toBe(400);
		}
	});

	it("keeps project directory browsing independently unrestricted", async () => {
		const outsideDirectory = path.join(tmpDir, "projects");
		const query = new URLSearchParams({ path: outsideDirectory });
		const response = await fetch(`${baseUrl}/api/browse?${query}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			path: outsideDirectory,
			dirs: [{ name: "project-a", path: path.join(outsideDirectory, "project-a") }],
		});
	});
});

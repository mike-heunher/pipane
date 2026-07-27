/** @vitest-environment node */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
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
	let writeMatchSessionPath: string;
	let deletePath: string;
	let outsidePath: string;
	let traversalPath: string;
	let symlinkPath: string;
	let settingsPath: string;
	let projectRoot: string;
	let previewPath: string;
	let projectEscapePath: string;
	let worktreeRoot: string;
	let worktreeGeneratedPath: string;
	let worktreeRelatedPath: string;
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
		writeMatchSessionPath = path.join(sessionsRoot, "write-match.jsonl");
		deletePath = path.join(sessionsRoot, "delete.jsonl");
		outsidePath = path.join(tmpDir, "agent", "outside.jsonl");
		traversalPath = `${sessionsRoot}${path.sep}..${path.sep}outside.jsonl`;
		symlinkPath = path.join(sessionsRoot, "escape.jsonl");
		settingsPath = path.join(tmpDir, "settings.json");
		projectRoot = path.join(tmpDir, "projects", "project-a");
		previewPath = path.join(projectRoot, "docs", "guide.md");
		projectEscapePath = path.join(projectRoot, "outside.md");
		worktreeRoot = path.join(tmpDir, "projects", "project-a--wt-preview");
		worktreeGeneratedPath = path.join(worktreeRoot, "docs", "generated.md");
		worktreeRelatedPath = path.join(worktreeRoot, "docs", "related.md");
		mentionedOutsidePath = path.join(tmpDir, "shared", "review notes.md");
		relativeMentionedOutsidePath = path.join(tmpDir, "shared", "relative.md");
		unmentionedOutsidePath = path.join(tmpDir, "shared", "secret.md");
		mkdirSync(path.dirname(previewPath), { recursive: true });
		mkdirSync(path.dirname(mentionedOutsidePath), { recursive: true });
		mkdirSync(path.dirname(worktreeGeneratedPath), { recursive: true });
		const worktreeName = path.basename(worktreeRoot);
		const worktreeGitDir = path.join(projectRoot, ".git", "worktrees", worktreeName);
		mkdirSync(worktreeGitDir, { recursive: true });
		writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
		writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
		writeFileSync(previewPath, "# Guide\n\nProject documentation.\n");
		writeFileSync(path.join(projectRoot, "docs", "generated.md"), "# Stale root document\n");
		writeFileSync(worktreeGeneratedPath, "# Generated in worktree\n");
		writeFileSync(worktreeRelatedPath, "# Related worktree document\n");
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
			{
				type: "message",
				id: "failed-assistant",
				parentId: "message-2",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "failed-write", name: "write", arguments: { path: unmentionedOutsidePath } }],
				},
			},
			{
				type: "message",
				id: "failed-result",
				parentId: "failed-assistant",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: { role: "toolResult", toolCallId: "failed-write", content: [], isError: true },
			},
			{
				type: "message",
				id: "write-assistant",
				parentId: "failed-result",
				timestamp: "2026-01-01T00:00:05.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "worktree-write", name: "functions.write", arguments: { path: worktreeGeneratedPath } }],
				},
			},
			{
				type: "message",
				id: "write-result",
				parentId: "write-assistant",
				timestamp: "2026-01-01T00:00:06.000Z",
				message: { role: "toolResult", toolCallId: "worktree-write", content: [], isError: false },
			},
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		const writeMatchSessionLines = [
			{
				type: "session",
				version: 3,
				id: "write-match",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: projectRoot,
			},
			{
				type: "message",
				id: "write-assistant",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "worktree-write", name: "write", arguments: { path: worktreeGeneratedPath } }],
				},
			},
			{
				type: "message",
				id: "write-result",
				parentId: "write-assistant",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "toolResult", toolCallId: "worktree-write", content: [], isError: false },
			},
			{
				type: "message",
				id: "root-read-assistant",
				parentId: "write-result",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "root-read", name: "read", arguments: { path: previewPath } }],
				},
			},
			{
				type: "message",
				id: "root-read-result",
				parentId: "root-read-assistant",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: { role: "toolResult", toolCallId: "root-read", content: [], isError: false },
			},
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		writeFileSync(sessionPath, sessionLines);
		writeFileSync(writeMatchSessionPath, writeMatchSessionLines);
		writeFileSync(deletePath, sessionLines);
		writeFileSync(outsidePath, "outside\n");
		symlinkSync(outsidePath, symlinkPath);

		const app = express();
		registerRestApi(app, {
			localSettingsStore: new LocalSettingsStore({ homeDir: tmpDir, settingsPath }),
			sessionPaths: new SessionPathGuard(sessionsRoot),
			backendId: "backend-test",
			uploadDirectory: path.join(tmpDir, "uploads"),
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

	it("advertises content-addressed browser synchronization", async () => {
		const response = await fetch(`${baseUrl}/api/capabilities`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			backendId: "backend-test",
			features: expect.arrayContaining(["content-addressed-session-sync"]),
		});
	});

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

	it("resolves relative preview links against the conversation's active worktree", async () => {
		for (const [requestedPath, expectedPath, expectedHeading] of [
			["docs/generated.md", worktreeGeneratedPath, "# Generated in worktree\n"],
			["docs/related.md", worktreeRelatedPath, "# Related worktree document\n"],
		] as const) {
			const query = new URLSearchParams({ sessionPath, path: requestedPath });
			const response = await fetch(`${baseUrl}/api/files/content?${query}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ path: expectedPath, content: expectedHeading });
		}
	});

	it("prefers an exact successful write when later root activity resets the active checkout", async () => {
		const query = new URLSearchParams({ sessionPath: writeMatchSessionPath, path: "docs/generated.md" });
		const response = await fetch(`${baseUrl}/api/files/content?${query}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path: worktreeGeneratedPath,
			content: "# Generated in worktree\n",
		});
	});

	it("allows canonical nested paths inside a worktree evidenced by the conversation", async () => {
		const query = new URLSearchParams({ sessionPath, path: worktreeRelatedPath });
		const response = await fetch(`${baseUrl}/api/files/content?${query}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ path: worktreeRelatedPath });
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

	it("stores arbitrary uploaded bytes in a confined temporary file", async () => {
		const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
		const created = await fetch(`${baseUrl}/api/files/uploads`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				fileName: "../payload.bin",
				mimeType: "application/octet-stream",
				size: bytes.length,
			}),
		});
		expect(created.status).toBe(201);
		const { uploadId } = await created.json() as { uploadId: string };

		const chunk = await fetch(`${baseUrl}/api/files/uploads/${uploadId}/chunks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ offset: 0, data: bytes.toString("base64") }),
		});
		expect(chunk.status).toBe(200);
		expect(await chunk.json()).toEqual({ nextOffset: bytes.length });

		const completed = await fetch(`${baseUrl}/api/files/uploads/${uploadId}/complete`, { method: "POST" });
		expect(completed.status).toBe(200);
		const uploaded = await completed.json() as { path: string; fileName: string; size: number };
		expect(uploaded).toMatchObject({ fileName: "payload.bin", size: bytes.length });
		expect(uploaded.path.startsWith(path.join(tmpDir, "uploads"))).toBe(true);
		expect(readFileSync(uploaded.path)).toEqual(bytes);
	});

	it("rejects invalid or incomplete file uploads", async () => {
		const created = await fetch(`${baseUrl}/api/files/uploads`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileName: "partial.dat", mimeType: "application/octet-stream", size: 2 }),
		});
		const { uploadId } = await created.json() as { uploadId: string };
		const invalidChunk = await fetch(`${baseUrl}/api/files/uploads/${uploadId}/chunks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ offset: 0, data: "not base64" }),
		});
		expect(invalidChunk.status).toBe(400);
		expect((await fetch(`${baseUrl}/api/files/uploads/${uploadId}/complete`, { method: "POST" })).status).toBe(409);
	});

	it("keeps project directory browsing independently unrestricted", async () => {
		const outsideDirectory = path.join(tmpDir, "projects");
		const query = new URLSearchParams({ path: outsideDirectory });
		const response = await fetch(`${baseUrl}/api/browse?${query}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path: outsideDirectory,
			dirs: [
				{ name: "project-a", path: path.join(outsideDirectory, "project-a") },
				{ name: "project-a--wt-preview", path: worktreeRoot },
			],
		});
	});

	it("creates a direct child folder for the project picker", async () => {
		const parentPath = path.join(tmpDir, "projects");
		const response = await fetch(`${baseUrl}/api/directories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ parentPath, name: "new-project" }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			name: "new-project",
			path: path.join(parentPath, "new-project"),
		});
		expect(existsSync(path.join(parentPath, "new-project"))).toBe(true);

		const duplicate = await fetch(`${baseUrl}/api/directories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ parentPath, name: "new-project" }),
		});
		expect(duplicate.status).toBe(409);
	});

	it("rejects folder names that escape the selected parent", async () => {
		const parentPath = path.join(tmpDir, "projects");
		const escapedPath = path.join(tmpDir, "escaped-project");
		const response = await fetch(`${baseUrl}/api/directories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ parentPath, name: "../escaped-project" }),
		});

		expect(response.status).toBe(400);
		expect(existsSync(escapedPath)).toBe(false);
	});
});

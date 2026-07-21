/**
 * REST API endpoints for pipane.
 *
 * Stateless handlers that read session data from JSONL files on disk.
 */

import type { Express, Response } from "express";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, watchFile } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { conversationMentionsFile } from "./conversation-file-access.js";
import { SessionIndex } from "./session-index.js";
import { LocalSettingsStore } from "./local-settings.js";
import { SessionPathError, SessionPathGuard } from "./session-path.js";
import { getSessionCwd } from "./session-cwd.js";

interface RegisterRestApiOptions {
	localSettingsStore?: LocalSettingsStore;
	sessionPaths?: SessionPathGuard;
	onLocalSettingsReloaded?: () => void;
	runSessionMutation?: (
		sessionPath: string,
		operation: string,
		mutation: () => Promise<void>,
	) => Promise<void>;
}

let localSettingsStore: LocalSettingsStore;
let sessionIndex: SessionIndex;

let localSettingsWatcherStarted = false;

const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function startLocalSettingsWatcher(onLocalSettingsReloaded?: () => void) {
	if (localSettingsWatcherStarted) return;
	localSettingsWatcherStarted = true;

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	watchFile(localSettingsStore.path, { interval: 500 }, () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(async () => {
			const changed = localSettingsStore.reloadFromDiskIfValid();
			if (!changed) return;
			await sessionIndex.invalidateAll();
			onLocalSettingsReloaded?.();
		}, 150);
	});
}

async function readJsonBody(req: any): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString();
	return JSON.parse(raw || "{}");
}

function sendError(res: Response, error: unknown): void {
	if (error instanceof SessionPathError) {
		res.status(error.code === "not_found" ? 404 : 400).json({ error: error.message });
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	res.status(500).json({ error: message });
}

export function registerRestApi(app: Express, options: RegisterRestApiOptions = {}) {
	localSettingsStore = options.localSettingsStore ?? new LocalSettingsStore();
	const sessionPaths = options.sessionPaths ?? new SessionPathGuard();
	sessionIndex = new SessionIndex({
		cwdDisplayFormatter: (cwd) => localSettingsStore.formatCwdTitle(cwd),
	});
	startLocalSettingsWatcher(options.onLocalSettingsReloaded);

	app.get("/api/sessions", async (_req, res) => {
		try {
			res.json(await sessionIndex.listSessions());
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.get("/api/settings/local", (_req, res) => {
		try {
			res.json(localSettingsStore.read());
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.post("/api/settings/local/validate", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			if (typeof body.content !== "string") {
				res.status(400).json({ error: "Missing 'content' string" });
				return;
			}
			res.json(localSettingsStore.validate(body.content));
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.patch("/api/settings/local", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			if (!body || typeof body !== "object") {
				res.status(400).json({ error: "Request body must be a JSON object" });
				return;
			}

			const result = localSettingsStore.patch(body);
			if (!result.valid) {
				res.status(400).json(result);
				return;
			}

			await sessionIndex.invalidateAll();
			options.onLocalSettingsReloaded?.();
			res.json(result);
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.put("/api/settings/local", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			if (typeof body.content !== "string") {
				res.status(400).json({ error: "Missing 'content' string" });
				return;
			}

			const result = localSettingsStore.save(body.content);
			if (!result.valid) {
				res.status(400).json(result);
				return;
			}

			await sessionIndex.invalidateAll();
			options.onLocalSettingsReloaded?.();
			res.json(result);
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.delete("/api/sessions", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			const sessionPath = sessionPaths.resolveExisting(body.path);
			const remove = () => unlink(sessionPath);
			if (options.runSessionMutation) {
				await options.runSessionMutation(sessionPath, "delete session", remove);
			} else {
				await remove();
			}
			res.json({ success: true });
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/sessions/fork-messages", (req, res) => {
		try {
			const sessionPath = sessionPaths.resolveExisting(req.query.path);
			const content = readFileSync(sessionPath, "utf8");
			const entries = parseSessionEntries(content);
			const messages: Array<{ entryId: string; text: string }> = [];

			for (const entry of entries) {
				if ((entry as any).type !== "message") continue;
				const msg = (entry as any).message;
				if (!msg || msg.role !== "user") continue;

				let text = "";
				if (typeof msg.content === "string") {
					text = msg.content;
				} else if (Array.isArray(msg.content)) {
					text = msg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("");
				}

				if (text && (entry as any).id) {
					messages.push({ entryId: (entry as any).id, text });
				}
			}

			res.json({ messages });
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/sessions/raw", (req, res) => {
		try {
			const sessionPath = sessionPaths.resolveExisting(req.query.path);
			const content = readFileSync(sessionPath, "utf8");
			res.type("text/plain").send(content);
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/files/content", (req, res) => {
		try {
			if (typeof req.query.sessionPath !== "string" || typeof req.query.path !== "string") {
				res.status(400).json({ error: "Missing 'sessionPath' or 'path' query parameter" });
				return;
			}

			const sessionPath = sessionPaths.resolveExisting(req.query.sessionPath);
			const sessionCwd = getSessionCwd(sessionPath);
			if (!sessionCwd) {
				res.status(400).json({ error: "Session has no working directory" });
				return;
			}
			const root = realpathSync(path.resolve(sessionCwd.replace(/^~/, process.env.HOME || "/")));

			const requested = path.isAbsolute(req.query.path)
				? req.query.path
				: path.resolve(root, req.query.path);
			const resolved = realpathSync(requested);
			if (!isPathInside(root, resolved) && !conversationMentionsFile({
				sessionPath,
				sessionCwd,
				rawRequestPath: req.query.path,
				requestedPath: requested,
				resolvedPath: resolved,
			})) {
				res.status(403).json({
					error: "File is outside the session working directory and was not mentioned in the conversation",
				});
				return;
			}

			const stat = statSync(resolved);
			if (!stat.isFile()) {
				res.status(400).json({ error: "Path is not a file" });
				return;
			}
			if (stat.size > MAX_PREVIEW_FILE_BYTES) {
				res.status(413).json({ error: "File is too large to preview" });
				return;
			}

			const bytes = readFileSync(resolved);
			if (bytes.includes(0)) {
				res.status(415).json({ error: "Binary files cannot be previewed" });
				return;
			}
			res.json({ path: resolved, content: bytes.toString("utf8") });
		} catch (error: any) {
			if (error instanceof SessionPathError) {
				sendError(res, error);
				return;
			}
			if (error?.code === "ENOENT") {
				res.status(404).json({ error: "File not found" });
				return;
			}
			res.status(500).json({ error: error?.message ?? String(error) });
		}
	});

	app.get("/api/browse", (req, res) => {
		try {
			const requestedPath = (req.query.path as string) || process.env.HOME || "/";
			const resolved = path.resolve(requestedPath.replace(/^~/, process.env.HOME || "/"));

			if (!existsSync(resolved)) {
				res.status(404).json({ error: "Path not found" });
				return;
			}

			const entries = readdirSync(resolved, { withFileTypes: true });
			const dirs = entries
				.filter((e) => e.isDirectory() && !e.name.startsWith("."))
				.map((e) => ({
					name: e.name,
					path: path.join(resolved, e.name),
				}))
				.sort((a, b) => a.name.localeCompare(b.name));

			res.json({ path: resolved, dirs });
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});
}

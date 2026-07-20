/**
 * REST API endpoints for pipane.
 *
 * Stateless handlers that read session data from JSONL files on disk.
 */

import type { Express } from "express";
import { existsSync, readFileSync, readdirSync, watchFile } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { SessionIndex } from "./session-index.js";
import { LocalSettingsStore } from "./local-settings.js";

interface RegisterRestApiOptions {
	localSettingsStore?: LocalSettingsStore;
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

export function registerRestApi(app: Express, options: RegisterRestApiOptions = {}) {
	localSettingsStore = options.localSettingsStore ?? new LocalSettingsStore();
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
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString());

			const { path: sessionPath } = body;
			if (!sessionPath || typeof sessionPath !== "string") {
				res.status(400).json({ error: "Missing session path" });
				return;
			}
			if (!sessionPath.endsWith(".jsonl") || !existsSync(sessionPath)) {
				res.status(404).json({ error: "Session not found" });
				return;
			}
			const remove = () => unlink(sessionPath);
			if (options.runSessionMutation) {
				await options.runSessionMutation(sessionPath, "delete session", remove);
			} else {
				await remove();
			}
			res.json({ success: true });
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.get("/api/sessions/fork-messages", (req, res) => {
		try {
			const sessionPath = req.query.path as string;
			if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
				res.status(400).json({ error: "Missing or invalid session path" });
				return;
			}
			if (!existsSync(sessionPath)) {
				res.status(404).json({ error: "Session file not found" });
				return;
			}

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
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.get("/api/sessions/raw", (req, res) => {
		try {
			const sessionPath = req.query.path as string;
			if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
				res.status(400).json({ error: "Missing or invalid session path" });
				return;
			}
			if (!existsSync(sessionPath)) {
				res.status(404).json({ error: "Session file not found" });
				return;
			}

			const content = readFileSync(sessionPath, "utf8");
			res.type("text/plain").send(content);
		} catch (err: any) {
			res.status(500).json({ error: err.message });
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

/**
 * REST API endpoints for pi-web.
 *
 * Stateless handlers that read session data from JSONL files on disk.
 */

import type { Express } from "express";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
	SessionManager,
	buildSessionContext,
	parseSessionEntries,
} from "@mariozechner/pi-coding-agent";
import type { LoadTraceStore } from "./load-trace-store.js";

interface LastUserPromptCacheEntry {
	mtimeMs: number;
	size: number;
	lastUserPromptTime?: string;
}

const lastUserPromptTimeCache = new Map<string, LastUserPromptCacheEntry>();

async function getLastUserPromptTime(sessionPath: string): Promise<string | undefined> {
	try {
		const fileStat = await stat(sessionPath);
		const cached = lastUserPromptTimeCache.get(sessionPath);
		if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
			return cached.lastUserPromptTime;
		}

		const content = await readFile(sessionPath, "utf8");
		const entries = parseSessionEntries(content);
		let latestUserTs = 0;
		for (const entry of entries) {
			if ((entry as any).type !== "message") continue;
			const msg = (entry as any).message;
			if (!msg || msg.role !== "user") continue;
			if (typeof msg.timestamp === "number" && msg.timestamp > latestUserTs) {
				latestUserTs = msg.timestamp;
			} else if (typeof (entry as any).timestamp === "string") {
				const t = new Date((entry as any).timestamp).getTime();
				if (!Number.isNaN(t) && t > latestUserTs) {
					latestUserTs = t;
				}
			}
		}

		const lastUserPromptTime = latestUserTs > 0 ? new Date(latestUserTs).toISOString() : undefined;
		lastUserPromptTimeCache.set(sessionPath, {
			mtimeMs: fileStat.mtimeMs,
			size: fileStat.size,
			lastUserPromptTime,
		});
		return lastUserPromptTime;
	} catch {
		return undefined;
	}
}

interface RegisterRestApiOptions {
	traceStore?: LoadTraceStore;
}

export function registerRestApi(app: Express, options: RegisterRestApiOptions = {}) {
	const traceStore = options.traceStore;

	app.post("/api/debug/load-trace/event", async (req, res) => {
		try {
			if (!traceStore) {
				res.status(404).json({ error: "Tracing disabled" });
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");

			const traceId = String(body.traceId || req.headers["x-pi-trace-id"] || "");
			if (!traceId) {
				res.status(400).json({ error: "Missing traceId" });
				return;
			}

			traceStore.record(traceId, {
				ts: new Date().toISOString(),
				source: "frontend",
				kind: body.durationMs != null ? "span" : "instant",
				name: String(body.name || "frontend_event"),
				durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
				attrs: body.attrs && typeof body.attrs === "object" ? body.attrs : undefined,
			});
			res.json({ ok: true });
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.get("/api/debug/load-trace/latest", (_req, res) => {
		if (!traceStore) {
			res.status(404).json({ error: "Tracing disabled" });
			return;
		}
		res.json({ traces: traceStore.getLatest() });
	});

	app.get("/api/debug/load-trace/:traceId", (req, res) => {
		if (!traceStore) {
			res.status(404).json({ error: "Tracing disabled" });
			return;
		}
		const trace = traceStore.get(req.params.traceId);
		if (!trace) {
			res.status(404).json({ error: "Trace not found" });
			return;
		}
		res.json(trace);
	});

	app.get("/api/sessions", async (_req, res) => {
		try {
			const sessions = await SessionManager.listAll();
			const activePaths = new Set(sessions.map((s) => s.path));
			for (const cachedPath of lastUserPromptTimeCache.keys()) {
				if (!activePaths.has(cachedPath)) {
					lastUserPromptTimeCache.delete(cachedPath);
				}
			}

			const lastUserPromptTimes = await Promise.all(
				sessions.map((s) => getLastUserPromptTime(s.path)),
			);

			const result = sessions.map((s, i) => ({
				id: s.id,
				path: s.path,
				cwd: s.cwd,
				name: s.name,
				created: s.created.toISOString(),
				modified: s.modified.toISOString(),
				lastUserPromptTime: lastUserPromptTimes[i],
				messageCount: s.messageCount,
				firstMessage: s.firstMessage,
			}));
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
			await unlink(sessionPath);
			res.json({ success: true });
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	app.get("/api/sessions/messages", (req, res) => {
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
			const context = buildSessionContext(entries as any);

			res.json({
				messages: context.messages,
				model: context.model,
				thinkingLevel: context.thinkingLevel,
			});
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

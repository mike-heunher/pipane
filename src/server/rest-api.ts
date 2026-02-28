/**
 * REST API endpoints for pi-web.
 *
 * Stateless handlers that read session data from JSONL files on disk.
 */

import type { Express } from "express";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
	SessionManager,
	buildSessionContext,
	parseSessionEntries,
} from "@mariozechner/pi-coding-agent";

export function registerRestApi(app: Express) {
	app.get("/api/sessions", async (_req, res) => {
		try {
			const sessions = await SessionManager.listAll();
			const result = sessions.map((s) => {
				let lastUserPromptTime: string | undefined;
				try {
					if (existsSync(s.path)) {
						const content = readFileSync(s.path, "utf8");
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
						if (latestUserTs > 0) {
							lastUserPromptTime = new Date(latestUserTs).toISOString();
						}
					}
				} catch {
					// Ignore errors
				}

				return {
					id: s.id,
					path: s.path,
					cwd: s.cwd,
					name: s.name,
					created: s.created.toISOString(),
					modified: s.modified.toISOString(),
					lastUserPromptTime,
					messageCount: s.messageCount,
					firstMessage: s.firstMessage,
				};
			});
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

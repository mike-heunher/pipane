/** HTTP compatibility facade over the carrier-neutral backend service. */

import type { Express, Response } from "express";
import type { BackendApi } from "../shared/backend-api.js";
import { LocalBackendApi, LocalBackendApiError, type LocalBackendApiOptions } from "./local-backend-api.js";

export interface RegisterRestApiOptions extends LocalBackendApiOptions {
	api?: BackendApi;
}

async function readJsonBody(req: any, maxBytes = Number.POSITIVE_INFINITY): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw new LocalBackendApiError("Request body is too large", 413, "invalid_request");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

function sendError(res: Response, error: unknown): void {
	if (error instanceof LocalBackendApiError) {
		res.status(error.status).json({ error: error.message, code: error.code });
		return;
	}
	res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

export function registerRestApi(app: Express, options: RegisterRestApiOptions = {}): BackendApi {
	const api = options.api ?? new LocalBackendApi(options);

	app.get("/api/sessions", async (_req, res) => {
		try {
			res.json(await api.listSessions());
		} catch (error) {
			sendError(res, error);
		}
	});

	app.delete("/api/sessions", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			if (typeof body.path !== "string") throw new LocalBackendApiError("Missing 'path' string", 400, "invalid_request");
			await api.deleteSession(body.path);
			res.json({ success: true });
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/sessions/fork-messages", async (req, res) => {
		try {
			if (typeof req.query.path !== "string") throw new LocalBackendApiError("Missing 'path' query parameter", 400, "invalid_request");
			res.json({ messages: await api.listForkMessages(req.query.path) });
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/sessions/raw", async (req, res) => {
		try {
			if (typeof req.query.path !== "string") throw new LocalBackendApiError("Missing 'path' query parameter", 400, "invalid_request");
			res.type("text/plain").send(await api.getRawSession(req.query.path));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/files/content", async (req, res) => {
		try {
			if (typeof req.query.sessionPath !== "string" || typeof req.query.path !== "string") {
				throw new LocalBackendApiError("Missing 'sessionPath' or 'path' query parameter", 400, "invalid_request");
			}
			res.json(await api.getFileContent(req.query.sessionPath, req.query.path));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.post("/api/files/uploads", async (req, res) => {
		try {
			const body = await readJsonBody(req, 512 * 1024);
			if (typeof body.fileName !== "string" || typeof body.mimeType !== "string" || typeof body.size !== "number") {
				throw new LocalBackendApiError("Missing file upload metadata", 400, "invalid_request");
			}
			res.status(201).json(await api.createFileUpload({
				fileName: body.fileName,
				mimeType: body.mimeType,
				size: body.size,
			}));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.post("/api/files/uploads/:uploadId/chunks", async (req, res) => {
		try {
			const body = await readJsonBody(req, 512 * 1024);
			if (typeof body.offset !== "number" || typeof body.data !== "string") {
				throw new LocalBackendApiError("Missing file upload chunk", 400, "invalid_request");
			}
			res.json(await api.appendFileUpload({
				uploadId: req.params.uploadId,
				offset: body.offset,
				data: body.data,
			}));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.post("/api/files/uploads/:uploadId/complete", async (req, res) => {
		try {
			res.json(await api.completeFileUpload(req.params.uploadId));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/browse", async (req, res) => {
		try {
			res.json(await api.browseDirectory(typeof req.query.path === "string" ? req.query.path : ""));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.post("/api/directories", async (req, res) => {
		try {
			const body = await readJsonBody(req, 16 * 1024);
			if (typeof body.parentPath !== "string" || typeof body.name !== "string") {
				throw new LocalBackendApiError("Missing 'parentPath' or 'name' string", 400, "invalid_request");
			}
			res.status(201).json(await api.createDirectory(body.parentPath, body.name));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.get("/api/settings/local", async (_req, res) => {
		try {
			res.json(await api.getLocalSettings());
		} catch (error) {
			sendError(res, error);
		}
	});

	app.post("/api/settings/local/validate", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			if (typeof body.content !== "string") throw new LocalBackendApiError("Missing 'content' string", 400, "invalid_request");
			res.json(await api.validateLocalSettings(body.content));
		} catch (error) {
			sendError(res, error);
		}
	});

	app.patch("/api/settings/local", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				throw new LocalBackendApiError("Request body must be a JSON object", 400, "invalid_request");
			}
			const result = await api.patchLocalSettings(body);
			res.status(result.valid ? 200 : 400).json(result);
		} catch (error) {
			sendError(res, error);
		}
	});

	app.put("/api/settings/local", async (req, res) => {
		try {
			const body = await readJsonBody(req);
			if (typeof body.content !== "string") throw new LocalBackendApiError("Missing 'content' string", 400, "invalid_request");
			const result = await api.saveLocalSettings(body.content);
			res.status(result.valid ? 200 : 400).json(result);
		} catch (error) {
			sendError(res, error);
		}
	});

	return api;
}

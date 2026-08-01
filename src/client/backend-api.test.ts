import { describe, expect, it, vi } from "vitest";
import { BackendApiError, HttpBackendApi } from "./backend-api.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("HttpBackendApi", () => {
	it("loads backend capabilities without caching the response", async () => {
		const capabilities = {
			backendId: "local",
			semanticProtocolVersion: 2,
			applicationProtocolVersions: [1],
			features: ["content-addressed-session-sync"],
		};
		const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(capabilities));
		const api = new HttpBackendApi({ fetch: fetchMock });

		await expect(api.getCapabilities()).resolves.toEqual(capabilities);
		expect(fetchMock).toHaveBeenCalledWith("/api/capabilities", { cache: "no-store" });
	});

	it("maps session, file, and directory operations onto the current HTTP API", async () => {
		const session = {
			id: "one",
			path: "/sessions/one.jsonl",
			cwd: "/work",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-01T00:00:00Z",
			messageCount: 1,
			firstMessage: "hello",
		};
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(jsonResponse([session]))
			.mockResolvedValueOnce(jsonResponse({ messages: [{ entryId: "entry", text: "hello" }] }))
			.mockResolvedValueOnce(jsonResponse({ success: true }))
			.mockResolvedValueOnce(jsonResponse({ path: "/work", dirs: [{ name: "src", path: "/work/src" }] }))
			.mockResolvedValueOnce(jsonResponse({ name: "new-project", path: "/work/new-project" }, 201))
			.mockResolvedValueOnce(new Response('{"type":"session"}\n'))
			.mockResolvedValueOnce(jsonResponse({ path: "/work/README.md", content: "# Readme" }));
		const api = new HttpBackendApi({ fetch: fetchMock });

		expect(await api.listSessions()).toEqual([session]);
		expect(await api.listForkMessages("/sessions/one.jsonl")).toEqual([{ entryId: "entry", text: "hello" }]);
		await api.deleteSession("/sessions/one.jsonl");
		expect(await api.browseDirectory("/work folder")).toEqual({
			path: "/work",
			dirs: [{ name: "src", path: "/work/src" }],
		});
		expect(await api.createDirectory("/work", "new-project")).toEqual({
			name: "new-project",
			path: "/work/new-project",
		});
		expect(await api.getRawSession("/sessions/one.jsonl")).toContain("session");
		expect(await api.getFileContent("/sessions/one.jsonl", "/work/README.md")).toEqual({
			path: "/work/README.md",
			content: "# Readme",
		});

		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/sessions");
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions/fork-messages?path=%2Fsessions%2Fone.jsonl");
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/sessions", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/sessions/one.jsonl" }),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/browse?path=%2Fwork%20folder");
		expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/directories", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ parentPath: "/work", name: "new-project" }),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/sessions/raw?path=%2Fsessions%2Fone.jsonl");
		expect(fetchMock).toHaveBeenNthCalledWith(
			7,
			"/api/files/content?sessionPath=%2Fsessions%2Fone.jsonl&path=%2Fwork%2FREADME.md",
			{ cache: "no-store" },
		);
	});

	it("uploads file chunks through the HTTP backend facade", async () => {
		const uploaded = {
			path: "/tmp/pipane-upload-123/archive.zip",
			fileName: "archive.zip",
			mimeType: "application/zip",
			size: 3,
		};
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ uploadId: "upload/one" }, 201))
			.mockResolvedValueOnce(jsonResponse({ nextOffset: 3 }))
			.mockResolvedValueOnce(jsonResponse(uploaded))
			.mockResolvedValueOnce(jsonResponse({ success: true }));
		const api = new HttpBackendApi({ fetch: fetchMock });

		await expect(api.createFileUpload({ fileName: "archive.zip", mimeType: "application/zip", size: 3 }))
			.resolves.toEqual({ uploadId: "upload/one" });
		await expect(api.appendFileUpload({ uploadId: "upload/one", offset: 0, data: "eGl6" }))
			.resolves.toEqual({ nextOffset: 3 });
		await expect(api.completeFileUpload("upload/one")).resolves.toEqual(uploaded);
		await expect(api.abortFileUpload("upload/two")).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/files/uploads", expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ fileName: "archive.zip", mimeType: "application/zip", size: 3 }),
		}));
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/files/uploads/upload%2Fone/chunks", expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ offset: 0, data: "eGl6" }),
		}));
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/files/uploads/upload%2Fone/complete", { method: "POST" });
		expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/files/uploads/upload%2Ftwo", { method: "DELETE" });
	});

	it("maps settings and update operations without exposing fetch to callers", async () => {
		const settings = { path: "/settings.json", exists: true, errors: [], settings: {}, formatted: "{}\n" };
		const validation = { valid: true, errors: [], formatted: "{}\n" };
		const snapshot = { checkedAt: "2026-01-01T00:00:00Z", notices: [] };
		const update = {
			result: { target: "pi", message: "updated", restartRequired: false },
			snapshot,
		};
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(jsonResponse(settings))
			.mockResolvedValueOnce(jsonResponse(validation))
			.mockResolvedValueOnce(jsonResponse(validation))
			.mockResolvedValueOnce(jsonResponse(validation))
			.mockResolvedValueOnce(jsonResponse(snapshot))
			.mockResolvedValueOnce(jsonResponse(update));
		const api = new HttpBackendApi({ fetch: fetchMock });

		expect(await api.getLocalSettings()).toEqual(settings);
		expect(await api.validateLocalSettings("{}")).toEqual(validation);
		expect(await api.patchLocalSettings({ appearance: { darkMode: "dark" } })).toEqual(validation);
		expect(await api.saveLocalSettings("{}")).toEqual(validation);
		expect(await api.getUpdates()).toEqual(snapshot);
		expect(await api.runUpdate("pi")).toEqual(update);

		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/settings/local/validate", expect.objectContaining({ method: "POST" }));
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/settings/local", expect.objectContaining({ method: "PATCH" }));
		expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/settings/local", expect.objectContaining({ method: "PUT" }));
		expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/updates", { cache: "no-store" });
		expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/updates/pi", {
			method: "POST",
			headers: { "X-Pipane-Action": "update" },
		});
	});

	it("returns structured validation failures and throws useful request errors", async () => {
		const invalid = { valid: false, errors: ["bad setting"] };
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(jsonResponse(invalid, 400))
			.mockResolvedValueOnce(jsonResponse({ error: "not allowed" }, 403))
			.mockResolvedValueOnce(new Response("not json", { status: 500 }));
		const api = new HttpBackendApi({ fetch: fetchMock });

		expect(await api.validateLocalSettings("bad")).toEqual(invalid);
		await expect(api.listSessions()).rejects.toEqual(
			expect.objectContaining<Partial<BackendApiError>>({ message: "not allowed", status: 403 }),
		);
		await expect(api.getRawSession("/missing.jsonl")).rejects.toEqual(
			expect.objectContaining<Partial<BackendApiError>>({ message: "Failed to load raw session", status: 500 }),
		);
	});
});

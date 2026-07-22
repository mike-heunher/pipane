import { describe, expect, it } from "vitest";
import {
	BACKEND_PROTOCOL_VERSION,
	decodeBackendRequest,
	decodeBackendResponse,
	encodeBackendFrame,
	isBackendProtocolFrame,
} from "./backend-protocol.js";

describe("semantic backend protocol", () => {
	it.each([
		["backend.capabilities", {}],
		["sessions.list", {}],
		["sessions.delete", { sessionPath: "/sessions/a.jsonl" }],
		["sessions.forkMessages", { sessionPath: "/sessions/a.jsonl" }],
		["sessions.raw", { sessionPath: "/sessions/a.jsonl" }],
		["files.read", { sessionPath: "/sessions/a.jsonl", path: "README.md" }],
		["files.upload.create", { fileName: "archive.zip", mimeType: "application/zip", size: 3 }],
		["files.upload.append", { uploadId: "upload-1", offset: 0, data: "eGl6" }],
		["files.upload.complete", { uploadId: "upload-1" }],
		["host.browse", { path: "/tmp" }],
		["host.mkdir", { parentPath: "/tmp", name: "new-project" }],
		["settings.get", {}],
		["settings.validate", { content: "{}" }],
		["settings.patch", { patch: { appearance: {} } }],
		["settings.save", { content: "{}" }],
		["updates.get", {}],
		["updates.run", { target: "pi" }],
	])("accepts %s requests", (method, params) => {
		const raw = JSON.stringify({ v: BACKEND_PROTOCOL_VERSION, kind: "request", id: "r1", method, params });
		expect(decodeBackendRequest(raw).ok).toBe(true);
		expect(isBackendProtocolFrame(raw)).toBe(true);
	});

	it("rejects malformed, unknown, cross-version, and over-permissive requests", () => {
		for (const raw of [
			"not json",
			JSON.stringify({ v: 1, kind: "request", id: "r", method: "sessions.list", params: {} }),
			JSON.stringify({ v: 2, kind: "request", id: "r", method: "unknown", params: {} }),
			JSON.stringify({ v: 2, kind: "request", id: "r", method: "sessions.list", params: { extra: true } }),
			JSON.stringify({ v: 2, kind: "request", id: "r", method: "sessions.delete", params: {} }),
			JSON.stringify({ v: 2, kind: "request", id: "r", method: "files.upload.create", params: { fileName: "x", mimeType: "x", size: -1 } }),
			JSON.stringify({ v: 2, kind: "request", id: "r", method: "files.upload.append", params: { uploadId: "u", offset: 0, data: "" } }),
			JSON.stringify({ v: 2, kind: "request", id: "r", method: "host.mkdir", params: { parentPath: "/tmp", name: "" } }),
		]) expect(decodeBackendRequest(raw).ok).toBe(false);
	});

	it("round-trips success and structured error responses", () => {
		const success = encodeBackendFrame({
			v: BACKEND_PROTOCOL_VERSION,
			kind: "response",
			id: "r1",
			method: "sessions.list",
			success: true,
			result: [],
		});
		expect(decodeBackendResponse(success)).toEqual({
			ok: true,
			value: expect.objectContaining({ id: "r1", success: true, result: [] }),
		});
		const failure = encodeBackendFrame({
			v: BACKEND_PROTOCOL_VERSION,
			kind: "response",
			id: "r2",
			method: "sessions.delete",
			success: false,
			error: { code: "not_found", message: "gone" },
		});
		expect(decodeBackendResponse(failure)).toEqual({
			ok: true,
			value: expect.objectContaining({ id: "r2", success: false }),
		});
	});
});

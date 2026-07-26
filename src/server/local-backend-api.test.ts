// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackendApi } from "./local-backend-api.js";
import { UPLOADED_IMAGE_PROMPT_FEATURE } from "../shared/backend-api.js";
import { SessionPathGuard } from "./session-path.js";

const temporaryDirectories: string[] = [];

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "pipane-delete-session-"));
	temporaryDirectories.push(root);
	return {
		root,
		api: new LocalBackendApi({ sessionPaths: new SessionPathGuard(root) }),
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("LocalBackendApi uploaded images", () => {
	it("materializes only exact completed image uploads for Pi RPC", async () => {
		const { root } = fixture();
		const api = new LocalBackendApi({
			sessionPaths: new SessionPathGuard(root),
			uploadDirectory: root,
			backendId: "b_test",
		});
		expect((await api.getCapabilities()).features).toContain(UPLOADED_IMAGE_PROMPT_FEATURE);
		const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
		const { uploadId } = await api.createFileUpload({
			fileName: "photo.png",
			mimeType: "image/png",
			size: bytes.length,
		});
		await api.appendFileUpload({ uploadId, offset: 0, data: bytes.toString("base64") });
		const completed = await api.completeFileUpload(uploadId);

		await expect(api.materializeUploadedImage(completed.path, "image/png")).resolves.toEqual({
			type: "image",
			data: bytes.toString("base64"),
			mimeType: "image/png",
		});
		await expect(api.materializeUploadedImage(path.join(root, "other.png"), "image/png"))
			.rejects.toThrow("not found");
		await expect(api.materializeUploadedImage(completed.path, "image/jpeg"))
			.rejects.toThrow("MIME type does not match");
	});
});

describe("LocalBackendApi session deletion", () => {
	it("is idempotent when a confined session is already absent", async () => {
		const { root, api } = fixture();
		await expect(api.deleteSession(path.join(root, "missing.jsonl"))).resolves.toBeUndefined();
	});

	it("tolerates another deletion winning after path validation", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pipane-delete-session-race-"));
		temporaryDirectories.push(root);
		const sessionPath = path.join(root, "session.jsonl");
		writeFileSync(sessionPath, "");
		const api = new LocalBackendApi({
			sessionPaths: new SessionPathGuard(root),
			runSessionMutation: async (resolved, _operation, mutation) => {
				await unlink(resolved);
				await mutation();
			},
		});

		await expect(api.deleteSession(sessionPath)).resolves.toBeUndefined();
	});

	it("still rejects paths outside the session root", async () => {
		const { api } = fixture();
		await expect(api.deleteSession("/tmp/outside.jsonl")).rejects.toThrow(
			"within the Pi sessions directory",
		);
	});
});

import { describe, expect, it, vi } from "vitest";
import { uploadAttachmentFile } from "./file-upload.js";

function attachment(bytes: Uint8Array) {
	return {
		id: "file",
		type: "document" as const,
		fileName: "archive.bin",
		mimeType: "application/octet-stream",
		size: bytes.length,
		content: Buffer.from(bytes).toString("base64"),
	};
}

describe("uploadAttachmentFile", () => {
	it("chunks arbitrary binary data and completes the backend upload", async () => {
		const bytes = Buffer.alloc(200_000);
		for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
		const chunks: Array<{ offset: number; data: string }> = [];
		const api = {
			createFileUpload: vi.fn(async () => ({ uploadId: "u1" })),
			appendFileUpload: vi.fn(async ({ offset, data }: { offset: number; data: string }) => {
				chunks.push({ offset, data });
				return { nextOffset: offset + Buffer.from(data, "base64").length };
			}),
			completeFileUpload: vi.fn(async () => ({
				path: "/tmp/pipane-upload-test/archive.bin",
				fileName: "archive.bin",
				mimeType: "application/octet-stream",
				size: bytes.length,
			})),
			abortFileUpload: vi.fn(async () => undefined),
		};

		await expect(uploadAttachmentFile(api, attachment(bytes))).resolves.toMatchObject({
			path: "/tmp/pipane-upload-test/archive.bin",
		});
		expect(chunks.length).toBeGreaterThan(1);
		const reconstructed = Buffer.concat(
			chunks.sort((left, right) => left.offset - right.offset).map((chunk) => Buffer.from(chunk.data, "base64")),
		);
		expect(reconstructed.equals(bytes)).toBe(true);
		expect(api.completeFileUpload).toHaveBeenCalledWith("u1");
	});

	it("completes empty files without sending a chunk", async () => {
		const api = {
			createFileUpload: vi.fn(async () => ({ uploadId: "empty" })),
			appendFileUpload: vi.fn(),
			completeFileUpload: vi.fn(async () => ({
				path: "/tmp/empty",
				fileName: "archive.bin",
				mimeType: "application/octet-stream",
				size: 0,
			})),
			abortFileUpload: vi.fn(async () => undefined),
		};

		await uploadAttachmentFile(api, attachment(new Uint8Array()));
		expect(api.appendFileUpload).not.toHaveBeenCalled();
	});

	it("aborts the backend upload while preserving the original failure", async () => {
		const failure = new Error("chunk failed");
		const api = {
			createFileUpload: vi.fn(async () => ({ uploadId: "failed" })),
			appendFileUpload: vi.fn(async () => { throw failure; }),
			completeFileUpload: vi.fn(),
			abortFileUpload: vi.fn(async () => undefined),
		};

		await expect(uploadAttachmentFile(api, attachment(Buffer.from("data")))).rejects.toBe(failure);
		expect(api.abortFileUpload).toHaveBeenCalledWith("failed");
	});
});

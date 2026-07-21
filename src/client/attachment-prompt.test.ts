import { describe, expect, it } from "vitest";
import { buildAttachmentPromptPayload } from "./attachment-prompt.js";
import type { Attachment } from "./ui/utils/attachment-utils.js";

function attachment(overrides: Partial<Attachment>): Attachment {
	return {
		id: "attachment",
		type: "document",
		fileName: "file.bin",
		mimeType: "application/octet-stream",
		size: 3,
		content: "YWJj",
		...overrides,
	};
}

describe("buildAttachmentPromptPayload", () => {
	it("hands backend-local paths to the agent while keeping images direct", () => {
		const payload = buildAttachmentPromptPayload("Inspect these", [
			attachment({ uploadedPath: "/tmp/pipane-upload-abc/archive.zip" }),
			attachment({
				id: "image",
				type: "image",
				fileName: "photo.png",
				mimeType: "image/png",
				content: "aW1hZ2U=",
			}),
		]);

		expect(payload.input).toContain("Inspect these");
		expect(payload.input).toContain(JSON.stringify("/tmp/pipane-upload-abc/archive.zip"));
		expect(payload.images).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
	});

	it("keeps extracted text as a fallback for an older draft without an upload path", () => {
		expect(buildAttachmentPromptPayload("", [attachment({ extractedText: "legacy text" })])).toEqual({
			input: "legacy text",
			images: undefined,
		});
	});
});

import type { WireImage } from "../shared/ws-protocol.js";
import type { Attachment } from "./ui/utils/attachment-utils.js";

export interface AttachmentPromptPayload {
	input: string;
	images: WireImage[] | undefined;
}

export function buildAttachmentPromptPayload(
	input: string,
	attachments: readonly Attachment[] = [],
): AttachmentPromptPayload {
	const images: WireImage[] = [];
	const uploadedPaths: string[] = [];
	const legacyDocumentText: string[] = [];

	for (const attachment of attachments) {
		if (attachment.type === "image") {
			images.push(attachment.uploadedPath
				? { type: "image", uploadedPath: attachment.uploadedPath, mimeType: attachment.mimeType }
				: { type: "image", data: attachment.content, mimeType: attachment.mimeType });
		} else if (attachment.uploadedPath) {
			uploadedPaths.push(attachment.uploadedPath);
		} else if (attachment.extractedText) {
			// Keep drafts produced before backend uploads were available usable.
			legacyDocumentText.push(attachment.extractedText);
		}
	}

	const additions: string[] = [];
	if (uploadedPaths.length > 0) {
		additions.push([
			"Uploaded files are available on the backend filesystem at these paths:",
			...uploadedPaths.map((uploadedPath) => `- ${JSON.stringify(uploadedPath)}`),
		].join("\n"));
	}
	additions.push(...legacyDocumentText);

	return {
		input: additions.length > 0
			? (input ? `${input}\n\n${additions.join("\n\n")}` : additions.join("\n\n"))
			: input,
		images: images.length > 0 ? images : undefined,
	};
}

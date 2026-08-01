import type { BackendApi, FileUploadResponse } from "../shared/backend-api.js";
import type { Attachment } from "./ui/utils/attachment-utils.js";

// Keep each encoded request comfortably below common WebRTC DataChannel
// message limits while still amortizing request overhead.
const BASE64_CHARS_PER_CHUNK = 192 * 1024;
const PARALLEL_UPLOAD_CHUNKS = 4;

type FileUploadApi = Pick<
	BackendApi,
	"createFileUpload" | "appendFileUpload" | "completeFileUpload" | "abortFileUpload"
>;

export async function uploadAttachmentFile(
	api: FileUploadApi,
	attachment: Attachment,
): Promise<FileUploadResponse> {
	const { uploadId } = await api.createFileUpload({
		fileName: attachment.fileName,
		mimeType: attachment.mimeType || "application/octet-stream",
		size: attachment.size,
	});
	if (!uploadId) throw new Error("Backend did not create a file upload");

	try {
		let offset = 0;
		let pending: Array<Promise<void>> = [];
		for (let index = 0; index < attachment.content.length; index += BASE64_CHARS_PER_CHUNK) {
			const data = attachment.content.slice(index, index + BASE64_CHARS_PER_CHUNK);
			const nextOffset = offset + decodedBase64Length(data);
			const chunkOffset = offset;
			pending.push(api.appendFileUpload({ uploadId, offset: chunkOffset, data }).then((response) => {
				if (response.nextOffset !== nextOffset) {
					throw new Error(`Backend acknowledged an unexpected file offset (${response.nextOffset})`);
				}
			}));
			offset = nextOffset;
			if (pending.length === PARALLEL_UPLOAD_CHUNKS) {
				await Promise.all(pending);
				pending = [];
			}
		}
		await Promise.all(pending);
		if (offset !== attachment.size) {
			throw new Error(`Attachment size does not match its encoded content (${offset} !== ${attachment.size})`);
		}

		const uploaded = await api.completeFileUpload(uploadId);
		if (!uploaded.path || uploaded.size !== attachment.size) {
			throw new Error("Backend returned invalid uploaded file metadata");
		}
		return uploaded;
	} catch (error) {
		try {
			await api.abortFileUpload(uploadId);
		} catch {
			// Older backends may not implement abort; preserve the original failure.
		}
		throw error;
	}
}

function decodedBase64Length(data: string): number {
	if (data.length % 4 !== 0) throw new Error("Attachment content is not valid base64");
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

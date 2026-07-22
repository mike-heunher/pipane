const CHUNK_MARKER = 1 as const;
const CHUNK_PREFIX = `{"__pipaneDataChannelChunk":${CHUNK_MARKER},`;

/** Keep physical messages below conservative browser/libdatachannel SCTP limits. */
export const DATA_CHANNEL_CHUNK_PAYLOAD_BYTES = 12_000;
export const MAX_DATA_CHANNEL_MESSAGE_BYTES = 16 * 1024;
export const MAX_DATA_CHANNEL_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_DATA_CHANNEL_PENDING_FRAMES = 4;
export const MAX_DATA_CHANNEL_QUEUED_BYTES = 96 * 1024 * 1024;
export const DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
export const DATA_CHANNEL_BUFFER_LOW_WATER_BYTES = 256 * 1024;

interface DataChannelChunk {
	__pipaneDataChannelChunk: typeof CHUNK_MARKER;
	id: string;
	index: number;
	total: number;
	data: string;
}

interface PendingFrame {
	total: number;
	nextIndex: number;
	byteLength: number;
	chunks: Uint8Array[];
}

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_CHUNKS_PER_FRAME = Math.ceil(MAX_DATA_CHANNEL_FRAME_BYTES / DATA_CHANNEL_CHUNK_PAYLOAD_BYTES);
const CHUNK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Encode one logical text frame into conservatively sized DataChannel messages. */
export function encodeDataChannelFrame(frame: string, id: string): string[] {
	if (!CHUNK_ID_PATTERN.test(id)) throw new Error("DataChannel frame id is invalid");
	const bytes = textEncoder.encode(frame);
	if (bytes.byteLength > MAX_DATA_CHANNEL_FRAME_BYTES) throw new Error("DataChannel frame exceeds the reassembly limit");
	if (bytes.byteLength <= DATA_CHANNEL_CHUNK_PAYLOAD_BYTES) return [frame];

	const total = Math.ceil(bytes.byteLength / DATA_CHANNEL_CHUNK_PAYLOAD_BYTES);
	const messages: string[] = [];
	for (let index = 0; index < total; index++) {
		const start = index * DATA_CHANNEL_CHUNK_PAYLOAD_BYTES;
		const chunk: DataChannelChunk = {
			__pipaneDataChannelChunk: CHUNK_MARKER,
			id,
			index,
			total,
			data: encodeBase64(bytes.subarray(start, start + DATA_CHANNEL_CHUNK_PAYLOAD_BYTES)),
		};
		const message = JSON.stringify(chunk);
		if (textEncoder.encode(message).byteLength > MAX_DATA_CHANNEL_MESSAGE_BYTES) {
			throw new Error("Encoded DataChannel chunk exceeds the physical message limit");
		}
		messages.push(message);
	}
	return messages;
}

/** Reassemble carrier chunks while passing ordinary application frames through unchanged. */
export class DataChannelFrameDecoder {
	private readonly pending = new Map<string, PendingFrame>();

	accept(message: string): string | undefined {
		if (!message.startsWith(CHUNK_PREFIX)) return message;
		try {
			const chunk = parseChunk(message);
			let pending = this.pending.get(chunk.id);
			if (!pending) {
				if (chunk.index !== 0) throw new Error("DataChannel chunk sequence does not start at zero");
				if (this.pending.size >= MAX_DATA_CHANNEL_PENDING_FRAMES) throw new Error("Too many DataChannel frames are pending");
				pending = { total: chunk.total, nextIndex: 0, byteLength: 0, chunks: [] };
				this.pending.set(chunk.id, pending);
			}
			if (pending.total !== chunk.total || chunk.index !== pending.nextIndex) {
				throw new Error("DataChannel chunks are inconsistent or out of order");
			}

			const bytes = decodeBase64(chunk.data);
			if (bytes.byteLength === 0 || bytes.byteLength > DATA_CHANNEL_CHUNK_PAYLOAD_BYTES) {
				throw new Error("DataChannel chunk payload size is invalid");
			}
			pending.byteLength += bytes.byteLength;
			if (pending.byteLength > MAX_DATA_CHANNEL_FRAME_BYTES) throw new Error("DataChannel frame exceeds the reassembly limit");
			pending.chunks.push(bytes);
			pending.nextIndex++;
			if (pending.nextIndex < pending.total) return undefined;

			this.pending.delete(chunk.id);
			const assembled = new Uint8Array(pending.byteLength);
			let offset = 0;
			for (const part of pending.chunks) {
				assembled.set(part, offset);
				offset += part.byteLength;
			}
			return fatalTextDecoder.decode(assembled);
		} catch (error) {
			this.pending.clear();
			throw error;
		}
	}

	reset(): void {
		this.pending.clear();
	}
}

function parseChunk(message: string): DataChannelChunk {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		throw new Error("DataChannel chunk is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DataChannel chunk must be an object");
	const chunk = value as Record<string, unknown>;
	if (chunk.__pipaneDataChannelChunk !== CHUNK_MARKER
		|| typeof chunk.id !== "string" || !CHUNK_ID_PATTERN.test(chunk.id)
		|| !Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0
		|| !Number.isSafeInteger(chunk.total) || (chunk.total as number) < 2 || (chunk.total as number) > MAX_CHUNKS_PER_FRAME
		|| (chunk.index as number) >= (chunk.total as number)
		|| typeof chunk.data !== "string") {
		throw new Error("DataChannel chunk envelope is invalid");
	}
	return chunk as unknown as DataChannelChunk;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
	}
	return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
	if (!BASE64_PATTERN.test(value)) throw new Error("DataChannel chunk payload is not valid base64");
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		throw new Error("DataChannel chunk payload is not valid base64");
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	if (encodeBase64(bytes) !== value) throw new Error("DataChannel chunk payload is not canonical base64");
	return bytes;
}

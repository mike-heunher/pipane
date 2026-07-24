import { gunzipSync, gzipSync } from "fflate";

const CHUNK_MARKER = 1 as const;
const CANCEL_MARKER = 1 as const;
const CHUNK_PREFIX = `{"__pipaneDataChannelChunk":${CHUNK_MARKER},`;
const CANCEL_PREFIX = `{"__pipaneDataChannelCancel":${CANCEL_MARKER},`;
const GZIP_ENCODING = "gzip" as const;

/** Keep physical messages below conservative browser/libdatachannel SCTP limits. */
export const DATA_CHANNEL_CHUNK_PAYLOAD_BYTES = 12_000;
export const MAX_DATA_CHANNEL_MESSAGE_BYTES = 16 * 1024;
export const MAX_DATA_CHANNEL_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_DATA_CHANNEL_PENDING_FRAMES = 4;
export const MAX_DATA_CHANNEL_QUEUED_BYTES = 96 * 1024 * 1024;
export const DATA_CHANNEL_BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
export const DATA_CHANNEL_BUFFER_LOW_WATER_BYTES = 256 * 1024;

export type DataChannelFrameCompressor = (bytes: Uint8Array) => Uint8Array;

interface DataChannelChunk {
	__pipaneDataChannelChunk: typeof CHUNK_MARKER;
	id: string;
	index: number;
	total: number;
	/** Present when the reassembled bytes must be decompressed before UTF-8 decoding. */
	encoding?: typeof GZIP_ENCODING;
	data: string;
}

interface DataChannelCancel {
	__pipaneDataChannelCancel: typeof CANCEL_MARKER;
	id: string;
}

interface PendingFrame {
	total: number;
	nextIndex: number;
	byteLength: number;
	encoding?: typeof GZIP_ENCODING;
	chunks: Uint8Array[];
}

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_CHUNKS_PER_FRAME = Math.ceil(MAX_DATA_CHANNEL_FRAME_BYTES / DATA_CHANNEL_CHUNK_PAYLOAD_BYTES);
const CHUNK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * Encode one logical text frame into conservatively sized carrier messages.
 * Large frames are gzip-compressed when that reduces bytes before base64 and
 * physical chunk overhead. Small frames remain plain for minimal latency.
 */
export function encodeDataChannelFrame(
	frame: string,
	id: string,
	compress: DataChannelFrameCompressor = defaultCompress,
): string[] {
	if (!CHUNK_ID_PATTERN.test(id)) throw new Error("DataChannel frame id is invalid");
	const original = textEncoder.encode(frame);
	if (original.byteLength > MAX_DATA_CHANNEL_FRAME_BYTES) throw new Error("DataChannel frame exceeds the reassembly limit");
	if (original.byteLength <= DATA_CHANNEL_CHUNK_PAYLOAD_BYTES) return [frame];

	const compressed = compress(original);
	const useCompression = compressed.byteLength + 128 < original.byteLength;
	const bytes = useCompression ? compressed : original;
	const total = Math.ceil(bytes.byteLength / DATA_CHANNEL_CHUNK_PAYLOAD_BYTES);
	const messages: string[] = [];
	for (let index = 0; index < total; index++) {
		const start = index * DATA_CHANNEL_CHUNK_PAYLOAD_BYTES;
		const chunk: DataChannelChunk = {
			__pipaneDataChannelChunk: CHUNK_MARKER,
			id,
			index,
			total,
			...(useCompression ? { encoding: GZIP_ENCODING } : {}),
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

function defaultCompress(bytes: Uint8Array): Uint8Array {
	return gzipSync(bytes, { level: 3 });
}

/** Cancel one incomplete logical frame without exposing a carrier envelope upstream. */
export function encodeDataChannelFrameCancellation(id: string): string {
	if (!CHUNK_ID_PATTERN.test(id)) throw new Error("DataChannel frame id is invalid");
	return JSON.stringify({ __pipaneDataChannelCancel: CANCEL_MARKER, id } satisfies DataChannelCancel);
}

/** Reassemble carrier chunks while passing ordinary application frames through unchanged. */
export class DataChannelFrameDecoder {
	private readonly pending = new Map<string, PendingFrame>();

	accept(message: string): string | undefined {
		if (!message.startsWith(CHUNK_PREFIX) && !message.startsWith(CANCEL_PREFIX)) return message;
		try {
			if (message.startsWith(CANCEL_PREFIX)) {
				this.pending.delete(parseCancel(message).id);
				return undefined;
			}
			const chunk = parseChunk(message);
			let pending = this.pending.get(chunk.id);
			if (!pending) {
				if (chunk.index !== 0) throw new Error("DataChannel chunk sequence does not start at zero");
				if (this.pending.size >= MAX_DATA_CHANNEL_PENDING_FRAMES) throw new Error("Too many DataChannel frames are pending");
				pending = {
					total: chunk.total,
					nextIndex: 0,
					byteLength: 0,
					...(chunk.encoding ? { encoding: chunk.encoding } : {}),
					chunks: [],
				};
				this.pending.set(chunk.id, pending);
			}
			if (pending.total !== chunk.total
				|| pending.encoding !== chunk.encoding
				|| chunk.index !== pending.nextIndex) {
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
			if (!pending.encoding) return fatalTextDecoder.decode(assembled);
			if (gzipUncompressedSize(assembled) > MAX_DATA_CHANNEL_FRAME_BYTES) {
				throw new Error("Compressed DataChannel frame exceeds the reassembly limit");
			}
			const decompressed = gunzipSync(assembled);
			if (decompressed.byteLength > MAX_DATA_CHANNEL_FRAME_BYTES) {
				throw new Error("Compressed DataChannel frame exceeds the reassembly limit");
			}
			return fatalTextDecoder.decode(decompressed);
		} catch (error) {
			this.pending.clear();
			throw error;
		}
	}

	reset(): void {
		this.pending.clear();
	}
}

function parseCancel(message: string): DataChannelCancel {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		throw new Error("DataChannel cancellation is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("DataChannel cancellation must be an object");
	}
	const cancellation = value as Record<string, unknown>;
	if (cancellation.__pipaneDataChannelCancel !== CANCEL_MARKER
		|| typeof cancellation.id !== "string" || !CHUNK_ID_PATTERN.test(cancellation.id)) {
		throw new Error("DataChannel cancellation envelope is invalid");
	}
	return cancellation as unknown as DataChannelCancel;
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
		|| !Number.isSafeInteger(chunk.total) || (chunk.total as number) < 1 || (chunk.total as number) > MAX_CHUNKS_PER_FRAME
		|| (chunk.index as number) >= (chunk.total as number)
		|| (chunk.encoding !== undefined && chunk.encoding !== GZIP_ENCODING)
		|| ((chunk.total as number) === 1 && chunk.encoding !== GZIP_ENCODING)
		|| typeof chunk.data !== "string") {
		throw new Error("DataChannel chunk envelope is invalid");
	}
	return chunk as unknown as DataChannelChunk;
}

/** Read gzip ISIZE before allocating the decompressed result. */
function gzipUncompressedSize(bytes: Uint8Array): number {
	if (bytes.byteLength < 4) throw new Error("Compressed DataChannel frame is malformed");
	const offset = bytes.byteLength - 4;
	return (bytes[offset]
		| (bytes[offset + 1] << 8)
		| (bytes[offset + 2] << 16)
		| (bytes[offset + 3] << 24)) >>> 0;
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

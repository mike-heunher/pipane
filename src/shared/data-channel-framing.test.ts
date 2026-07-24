import { describe, expect, it } from "vitest";
import {
	DATA_CHANNEL_CHUNK_PAYLOAD_BYTES,
	DataChannelFrameDecoder,
	MAX_DATA_CHANNEL_MESSAGE_BYTES,
	encodeDataChannelFrame,
	encodeDataChannelFrameCancellation,
} from "./data-channel-framing.js";

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function noisyText(length: number): string {
	let state = 0x12345678;
	let value = "";
	for (let index = 0; index < length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		value += String.fromCharCode(32 + ((state >>> 0) % 95));
	}
	return value;
}

describe("DataChannel carrier framing", () => {
	it("passes small frames through without an envelope", () => {
		const frame = JSON.stringify({ protocolVersion: 1, type: "abort" });
		expect(encodeDataChannelFrame(frame, "f1")).toEqual([frame]);
		expect(new DataChannelFrameDecoder().accept(frame)).toBe(frame);
	});

	it("compresses and exactly reassembles large Unicode frames", () => {
		const frame = JSON.stringify({ type: "session_sync", content: "🙂 café 漢字\n".repeat(4_000) });
		const messages = encodeDataChannelFrame(frame, "large_1");
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages.reduce((total, message) => total + byteLength(message), 0)).toBeLessThan(byteLength(frame));
		expect(messages.every((message) => byteLength(message) <= MAX_DATA_CHANNEL_MESSAGE_BYTES)).toBe(true);

		const decoder = new DataChannelFrameDecoder();
		for (const message of messages.slice(0, -1)) expect(decoder.accept(message)).toBeUndefined();
		expect(decoder.accept(messages.at(-1)!)).toBe(frame);
	});

	it("fragments large incompressible frames", () => {
		const frame = noisyText(DATA_CHANNEL_CHUNK_PAYLOAD_BYTES * 4);
		const messages = encodeDataChannelFrame(frame, "noisy");
		expect(messages.length).toBeGreaterThan(1);
		const decoder = new DataChannelFrameDecoder();
		let decoded: string | undefined;
		for (const message of messages) decoded = decoder.accept(message) ?? decoded;
		expect(decoded).toBe(frame);
	});

	it("drops a cancelled partial frame and accepts a later logical frame", () => {
		const decoder = new DataChannelFrameDecoder();
		const abandonedFrame = noisyText(DATA_CHANNEL_CHUNK_PAYLOAD_BYTES * 4);
		const abandoned = encodeDataChannelFrame(abandonedFrame, "abandoned");
		expect(decoder.accept(abandoned[0])).toBeUndefined();
		expect(decoder.accept(encodeDataChannelFrameCancellation("abandoned"))).toBeUndefined();
		expect(decoder.accept("control-frame")).toBe("control-frame");
		const replacementFrame = noisyText(DATA_CHANNEL_CHUNK_PAYLOAD_BYTES * 4 + 1);
		const replacement = encodeDataChannelFrame(replacementFrame, "replacement");
		let decoded: string | undefined;
		for (const message of replacement) decoded = decoder.accept(message) ?? decoded;
		expect(decoded).toBe(replacementFrame);
	});

	it("keeps every payload below the physical message limit", () => {
		const frame = noisyText(DATA_CHANNEL_CHUNK_PAYLOAD_BYTES * 4);
		const messages = encodeDataChannelFrame(frame, "boundary");
		expect(messages.length).toBeGreaterThan(1);
		expect(Math.max(...messages.map(byteLength))).toBeLessThanOrEqual(MAX_DATA_CHANNEL_MESSAGE_BYTES);
	});

	it("rejects malformed, out-of-order, and oversized chunk sequences", () => {
		const frame = noisyText(DATA_CHANNEL_CHUNK_PAYLOAD_BYTES * 4);
		const messages = encodeDataChannelFrame(frame, "ordered");
		const decoder = new DataChannelFrameDecoder();
		expect(() => decoder.accept(messages[1])).toThrow("start at zero");
		expect(() => decoder.accept('{"__pipaneDataChannelChunk":1,"id":"x","index":0,"total":2,"data":"***"}'))
			.toThrow("base64");
		expect(() => decoder.accept('{"__pipaneDataChannelChunk":1,"id":"x","index":0,"total":999999,"data":"eA=="}'))
			.toThrow("envelope");
	});
});

import { describe, expect, it } from "vitest";
import {
	extensionStatusSnapshot,
	isValidExtensionStatusKey,
	normalizeExtensionNotificationText,
	normalizeExtensionStatusText,
	providerForUsageStatus,
} from "./extension-status.js";

describe("extension status normalization", () => {
	it("strips ANSI and unsafe control characters and flattens whitespace", () => {
		expect(normalizeExtensionStatusText("\u001b[39m codex\t25%\n5h\u0000"))
			.toBe("codex 25% 5h");
	});

	it("limits untrusted status text", () => {
		expect(normalizeExtensionStatusText("x".repeat(600))).toHaveLength(512);
	});

	it("preserves safe notification line breaks while stripping terminal controls", () => {
		expect(normalizeExtensionNotificationText("\u001b[39mUsage\r\n  5h: 20%\u0000"))
			.toBe("Usage\n  5h: 20%");
	});

	it("validates stable non-control keys", () => {
		expect(isValidExtensionStatusKey("provider-usage")).toBe(true);
		expect(isValidExtensionStatusKey("")).toBe(false);
		expect(isValidExtensionStatusKey("bad\nkey")).toBe(false);
		expect(isValidExtensionStatusKey("x".repeat(129))).toBe(false);
	});

	it("creates a complete serializable snapshot", () => {
		expect(extensionStatusSnapshot(new Map([["usage", "codex 25% 5h"]])))
			.toEqual({ usage: "codex 25% 5h" });
	});

	it("recognizes successful provider usage without treating transient text as usage", () => {
		expect(providerForUsageStatus("codex 25% 5h")).toBe("codex");
		expect(providerForUsageStatus("claude 18% 5h 42% 7d")).toBe("anthropic");
		expect(providerForUsageStatus("Anthropic 10% extra")).toBe("anthropic");
		expect(providerForUsageStatus("checking")).toBeUndefined();
		expect(providerForUsageStatus("usage error")).toBeUndefined();
	});
});

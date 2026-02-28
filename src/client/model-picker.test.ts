import { describe, it, expect, vi } from "vitest";
import { selectModelFromAvailable } from "./model-picker.js";

describe("selectModelFromAvailable", () => {
	it("returns null when there are no available models", async () => {
		const promptFn = vi.fn();
		const selected = await selectModelFromAvailable([], undefined, promptFn as any);
		expect(selected).toBeNull();
		expect(promptFn).not.toHaveBeenCalled();
	});

	it("selects from server-provided models only", async () => {
		const models = [
			{ provider: "anthropic", id: "claude-sonnet-4-20250514" },
			{ provider: "openai", id: "gpt-5-codex" },
		];
		const promptFn = vi.fn().mockResolvedValue("2");
		const selected = await selectModelFromAvailable(models as any, models[0] as any, promptFn as any);
		expect(selected).toEqual(models[1]);
	});

	it("returns null on invalid selection", async () => {
		const models = [{ provider: "anthropic", id: "claude-sonnet-4-20250514" }];
		const promptFn = vi.fn().mockResolvedValue("999");
		const selected = await selectModelFromAvailable(models as any, undefined, promptFn as any);
		expect(selected).toBeNull();
	});
});

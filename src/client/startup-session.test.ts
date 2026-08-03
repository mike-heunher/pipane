import { describe, expect, it, vi } from "vitest";
import { loadStartupSession, saveStartupSession } from "./startup-session.js";

describe("startup session selection", () => {
	it("round-trips a backend-scoped last session", () => {
		let value: string | null = null;
		const storage = {
			getItem: vi.fn(() => value),
			setItem: vi.fn((_key: string, next: string) => { value = next; }),
		};
		saveStartupSession({ backendId: "backend-one", path: "/sessions/one.jsonl", cwd: "/work/one" }, storage);
		expect(loadStartupSession(storage)).toEqual({
			backendId: "backend-one",
			path: "/sessions/one.jsonl",
			cwd: "/work/one",
		});
	});

	it("rejects malformed, relative, and oversized stored values", () => {
		expect(loadStartupSession({ getItem: () => "not-json" })).toBeUndefined();
		expect(loadStartupSession({ getItem: () => JSON.stringify({ path: "relative.jsonl" }) })).toBeUndefined();
		expect(loadStartupSession({ getItem: () => JSON.stringify({ path: `/${"x".repeat(20_000)}` }) })).toBeUndefined();
	});
});

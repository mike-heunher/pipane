/** @vitest-environment node */

import { afterEach, describe, it, expect, vi } from "vitest";
import { compareSemver, fetchLatestPiRelease, fetchLatestVersion } from "./update-check.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("compareSemver", () => {
	it("returns 0 for equal versions", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	it("returns -1 when a < b (patch)", () => {
		expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
	});

	it("returns 1 when a > b (patch)", () => {
		expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
	});

	it("returns -1 when a < b (minor)", () => {
		expect(compareSemver("1.2.3", "1.3.0")).toBe(-1);
	});

	it("returns 1 when a > b (minor)", () => {
		expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
	});

	it("returns -1 when a < b (major)", () => {
		expect(compareSemver("1.9.9", "2.0.0")).toBe(-1);
	});

	it("returns 1 when a > b (major)", () => {
		expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
	});

	it("handles 0.x versions", () => {
		expect(compareSemver("0.1.0", "0.1.1")).toBe(-1);
		expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
	});
});

describe("remote update checks", () => {
	it("reads npm package versions", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: " 1.2.3 " }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		expect(await fetchLatestVersion("@scope/name")).toBe("1.2.3");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://registry.npmjs.org/%40scope%2Fname/latest",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("reads Pi release metadata", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			version: "0.81.0",
			packageName: "@earendil-works/pi-coding-agent",
			note: "Release note",
		}), { status: 200 })));

		expect(await fetchLatestPiRelease("0.80.0")).toEqual({
			version: "0.81.0",
			packageName: "@earendil-works/pi-coding-agent",
			note: "Release note",
		});
	});

	it("silently ignores invalid responses and network errors", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
		expect(await fetchLatestVersion("pipane")).toBeNull();

		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		expect(await fetchLatestPiRelease("0.80.0")).toBeNull();
	});
});

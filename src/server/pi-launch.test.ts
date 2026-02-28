import { describe, expect, it } from "vitest";
import { resolvePiLaunch } from "./pi-launch";

describe("resolvePiLaunch", () => {
	it("uses pi from PATH by default", () => {
		expect(resolvePiLaunch(undefined)).toEqual({ command: "pi", baseArgs: [] });
	});

	it("uses node for .js cli paths", () => {
		expect(resolvePiLaunch("/tmp/cli.js")).toEqual({
			command: "node",
			baseArgs: ["/tmp/cli.js"],
		});
	});

	it("uses provided binary name directly", () => {
		expect(resolvePiLaunch("pi-dev")).toEqual({ command: "pi-dev", baseArgs: [] });
	});
});

/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	LocalSettingsStore,
	formatSettingsJson,
	normalizeCwdForDisplay,
	applyCwdFilters,
} from "./local-settings.js";

describe("local-settings", () => {
	let tmpDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-web-local-settings-"));
		settingsPath = path.join(tmpDir, ".piweb", "settings.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("uses defaults when no settings file exists", () => {
		const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
		const read = store.read();

		expect(read.exists).toBe(false);
		expect(read.errors).toEqual([]);
		expect(read.settings.version).toBe(1);
		expect(read.settings.sidebar.cwdTitle.filters).toEqual([]);
	});

	it("validates and formats JSON on save", () => {
		const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
		const result = store.save(JSON.stringify({
			version: 1,
			sidebar: {
				cwdTitle: {
					filters: [{ pattern: "^~/dev/", replacement: "dev/" }],
				},
			},
		}));

		expect(result.valid).toBe(true);
		expect(existsSync(settingsPath)).toBe(true);
		const content = readFileSync(settingsPath, "utf8");
		expect(content).toBe(formatSettingsJson(result.settings!));
	});

	it("rejects invalid regex filters", () => {
		const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
		const result = store.validate(JSON.stringify({
			version: 1,
			sidebar: {
				cwdTitle: {
					filters: [{ pattern: "(", replacement: "x" }],
				},
			},
		}));

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("invalid regex");
	});

	it("reloadFromDiskIfValid applies valid external edits", () => {
		const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
		store.save(JSON.stringify({
			version: 1,
			sidebar: { cwdTitle: { filters: [{ pattern: "^~/dev/", replacement: "dev/" }] } },
		}));

		mkdirSync(path.dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({
			version: 1,
			sidebar: { cwdTitle: { filters: [{ pattern: "^~/work/", replacement: "work/" }] } },
		}), "utf8");

		const changed = store.reloadFromDiskIfValid();
		expect(changed).toBe(true);
		expect(store.errors).toEqual([]);
		expect(store.formatCwdTitle(`${tmpDir}/work/app`)).toContain("work/");
	});

	it("reloadFromDiskIfValid ignores invalid external edits and keeps last good config", () => {
		const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
		store.save(JSON.stringify({
			version: 1,
			sidebar: { cwdTitle: { filters: [{ pattern: "^~/dev/", replacement: "dev/" }] } },
		}));

		mkdirSync(path.dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, "{ not-json", "utf8");

		const changed = store.reloadFromDiskIfValid();
		expect(changed).toBe(false);
		expect(store.errors.join("\n")).toContain("Invalid JSON");
		// Last good in-memory config should still be active.
		expect(store.formatCwdTitle(`${tmpDir}/dev/app`)).toContain("dev/");
	});

	it("formats cwd with home prefix replacement and configured filters", () => {
		const store = new LocalSettingsStore({ homeDir: "/Users/me", settingsPath });
		const saved = store.save(JSON.stringify({
			version: 1,
			sidebar: {
				cwdTitle: {
					filters: [
						{ pattern: "^~/dev/", replacement: "dev/" },
						{ pattern: "^dev/pi-web$", replacement: "pi-web (dev)" },
					],
				},
			},
		}));
		expect(saved.valid).toBe(true);

		expect(store.formatCwdTitle("/Users/me/dev/pi-web")).toBe("pi-web (dev)");
		expect(store.formatCwdTitle("/Users/me/work/other")).toBe("~/work/other");
	});

	it("normalizeCwdForDisplay collapses home to tilde", () => {
		expect(normalizeCwdForDisplay("/Users/me", "/Users/me")).toBe("~");
		expect(normalizeCwdForDisplay("/Users/me/dev/app", "/Users/me")).toBe("~/dev/app");
		expect(normalizeCwdForDisplay("/opt/app", "/Users/me")).toBe("/opt/app");
	});

	it("applyCwdFilters applies regex rules in order", () => {
		const out = applyCwdFilters("~/dev/pi-web", [
			{ re: /^~\/dev\//, replacement: "dev/" },
			{ re: /^dev\//, replacement: "workspace/" },
		]);
		expect(out).toBe("workspace/pi-web");
	});
});

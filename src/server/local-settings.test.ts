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
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "pipane-local-settings-"));
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
		expect(read.settings.sidebar.sessionsPerProject).toBe(5);
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
						{ pattern: "^dev/pipane$", replacement: "pipane (dev)" },
					],
				},
			},
		}));
		expect(saved.valid).toBe(true);

		expect(store.formatCwdTitle("/Users/me/dev/pipane")).toBe("pipane (dev)");
		expect(store.formatCwdTitle("/Users/me/work/other")).toBe("~/work/other");
	});

	it("normalizeCwdForDisplay collapses home to tilde", () => {
		expect(normalizeCwdForDisplay("/Users/me", "/Users/me")).toBe("~");
		expect(normalizeCwdForDisplay("/Users/me/dev/app", "/Users/me")).toBe("~/dev/app");
		expect(normalizeCwdForDisplay("/opt/app", "/Users/me")).toBe("/opt/app");
	});

	it("applyCwdFilters applies regex rules in order", () => {
		const out = applyCwdFilters("~/dev/pipane", [
			{ re: /^~\/dev\//, replacement: "dev/" },
			{ re: /^dev\//, replacement: "workspace/" },
		]);
		expect(out).toBe("workspace/pipane");
	});

	describe("appearance settings", () => {
		it("defaults appearance when not specified", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const read = store.read();
			expect(read.settings.appearance).toEqual({
				colorTheme: "default",
				darkMode: "system",
				showTokenUsage: true,
			});
		});

		it("saves and reads appearance settings", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.save(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
				appearance: { colorTheme: "gruvbox", darkMode: "dark", showTokenUsage: false },
			}));
			expect(result.valid).toBe(true);
			expect(result.settings!.appearance).toEqual({
				colorTheme: "gruvbox",
				darkMode: "dark",
				showTokenUsage: false,
			});
		});

		it("rejects invalid colorTheme", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.validate(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
				appearance: { colorTheme: "nope" },
			}));
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("appearance.colorTheme");
		});

		it("rejects invalid darkMode", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.validate(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
				appearance: { darkMode: "nope" },
			}));
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("appearance.darkMode");
		});

		it("rejects non-boolean showTokenUsage", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.validate(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
				appearance: { showTokenUsage: "yes" },
			}));
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("appearance.showTokenUsage");
		});

		it("allows partial appearance (missing fields get defaults)", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.save(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
				appearance: { colorTheme: "gruvbox" },
			}));
			expect(result.valid).toBe(true);
			expect(result.settings!.appearance).toEqual({
				colorTheme: "gruvbox",
				darkMode: "system",
				showTokenUsage: true,
			});
		});
	});

	describe("sessionsPerProject", () => {
		it("defaults to 5 when not specified", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			store.save(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
			}));
			expect(store.settings.sidebar.sessionsPerProject).toBe(5);
		});

		it("accepts a valid positive integer", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.save(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] }, sessionsPerProject: 10 },
			}));
			expect(result.valid).toBe(true);
			expect(result.settings!.sidebar.sessionsPerProject).toBe(10);
		});

		it("rejects zero", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.validate(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] }, sessionsPerProject: 0 },
			}));
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("sidebar.sessionsPerProject");
		});

		it("rejects negative numbers", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.validate(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] }, sessionsPerProject: -3 },
			}));
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("sidebar.sessionsPerProject");
		});

		it("rejects non-integer numbers", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.validate(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] }, sessionsPerProject: 3.5 },
			}));
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("sidebar.sessionsPerProject");
		});

		it("rejects non-number types", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.validate(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] }, sessionsPerProject: "ten" },
			}));
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("sidebar.sessionsPerProject");
		});
	});

	describe("patch", () => {
		it("merges a partial appearance update into existing settings", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			store.save(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [{ pattern: "^~/dev/", replacement: "dev/" }] } },
				appearance: { colorTheme: "default", darkMode: "system", showTokenUsage: true },
			}));

			const result = store.patch({ appearance: { darkMode: "dark" } });
			expect(result.valid).toBe(true);
			expect(result.settings!.appearance).toEqual({
				colorTheme: "default",
				darkMode: "dark",
				showTokenUsage: true,
			});
			// sidebar filters should be preserved
			expect(result.settings!.sidebar.cwdTitle.filters).toHaveLength(1);
		});

		it("patches token usage without affecting other sections", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			store.save(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
				canvas: { enabled: true },
				appearance: { colorTheme: "gruvbox", darkMode: "light", showTokenUsage: true },
			}));

			const result = store.patch({ appearance: { showTokenUsage: false } });
			expect(result.valid).toBe(true);
			expect(result.settings!.appearance.showTokenUsage).toBe(false);
			expect(result.settings!.appearance.colorTheme).toBe("gruvbox");
			expect(result.settings!.appearance.darkMode).toBe("light");
			expect(result.settings!.canvas.enabled).toBe(true);
		});

		it("rejects invalid patch values", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			store.save(JSON.stringify({
				version: 1,
				sidebar: { cwdTitle: { filters: [] } },
			}));

			const result = store.patch({ appearance: { colorTheme: "invalid" } });
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("appearance.colorTheme");
		});

		it("works when no settings file exists yet", () => {
			const store = new LocalSettingsStore({ homeDir: tmpDir, settingsPath });
			const result = store.patch({ appearance: { darkMode: "dark" } });
			expect(result.valid).toBe(true);
			expect(result.settings!.appearance.darkMode).toBe("dark");
			expect(existsSync(settingsPath)).toBe(true);
		});
	});
});

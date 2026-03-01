import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CwdTitleFilter {
	pattern: string;
	replacement: string;
	flags?: string;
}

export type ColorTheme = "default" | "gruvbox";
export type DarkMode = "light" | "dark" | "system";

export interface LocalSettings {
	version: 1;
	sidebar: {
		cwdTitle: {
			filters: CwdTitleFilter[];
		};
		sessionsPerProject: number;
	};
	canvas: {
		enabled: boolean;
	};
	appearance: {
		colorTheme: ColorTheme;
		darkMode: DarkMode;
		showTokenUsage: boolean;
	};
	toolCollapse?: {
		keepOpen: number;
	};
}

export interface LocalSettingsValidationResult {
	valid: boolean;
	errors: string[];
	settings?: LocalSettings;
	formatted?: string;
}

export interface LocalSettingsReadResult {
	path: string;
	exists: boolean;
	errors: string[];
	settings: LocalSettings;
	formatted: string;
}

interface CompiledFilter {
	re: RegExp;
	replacement: string;
}

const VALID_COLOR_THEMES: readonly ColorTheme[] = ["default", "gruvbox"];
const VALID_DARK_MODES: readonly DarkMode[] = ["light", "dark", "system"];

const DEFAULT_SESSIONS_PER_PROJECT = 5;

const DEFAULT_SETTINGS: LocalSettings = {
	version: 1,
	sidebar: {
		cwdTitle: {
			filters: [],
		},
		sessionsPerProject: DEFAULT_SESSIONS_PER_PROJECT,
	},
	canvas: {
		enabled: false,
	},
	appearance: {
		colorTheme: "default",
		darkMode: "system",
		showTokenUsage: true,
	},
};

export function getLocalSettingsPath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".piweb", "settings.json");
}

export function formatSettingsJson(settings: LocalSettings): string {
	return `${JSON.stringify(settings, null, 2)}\n`;
}

export function normalizeCwdForDisplay(cwd: string, homeDir = os.homedir()): string {
	if (!cwd) return cwd;
	if (!homeDir) return cwd;
	if (cwd === homeDir) return "~";
	if (cwd.startsWith(`${homeDir}/`)) return `~${cwd.slice(homeDir.length)}`;
	return cwd;
}

export function applyCwdFilters(input: string, filters: readonly CompiledFilter[]): string {
	let out = input;
	for (const filter of filters) {
		out = out.replace(filter.re, filter.replacement);
	}
	return out;
}

export class LocalSettingsStore {
	private readonly settingsPath: string;
	private readonly homeDir: string;
	private currentSettings: LocalSettings = structuredClone(DEFAULT_SETTINGS);
	private compiledFilters: CompiledFilter[] = [];
	private loadErrors: string[] = [];

	constructor(opts?: { homeDir?: string; settingsPath?: string }) {
		this.homeDir = opts?.homeDir ?? os.homedir();
		this.settingsPath = opts?.settingsPath ?? getLocalSettingsPath(this.homeDir);
		this.loadFromDisk();
	}

	get path(): string {
		return this.settingsPath;
	}

	get settings(): LocalSettings {
		return this.currentSettings;
	}

	get errors(): string[] {
		return [...this.loadErrors];
	}

	get canvasEnabled(): boolean {
		return this.currentSettings.canvas.enabled;
	}

	formatCwdTitle(cwd: string): string {
		const normalized = normalizeCwdForDisplay(cwd, this.homeDir);
		return applyCwdFilters(normalized, this.compiledFilters);
	}

	read(): LocalSettingsReadResult {
		return {
			path: this.settingsPath,
			exists: existsSync(this.settingsPath),
			errors: [...this.loadErrors],
			settings: this.currentSettings,
			formatted: formatSettingsJson(this.currentSettings),
		};
	}

	loadFromDisk(): void {
		if (!existsSync(this.settingsPath)) {
			this.currentSettings = structuredClone(DEFAULT_SETTINGS);
			this.compiledFilters = [];
			this.loadErrors = [];
			return;
		}

		let content: string;
		try {
			content = readFileSync(this.settingsPath, "utf8");
		} catch (err: any) {
			this.currentSettings = structuredClone(DEFAULT_SETTINGS);
			this.compiledFilters = [];
			this.loadErrors = [
				`Failed to read local settings at ${this.settingsPath}: ${String(err?.message ?? err)}`,
			];
			return;
		}

		const result = this.validate(content);
		if (!result.valid || !result.settings) {
			this.currentSettings = structuredClone(DEFAULT_SETTINGS);
			this.compiledFilters = [];
			this.loadErrors = result.errors;
			return;
		}

		this.currentSettings = result.settings;
		this.compiledFilters = compileFilters(result.settings);
		this.loadErrors = [];
	}

	/**
	 * Reload settings from disk, but only apply when the on-disk content is valid.
	 * Invalid edits are reported in `errors` but do not clobber the last good config.
	 *
	 * Returns true when the effective in-memory settings changed.
	 */
	reloadFromDiskIfValid(): boolean {
		const prevFormatted = formatSettingsJson(this.currentSettings);

		if (!existsSync(this.settingsPath)) {
			const next = structuredClone(DEFAULT_SETTINGS);
			const changed = prevFormatted !== formatSettingsJson(next);
			this.currentSettings = next;
			this.compiledFilters = [];
			this.loadErrors = [];
			return changed;
		}

		let content: string;
		try {
			content = readFileSync(this.settingsPath, "utf8");
		} catch (err: any) {
			this.loadErrors = [
				`Failed to read local settings at ${this.settingsPath}: ${String(err?.message ?? err)}`,
			];
			return false;
		}

		const result = this.validate(content);
		if (!result.valid || !result.settings) {
			this.loadErrors = result.errors;
			return false;
		}

		this.currentSettings = result.settings;
		this.compiledFilters = compileFilters(result.settings);
		this.loadErrors = [];
		return prevFormatted !== formatSettingsJson(this.currentSettings);
	}

	validate(content: string): LocalSettingsValidationResult {
		let parsed: any;
		try {
			parsed = JSON.parse(content);
		} catch (err: any) {
			return {
				valid: false,
				errors: [`Invalid JSON: ${String(err?.message ?? err)}`],
			};
		}

		const errors: string[] = [];
		const settings = validateSettingsObject(parsed, errors);
		if (!settings) {
			return { valid: false, errors };
		}

		// Compile regexes during validation so users see precise errors before save.
		for (const [i, filter] of settings.sidebar.cwdTitle.filters.entries()) {
			try {
				new RegExp(filter.pattern, filter.flags ?? "");
			} catch (err: any) {
				errors.push(`sidebar.cwdTitle.filters[${i}].pattern is invalid regex: ${String(err?.message ?? err)}`);
			}
		}

		if (errors.length > 0) {
			return { valid: false, errors };
		}

		return {
			valid: true,
			errors: [],
			settings,
			formatted: formatSettingsJson(settings),
		};
	}

	save(content: string): LocalSettingsValidationResult {
		const result = this.validate(content);
		if (!result.valid || !result.settings || !result.formatted) {
			return result;
		}

		try {
			mkdirSync(path.dirname(this.settingsPath), { recursive: true });
			const tmp = `${this.settingsPath}.tmp`;
			writeFileSync(tmp, result.formatted, "utf8");
			renameSync(tmp, this.settingsPath);
		} catch (err: any) {
			return {
				valid: false,
				errors: [`Failed to write settings: ${String(err?.message ?? err)}`],
			};
		}

		this.currentSettings = result.settings;
		this.compiledFilters = compileFilters(result.settings);
		this.loadErrors = [];
		return result;
	}

	/**
	 * Merge a partial settings object into the current settings.
	 * Only the provided top-level sections are merged (deep-merged one level).
	 */
	patch(partial: Record<string, any>): LocalSettingsValidationResult {
		const merged = structuredClone(this.currentSettings) as any;

		for (const key of Object.keys(partial)) {
			if (key === "version") continue; // never patch version
			if (merged[key] && typeof merged[key] === "object" && typeof partial[key] === "object" && !Array.isArray(partial[key])) {
				Object.assign(merged[key], partial[key]);
			} else {
				merged[key] = partial[key];
			}
		}

		const json = JSON.stringify(merged, null, 2);
		return this.save(json);
	}
}

function validateSettingsObject(value: any, errors: string[]): LocalSettings | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push("Settings must be a JSON object");
		return null;
	}

	if (value.version !== 1) {
		errors.push("version must be 1");
	}

	const sidebar = value.sidebar;
	if (!sidebar || typeof sidebar !== "object" || Array.isArray(sidebar)) {
		errors.push("sidebar must be an object");
	}

	const cwdTitle = sidebar?.cwdTitle;
	if (!cwdTitle || typeof cwdTitle !== "object" || Array.isArray(cwdTitle)) {
		errors.push("sidebar.cwdTitle must be an object");
	}

	const filtersRaw = cwdTitle?.filters;
	if (!Array.isArray(filtersRaw)) {
		errors.push("sidebar.cwdTitle.filters must be an array");
	}

	const filters: CwdTitleFilter[] = [];
	if (Array.isArray(filtersRaw)) {
		filtersRaw.forEach((raw, i) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				errors.push(`sidebar.cwdTitle.filters[${i}] must be an object`);
				return;
			}
			if (typeof raw.pattern !== "string") {
				errors.push(`sidebar.cwdTitle.filters[${i}].pattern must be a string`);
			}
			if (typeof raw.replacement !== "string") {
				errors.push(`sidebar.cwdTitle.filters[${i}].replacement must be a string`);
			}
			if (raw.flags !== undefined && typeof raw.flags !== "string") {
				errors.push(`sidebar.cwdTitle.filters[${i}].flags must be a string when provided`);
			}
			if (typeof raw.pattern === "string" && typeof raw.replacement === "string") {
				filters.push({
					pattern: raw.pattern,
					replacement: raw.replacement,
					...(typeof raw.flags === "string" ? { flags: raw.flags } : {}),
				});
			}
		});
	}

	// sidebar.sessionsPerProject (optional, defaults to DEFAULT_SESSIONS_PER_PROJECT)
	let sessionsPerProject = DEFAULT_SESSIONS_PER_PROJECT;
	if (sidebar?.sessionsPerProject !== undefined) {
		if (typeof sidebar.sessionsPerProject !== "number" || !Number.isInteger(sidebar.sessionsPerProject) || sidebar.sessionsPerProject < 1) {
			errors.push("sidebar.sessionsPerProject must be a positive integer");
		} else {
			sessionsPerProject = sidebar.sessionsPerProject;
		}
	}

	// canvas section (optional, defaults to { enabled: false })
	const canvasRaw = value.canvas;
	let canvasEnabled = false;
	if (canvasRaw !== undefined) {
		if (!canvasRaw || typeof canvasRaw !== "object" || Array.isArray(canvasRaw)) {
			errors.push("canvas must be an object");
		} else if (typeof canvasRaw.enabled !== "boolean") {
			errors.push("canvas.enabled must be a boolean");
		} else {
			canvasEnabled = canvasRaw.enabled;
		}
	}

	// appearance section (optional, defaults to { colorTheme: "default", darkMode: "system", showTokenUsage: true })
	const appearanceRaw = value.appearance;
	let colorTheme: ColorTheme = "default";
	let darkMode: DarkMode = "system";
	let showTokenUsage = true;
	if (appearanceRaw !== undefined) {
		if (!appearanceRaw || typeof appearanceRaw !== "object" || Array.isArray(appearanceRaw)) {
			errors.push("appearance must be an object");
		} else {
			if (appearanceRaw.colorTheme !== undefined) {
				if (typeof appearanceRaw.colorTheme !== "string" || !VALID_COLOR_THEMES.includes(appearanceRaw.colorTheme as ColorTheme)) {
					errors.push(`appearance.colorTheme must be one of: ${VALID_COLOR_THEMES.join(", ")}`);
				} else {
					colorTheme = appearanceRaw.colorTheme as ColorTheme;
				}
			}
			if (appearanceRaw.darkMode !== undefined) {
				if (typeof appearanceRaw.darkMode !== "string" || !VALID_DARK_MODES.includes(appearanceRaw.darkMode as DarkMode)) {
					errors.push(`appearance.darkMode must be one of: ${VALID_DARK_MODES.join(", ")}`);
				} else {
					darkMode = appearanceRaw.darkMode as DarkMode;
				}
			}
			if (appearanceRaw.showTokenUsage !== undefined) {
				if (typeof appearanceRaw.showTokenUsage !== "boolean") {
					errors.push("appearance.showTokenUsage must be a boolean");
				} else {
					showTokenUsage = appearanceRaw.showTokenUsage;
				}
			}
		}
	}

	// Validate toolCollapse (optional)
	let toolCollapse: { keepOpen: number } | undefined;
	if (value.toolCollapse !== undefined) {
		const tc = value.toolCollapse;
		if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
			errors.push("toolCollapse must be an object");
		} else if (typeof tc.keepOpen !== "number" || !Number.isFinite(tc.keepOpen) || tc.keepOpen < 0 || Math.floor(tc.keepOpen) !== tc.keepOpen) {
			errors.push("toolCollapse.keepOpen must be a non-negative integer");
		} else {
			toolCollapse = { keepOpen: tc.keepOpen };
		}
	}

	if (errors.length > 0) return null;

	return {
		version: 1,
		sidebar: {
			cwdTitle: {
				filters,
			},
			sessionsPerProject,
		},
		canvas: {
			enabled: canvasEnabled,
		},
		appearance: {
			colorTheme,
			darkMode,
			showTokenUsage,
		},
		...(toolCollapse ? { toolCollapse } : {}),
	};
}

function compileFilters(settings: LocalSettings): CompiledFilter[] {
	const compiled: CompiledFilter[] = [];
	for (const filter of settings.sidebar.cwdTitle.filters) {
		compiled.push({
			re: new RegExp(filter.pattern, filter.flags ?? ""),
			replacement: filter.replacement,
		});
	}
	return compiled;
}

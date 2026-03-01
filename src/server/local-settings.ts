import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CwdTitleFilter {
	pattern: string;
	replacement: string;
	flags?: string;
}

export interface LocalSettings {
	version: 1;
	sidebar: {
		cwdTitle: {
			filters: CwdTitleFilter[];
		};
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

const DEFAULT_SETTINGS: LocalSettings = {
	version: 1,
	sidebar: {
		cwdTitle: {
			filters: [],
		},
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

	if (errors.length > 0) return null;

	return {
		version: 1,
		sidebar: {
			cwdTitle: {
				filters,
			},
		},
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

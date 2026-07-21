import type { BackendApi } from "./backend-api.js";

export interface LocalSettingsFormValue {
	version: 1;
	sidebar: {
		cwdTitle: {
			filters: Array<{ pattern: string; replacement: string; flags?: string }>;
		};
		sessionsPerProject: number;
	};
	canvas: {
		enabled: boolean;
	};
	appearance: {
		colorTheme: "default" | "gruvbox";
		darkMode: "light" | "dark" | "system";
		showTokenUsage: boolean;
	};
	toolCollapse: {
		keepOpen: number;
	};
	messages: {
		initialCount: number;
	};
}

const DEFAULT_SETTINGS: LocalSettingsFormValue = {
	version: 1,
	sidebar: {
		cwdTitle: { filters: [] },
		sessionsPerProject: 5,
	},
	canvas: { enabled: false },
	appearance: {
		colorTheme: "gruvbox",
		darkMode: "dark",
		showTokenUsage: true,
	},
	toolCollapse: { keepOpen: 3 },
	messages: { initialCount: 50 },
};

type SettingsCategory = "appearance" | "sidebar" | "messages" | "tools" | "canvas" | "advanced";

interface CategoryDefinition {
	id: SettingsCategory;
	label: string;
	icon: string;
	keywords: string;
}

const ICONS = {
	appearance: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a2 2 0 0 1 0-4h3.5A5.5 5.5 0 0 0 21 8.5C21 5.5 17 3 12 3Z"/><path d="M7 10h.01M9 6.5h.01M14 6h.01M18 8.5h.01"/></svg>`,
	sidebar: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>`,
	messages: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/></svg>`,
	tools: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.6 7 6.3 4.7a4 4 0 0 0 5 5L20 18.4l-1.6 1.6-8.7-8.7"/></svg>`,
	canvas: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 16 3-4 3 3 2-2 3 3M8 8h.01"/></svg>`,
	advanced: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></svg>`,
};

const CATEGORIES: CategoryDefinition[] = [
	{ id: "appearance", label: "Appearance", icon: ICONS.appearance, keywords: "theme color light dark system token usage" },
	{ id: "sidebar", label: "Sidebar", icon: ICONS.sidebar, keywords: "project session count path title filter regex" },
	{ id: "messages", label: "Messages", icon: ICONS.messages, keywords: "conversation initial count jsonl viewer history" },
	{ id: "tools", label: "Tool calls", icon: ICONS.tools, keywords: "collapse expanded keep open recent" },
	{ id: "canvas", label: "Canvas", icon: ICONS.canvas, keywords: "panel enabled tool output" },
	{ id: "advanced", label: "Advanced", icon: ICONS.advanced, keywords: "settings file path reset defaults version" },
];

const CATEGORY_DESCRIPTIONS: Record<SettingsCategory, string> = {
	appearance: "Choose Pipane's color theme, light mode, and usage display.",
	sidebar: "Control how projects and sessions are organized.",
	messages: "Choose how much conversation history is loaded at first.",
	tools: "Control how completed tool calls collapse in the timeline.",
	canvas: "Configure the optional panel for rich tool output.",
	advanced: "Inspect local configuration details or restore every default.",
};

function cloneDefaults(): LocalSettingsFormValue {
	return structuredClone(DEFAULT_SETTINGS);
}

function normalizeSettings(raw: any): LocalSettingsFormValue {
	const value = cloneDefaults();
	const filters = raw?.sidebar?.cwdTitle?.filters;
	if (Array.isArray(filters)) {
		value.sidebar.cwdTitle.filters = filters
			.filter((filter) => filter && typeof filter.pattern === "string" && typeof filter.replacement === "string")
			.map((filter) => ({
				pattern: filter.pattern,
				replacement: filter.replacement,
				...(typeof filter.flags === "string" && filter.flags ? { flags: filter.flags } : {}),
			}));
	}
	if (Number.isInteger(raw?.sidebar?.sessionsPerProject) && raw.sidebar.sessionsPerProject > 0) {
		value.sidebar.sessionsPerProject = raw.sidebar.sessionsPerProject;
	}
	if (raw?.appearance?.colorTheme === "default" || raw?.appearance?.colorTheme === "gruvbox") {
		value.appearance.colorTheme = raw.appearance.colorTheme;
	}
	if (["light", "dark", "system"].includes(raw?.appearance?.darkMode)) {
		value.appearance.darkMode = raw.appearance.darkMode;
	}
	if (typeof raw?.appearance?.showTokenUsage === "boolean") {
		value.appearance.showTokenUsage = raw.appearance.showTokenUsage;
	}
	if (typeof raw?.canvas?.enabled === "boolean") value.canvas.enabled = raw.canvas.enabled;
	if (Number.isInteger(raw?.toolCollapse?.keepOpen) && raw.toolCollapse.keepOpen >= 0) {
		value.toolCollapse.keepOpen = raw.toolCollapse.keepOpen;
	}
	if (Number.isInteger(raw?.messages?.initialCount) && raw.messages.initialCount >= 0) {
		value.messages.initialCount = raw.messages.initialCount;
	}
	return value;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

export function openLocalSettingsDialog(opts: {
	api: Pick<BackendApi, "getLocalSettings" | "saveLocalSettings">;
	onSaved?: (settings: LocalSettingsFormValue) => void | Promise<void>;
	onToggleJsonl?: () => void;
	isJsonlVisible?: boolean;
}): Promise<void> {
	return new Promise((resolve) => {
		const overlay = createElement("div", "local-settings-overlay");
		const panel = createElement("section", "local-settings-panel");
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-modal", "true");
		panel.setAttribute("aria-labelledby", "local-settings-title");

		const header = createElement("header", "local-settings-header");
		const titleWrap = createElement("div", "local-settings-title-wrap");
		const titleIcon = createElement("span", "local-settings-title-icon");
		titleIcon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V20h-2v-.49A1.7 1.7 0 0 0 12.38 18a1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.42 15a1.7 1.7 0 0 0-1.55-1.03H7.4v-2h.47a1.7 1.7 0 0 0 1.55-1.03 1.7 1.7 0 0 0-.34-1.88L9.02 9l1.42-1.42.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 13.41 6.4V6h2v.4a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.42 1.42-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.03h.45v2h-.45A1.7 1.7 0 0 0 19.4 15Z"/></svg>`;
		const titleText = createElement("div");
		const title = createElement("div", "local-settings-title", "Settings");
		title.id = "local-settings-title";
		titleText.append(title, createElement("div", "local-settings-subtitle", "Local workspace preferences"));
		titleWrap.append(titleIcon, titleText);

		const searchWrap = createElement("label", "local-settings-search");
		searchWrap.setAttribute("aria-label", "Search settings");
		searchWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>`;
		const search = createElement("input");
		search.type = "search";
		search.placeholder = "Search settings…";
		search.autocomplete = "off";
		searchWrap.appendChild(search);
		const shortcut = createElement("kbd", "local-settings-shortcut", "/");
		searchWrap.appendChild(shortcut);

		const closeBtn = createElement("button", "local-settings-close");
		closeBtn.type = "button";
		closeBtn.title = "Close settings";
		closeBtn.setAttribute("aria-label", "Close settings");
		closeBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`;
		header.append(titleWrap, searchWrap, closeBtn);

		const body = createElement("div", "local-settings-body");
		const navigation = createElement("nav", "local-settings-nav");
		navigation.setAttribute("aria-label", "Settings categories");
		const content = createElement("div", "local-settings-content");
		body.append(navigation, content);

		const footer = createElement("footer", "local-settings-footer");
		const status = createElement("div", "local-settings-status");
		const actions = createElement("div", "local-settings-footer-actions");
		const cancelBtn = createElement("button", "local-settings-btn", "Cancel");
		cancelBtn.type = "button";
		const saveBtn = createElement("button", "local-settings-btn local-settings-btn-primary", "Apply");
		saveBtn.type = "button";
		actions.append(cancelBtn, saveBtn);
		footer.append(status, actions);

		panel.append(header, body, footer);
		overlay.appendChild(panel);
		document.body.appendChild(overlay);

		let settings = cloneDefaults();
		let settingsPath = "~/.piweb/settings.json";
		let activeCategory: SettingsCategory = "sidebar";
		let query = "";
		let busy = true;
		let closed = false;

		const matchingCategories = (): CategoryDefinition[] => {
			const normalized = query.trim().toLowerCase();
			if (!normalized) return CATEGORIES;
			return CATEGORIES.filter((category) =>
				`${category.label} ${category.keywords}`.toLowerCase().includes(normalized),
			);
		};

		const setStatus = (message: string, kind: "valid" | "dirty" | "error" | "loading" = "valid") => {
			status.className = `local-settings-status is-${kind}`;
			status.textContent = message;
		};

		const setBusy = (next: boolean) => {
			busy = next;
			panel.classList.toggle("is-busy", next);
			for (const control of panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select")) {
				control.disabled = next;
			}
		};

		const markDirty = () => {
			setStatus("Unsaved changes", "dirty");
		};

		const close = () => {
			if (closed || busy) return;
			closed = true;
			document.removeEventListener("keydown", onKeyDown);
			overlay.remove();
			resolve();
		};

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return;
			}
			if (event.key === "/" && document.activeElement !== search && !(document.activeElement instanceof HTMLInputElement)) {
				event.preventDefault();
				search.focus();
			}
		};

		const addSection = (label: string): HTMLElement => {
			const section = createElement("section", "local-settings-section");
			section.appendChild(createElement("h4", "local-settings-section-title", label));
			content.appendChild(section);
			return section;
		};

		const addRow = (section: HTMLElement, label: string, description: string, control: HTMLElement): HTMLElement => {
			const row = createElement("div", "local-settings-row");
			const copy = createElement("div", "local-settings-row-copy");
			copy.append(createElement("div", "local-settings-row-label", label), createElement("div", "local-settings-row-description", description));
			row.append(copy, control);
			section.appendChild(row);
			return row;
		};

		const numberInput = (value: number, min: number, label: string, onInput: (value: number) => void): HTMLInputElement => {
			const input = createElement("input", "local-settings-number");
			input.type = "number";
			input.min = String(min);
			input.step = "1";
			input.value = String(value);
			input.setAttribute("aria-label", label);
			input.addEventListener("input", () => {
				onInput(Number(input.value));
				markDirty();
			});
			return input;
		};

		const toggle = (checked: boolean, label: string, onToggle: (checked: boolean) => void): HTMLButtonElement => {
			const button = createElement("button", `local-settings-toggle${checked ? " is-on" : ""}`);
			button.type = "button";
			button.setAttribute("role", "switch");
			button.setAttribute("aria-label", label);
			button.setAttribute("aria-checked", String(checked));
			button.addEventListener("click", () => {
				const next = button.getAttribute("aria-checked") !== "true";
				button.setAttribute("aria-checked", String(next));
				button.classList.toggle("is-on", next);
				onToggle(next);
				markDirty();
			});
			return button;
		};

		const select = <T extends string>(value: T, label: string, options: Array<{ value: T; label: string }>, onChange: (value: T) => void): HTMLSelectElement => {
			const control = createElement("select", "local-settings-select");
			control.setAttribute("aria-label", label);
			for (const option of options) {
				const element = document.createElement("option");
				element.value = option.value;
				element.textContent = option.label;
				control.appendChild(element);
			}
			control.value = value;
			control.addEventListener("change", () => {
				onChange(control.value as T);
				markDirty();
			});
			return control;
		};

		const renderAppearance = () => {
			const colors = addSection("Theme");
			addRow(colors, "Color theme", "Palette used for surfaces, accents, and syntax colors.", select(
				settings.appearance.colorTheme,
				"Color theme",
				[{ value: "gruvbox", label: "Gruvbox" }, { value: "default", label: "Legacy" }],
				(value) => { settings.appearance.colorTheme = value; },
			));

			const modes = createElement("div", "local-settings-segmented");
			for (const mode of ["light", "dark", "system"] as const) {
				const button = createElement("button", settings.appearance.darkMode === mode ? "is-active" : "", mode[0].toUpperCase() + mode.slice(1));
				button.type = "button";
				button.setAttribute("aria-pressed", String(settings.appearance.darkMode === mode));
				button.addEventListener("click", () => {
					settings.appearance.darkMode = mode;
					markDirty();
					renderContent();
				});
				modes.appendChild(button);
			}
			addRow(colors, "Interface mode", "Use a light, dark, or system-controlled interface.", modes);

			const display = addSection("Status display");
			addRow(display, "Show token usage", "Display live context-window usage beneath the composer.", toggle(
				settings.appearance.showTokenUsage,
				"Show token usage",
				(value) => { settings.appearance.showTokenUsage = value; },
			));
		};

		const renderSidebar = () => {
			const sessions = addSection("Session list");
			addRow(sessions, "Sessions per project", "Visible before a project expands to show older sessions.", numberInput(
				settings.sidebar.sessionsPerProject,
				1,
				"Sessions per project",
				(value) => { settings.sidebar.sessionsPerProject = value; },
			));

			const paths = addSection("Project labels");
			const hint = createElement("p", "local-settings-section-hint", "Path rules are applied from top to bottom after your home directory is shortened to ~.");
			paths.appendChild(hint);
			const filters = createElement("div", "local-settings-rules");
			if (settings.sidebar.cwdTitle.filters.length === 0) {
				filters.appendChild(createElement("div", "local-settings-empty", "No path rules. Project labels use their shortened working directory."));
			}
			settings.sidebar.cwdTitle.filters.forEach((filter, index) => {
				const row = createElement("div", "local-settings-rule");
				const indexLabel = createElement("span", "local-settings-rule-index", String(index + 1));
				const pattern = createElement("input");
				pattern.type = "text";
				pattern.placeholder = "Pattern";
				pattern.value = filter.pattern;
				pattern.setAttribute("aria-label", `Path rule ${index + 1} pattern`);
				pattern.addEventListener("input", () => { filter.pattern = pattern.value; markDirty(); });
				const arrow = createElement("span", "local-settings-rule-arrow", "→");
				const replacement = createElement("input");
				replacement.type = "text";
				replacement.placeholder = "Replacement";
				replacement.value = filter.replacement;
				replacement.setAttribute("aria-label", `Path rule ${index + 1} replacement`);
				replacement.addEventListener("input", () => { filter.replacement = replacement.value; markDirty(); });
				const flags = createElement("input", "local-settings-rule-flags");
				flags.type = "text";
				flags.placeholder = "flags";
				flags.value = filter.flags ?? "";
				flags.setAttribute("aria-label", `Path rule ${index + 1} flags`);
				flags.addEventListener("input", () => {
					if (flags.value) filter.flags = flags.value;
					else delete filter.flags;
					markDirty();
				});
				const remove = createElement("button", "local-settings-rule-remove", "×");
				remove.type = "button";
				remove.title = `Remove path rule ${index + 1}`;
				remove.setAttribute("aria-label", `Remove path rule ${index + 1}`);
				remove.addEventListener("click", () => {
					settings.sidebar.cwdTitle.filters.splice(index, 1);
					markDirty();
					renderContent();
				});
				row.append(indexLabel, pattern, arrow, replacement, flags, remove);
				filters.appendChild(row);
			});
			paths.appendChild(filters);
			const add = createElement("button", "local-settings-add-rule", "+ Add path rule");
			add.type = "button";
			add.addEventListener("click", () => {
				settings.sidebar.cwdTitle.filters.push({ pattern: "", replacement: "" });
				markDirty();
				renderContent();
			});
			paths.appendChild(add);
		};

		const renderMessages = () => {
			const history = addSection("Conversation history");
			addRow(history, "Messages loaded initially", "Use 0 to load the complete conversation immediately.", numberInput(
				settings.messages.initialCount,
				0,
				"Messages loaded initially",
				(value) => { settings.messages.initialCount = value; },
			));

			const diagnostics = addSection("Diagnostics");
			const jsonlButton = createElement("button", "local-settings-inline-btn", opts.isJsonlVisible ? "Close viewer" : "Open viewer");
			jsonlButton.type = "button";
			jsonlButton.addEventListener("click", () => {
				if (busy) return;
				const callback = opts.onToggleJsonl;
				close();
				callback?.();
			});
			addRow(diagnostics, "JSONL viewer", "Inspect the current conversation's raw session entries.", jsonlButton);
		};

		const renderTools = () => {
			const collapse = addSection("Collapse behavior");
			addRow(collapse, "Keep recent calls open", "Number of completed tool calls left expanded. Use 0 to collapse all.", numberInput(
				settings.toolCollapse.keepOpen,
				0,
				"Keep recent calls open",
				(value) => { settings.toolCollapse.keepOpen = value; },
			));
			const note = createElement("div", "local-settings-callout");
			note.textContent = "A tool call you manually expand stays open. Set this value to 999999 to disable automatic collapse.";
			collapse.appendChild(note);
		};

		const renderCanvas = () => {
			const availability = addSection("Canvas availability");
			addRow(availability, "Enable canvas", "Allow supported tools to open rich output beside the conversation.", toggle(
				settings.canvas.enabled,
				"Enable canvas",
				(value) => { settings.canvas.enabled = value; },
			));
			const callout = createElement("div", "local-settings-callout");
			callout.textContent = "Disabling canvas hides the panel without changing any conversation data.";
			availability.appendChild(callout);
		};

		const renderAdvanced = () => {
			const localFile = addSection("Local configuration");
			const fileCard = createElement("div", "local-settings-file-card");
			fileCard.append(
				createElement("span", "local-settings-file-label", "Settings file"),
				createElement("code", "", settingsPath),
				createElement("span", "local-settings-file-meta", "Schema version 1 · validated on save"),
			);
			localFile.appendChild(fileCard);

			const reset = addSection("Restore");
			const resetBtn = createElement("button", "local-settings-inline-btn is-danger", "Reset all settings");
			resetBtn.type = "button";
			resetBtn.addEventListener("click", () => {
				settings = cloneDefaults();
				markDirty();
				renderContent();
			});
			addRow(reset, "Restore defaults", "Reset every category in this window. Apply to save the reset.", resetBtn);
		};

		const renderNavigation = () => {
			navigation.replaceChildren();
			navigation.appendChild(createElement("div", "local-settings-nav-label", query ? "Matches" : "Settings"));
			const matches = matchingCategories();
			if (matches.length > 0 && !matches.some((category) => category.id === activeCategory)) {
				activeCategory = matches[0].id;
			}
			for (const category of matches) {
				const button = createElement("button", `local-settings-nav-item${category.id === activeCategory ? " is-active" : ""}`);
				button.type = "button";
				button.dataset.category = category.id;
				button.innerHTML = `${category.icon}<span>${category.label}</span>`;
				button.addEventListener("click", () => {
					activeCategory = category.id;
					renderNavigation();
					renderContent();
				});
				navigation.appendChild(button);
			}
			if (matches.length === 0) {
				navigation.appendChild(createElement("div", "local-settings-nav-empty", "No matching categories"));
			}
		};

		const renderContent = () => {
			content.replaceChildren();
			const matches = matchingCategories();
			if (matches.length === 0) {
				const empty = createElement("div", "local-settings-search-empty");
				empty.innerHTML = `${ICONS.advanced}<strong>No settings found</strong><span>Try “theme,” “messages,” “path,” or “canvas.”</span>`;
				content.appendChild(empty);
				return;
			}
			const category = CATEGORIES.find((item) => item.id === activeCategory)!;
			const contentHeader = createElement("div", "local-settings-content-header");
			contentHeader.append(
				createElement("h3", "", category.label),
				createElement("p", "", CATEGORY_DESCRIPTIONS[category.id]),
			);
			content.appendChild(contentHeader);
			switch (activeCategory) {
				case "appearance": renderAppearance(); break;
				case "sidebar": renderSidebar(); break;
				case "messages": renderMessages(); break;
				case "tools": renderTools(); break;
				case "canvas": renderCanvas(); break;
				case "advanced": renderAdvanced(); break;
			}
		};

		const validateForm = (): string[] => {
			const errors: string[] = [];
			if (!Number.isInteger(settings.sidebar.sessionsPerProject) || settings.sidebar.sessionsPerProject < 1) {
				errors.push("Sessions per project must be a positive whole number.");
			}
			if (!Number.isInteger(settings.messages.initialCount) || settings.messages.initialCount < 0) {
				errors.push("Messages loaded initially must be a non-negative whole number.");
			}
			if (!Number.isInteger(settings.toolCollapse.keepOpen) || settings.toolCollapse.keepOpen < 0) {
				errors.push("Keep recent calls open must be a non-negative whole number.");
			}
			settings.sidebar.cwdTitle.filters.forEach((filter, index) => {
				if (!filter.pattern) errors.push(`Path rule ${index + 1} needs a pattern.`);
				try {
					new RegExp(filter.pattern, filter.flags ?? "");
				} catch (error) {
					errors.push(`Path rule ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
			return errors;
		};

		const save = async () => {
			const errors = validateForm();
			if (errors.length > 0) {
				setStatus(errors.join(" "), "error");
				return;
			}
			setBusy(true);
			setStatus("Saving settings…", "loading");
			try {
				const result = await opts.api.saveLocalSettings(`${JSON.stringify(settings, null, 2)}\n`);
				if (!result.valid) {
					setStatus(result.errors?.join(" ") || "Settings could not be saved.", "error");
					return;
				}
				await opts.onSaved?.(structuredClone(settings));
				setBusy(false);
				close();
				return;
			} catch (error) {
				setStatus(error instanceof Error ? error.message : String(error), "error");
			} finally {
				if (!closed) setBusy(false);
			}
		};

		search.addEventListener("input", () => {
			query = search.value;
			renderNavigation();
			renderContent();
		});
		closeBtn.addEventListener("click", close);
		cancelBtn.addEventListener("click", close);
		saveBtn.addEventListener("click", () => { void save(); });
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) close();
		});
		document.addEventListener("keydown", onKeyDown);

		setStatus("Loading settings…", "loading");
		void opts.api.getLocalSettings().then((payload) => {
			settings = normalizeSettings(payload.settings);
			settingsPath = payload.path || settingsPath;
			renderNavigation();
			renderContent();
			if (payload.errors?.length) setStatus(payload.errors.join(" "), "error");
			else setStatus(`${settingsPath} · valid`, "valid");
		}).catch((error) => {
			renderNavigation();
			renderContent();
			setStatus(error instanceof Error ? error.message : String(error), "error");
		}).finally(() => {
			setBusy(false);
			requestAnimationFrame(() => search.focus());
		});
	});
}

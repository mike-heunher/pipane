/**
 * Theme selector component for pi-web.
 *
 * Manages two orthogonal settings:
 *   1. Color theme: "default" | "gruvbox" (stored as data-color-theme on <html>)
 *   2. Light/dark mode: "light" | "dark" | "system" (the existing .dark class)
 *
 * Replaces the simple <theme-toggle> with a dropdown that shows both options.
 */

import { html, render } from "lit";

export type ColorTheme = "default" | "gruvbox";
export type DarkMode = "light" | "dark" | "system";

const COLOR_THEMES: { id: ColorTheme; label: string }[] = [
	{ id: "default", label: "Default" },
	{ id: "gruvbox", label: "Gruvbox" },
];

const DARK_MODES: { id: DarkMode; label: string; icon: string }[] = [
	{ id: "light", label: "Light", icon: "☀️" },
	{ id: "dark", label: "Dark", icon: "🌙" },
	{ id: "system", label: "System", icon: "💻" },
];

/** Read persisted color theme */
export function getColorTheme(): ColorTheme {
	return (localStorage.getItem("color-theme") as ColorTheme) || "default";
}

/** Read persisted dark mode preference */
export function getDarkMode(): DarkMode {
	return (localStorage.getItem("theme") as DarkMode) || "system";
}

/** Apply the color theme attribute to <html> */
function applyColorTheme(theme: ColorTheme) {
	if (theme === "default") {
		document.documentElement.removeAttribute("data-color-theme");
	} else {
		document.documentElement.setAttribute("data-color-theme", theme);
	}
}

/** Apply dark/light mode class to <html> */
function applyDarkMode(mode: DarkMode) {
	const isDark =
		mode === "dark" ||
		(mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", isDark);
}

/** Set color theme + persist */
export function setColorTheme(theme: ColorTheme) {
	localStorage.setItem("color-theme", theme);
	applyColorTheme(theme);
}

/** Set dark mode + persist */
export function setDarkMode(mode: DarkMode) {
	if (mode === "system") {
		localStorage.removeItem("theme");
	} else {
		localStorage.setItem("theme", mode);
	}
	applyDarkMode(mode);
}

/** Initialize themes on page load */
export function initThemes() {
	applyColorTheme(getColorTheme());
	applyDarkMode(getDarkMode());

	// Listen for system preference changes
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (getDarkMode() === "system") {
			applyDarkMode("system");
		}
	});
}

/**
 * Render the theme selector button + dropdown into a container element.
 * Call this from renderApp() to keep it reactive.
 */
export function createThemeSelector(): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "theme-selector-wrap";

	let open = false;

	const renderSelector = () => {
		const currentMode = getDarkMode();
		const currentTheme = getColorTheme();
		const modeInfo = DARK_MODES.find((m) => m.id === currentMode) || DARK_MODES[2];

		const tpl = html`
			<button
				class="theme-selector-btn"
				@click=${(e: Event) => {
					e.stopPropagation();
					open = !open;
					renderSelector();
				}}
				title="Theme settings"
			>
				<span style="font-size: 14px; line-height: 1;">${modeInfo.icon}</span>
			</button>
			${open
				? html`
					<div class="theme-selector-dropdown" @click=${(e: Event) => e.stopPropagation()}>
						<div class="theme-selector-section-label">Color Theme</div>
						${COLOR_THEMES.map(
							(t) => html`
								<button
									class="theme-selector-option ${currentTheme === t.id ? "is-active" : ""}"
									@click=${() => {
										setColorTheme(t.id);
										renderSelector();
									}}
								>
									<span class="theme-selector-check">${currentTheme === t.id ? "✓" : ""}</span>
									${t.label}
								</button>
							`,
						)}
						<div class="theme-selector-divider"></div>
						<div class="theme-selector-section-label">Appearance</div>
						${DARK_MODES.map(
							(m) => html`
								<button
									class="theme-selector-option ${currentMode === m.id ? "is-active" : ""}"
									@click=${() => {
										setDarkMode(m.id);
										renderSelector();
									}}
								>
									<span class="theme-selector-check">${currentMode === m.id ? "✓" : ""}</span>
									<span>${m.icon}</span>
									${m.label}
								</button>
							`,
						)}
					</div>
				`
				: ""}
		`;
		render(tpl, wrapper);
	};

	// Close dropdown on outside click
	document.addEventListener("click", () => {
		if (open) {
			open = false;
			renderSelector();
		}
	});

	renderSelector();
	return wrapper;
}

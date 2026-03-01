/**
 * Theme selector — reads/writes appearance settings via the server settings API.
 *
 * Manages two orthogonal settings:
 *   1. Color theme: "default" | "gruvbox" (stored as data-color-theme on <html>)
 *   2. Light/dark mode: "light" | "dark" | "system" (the existing .dark class)
 *
 * Settings are persisted to ~/.piweb/settings.json via PATCH /api/settings/local.
 * localStorage is used as a fast cache for immediate application on page load
 * (avoids flash of wrong theme before the API responds).
 */

export type ColorTheme = "default" | "gruvbox";
export type DarkMode = "light" | "dark" | "system";

// ── Fast cache for instant page-load application ──────────────────────────

/** Read cached color theme (for instant page-load apply) */
export function getColorTheme(): ColorTheme {
	return (localStorage.getItem("color-theme") as ColorTheme) || "default";
}

/** Read cached dark mode preference (for instant page-load apply) */
export function getDarkMode(): DarkMode {
	return (localStorage.getItem("theme") as DarkMode) || "system";
}

/** Read cached token usage visibility */
export function getShowTokenUsage(): boolean {
	const val = localStorage.getItem("pipane-show-token-usage");
	return val === null ? true : val === "true";
}

// ── DOM application ───────────────────────────────────────────────────────

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

/** Apply token usage visibility class */
function applyShowTokenUsage(show: boolean) {
	document.documentElement.classList.toggle("hide-token-usage", !show);
}

// ── Setters (update cache + DOM + persist to server) ─────────────────────

/** Set color theme: update cache, DOM, and persist to server */
export function setColorTheme(theme: ColorTheme) {
	localStorage.setItem("color-theme", theme);
	applyColorTheme(theme);
	patchAppearance({ colorTheme: theme });
}

/** Set dark mode: update cache, DOM, and persist to server */
export function setDarkMode(mode: DarkMode) {
	if (mode === "system") {
		localStorage.removeItem("theme");
	} else {
		localStorage.setItem("theme", mode);
	}
	applyDarkMode(mode);
	patchAppearance({ darkMode: mode });
}

/** Set token usage visibility: update cache, DOM, and persist to server */
export function setShowTokenUsage(show: boolean) {
	localStorage.setItem("pipane-show-token-usage", String(show));
	applyShowTokenUsage(show);
	patchAppearance({ showTokenUsage: show });
}

// ── Server persistence ────────────────────────────────────────────────────

function patchAppearance(partial: Record<string, any>) {
	fetch("/api/settings/local", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appearance: partial }),
	}).catch((err) => {
		console.error("Failed to persist appearance setting:", err);
	});
}

// ── Initialization ────────────────────────────────────────────────────────

/** Initialize themes on page load using cached values, then sync from server */
export function initThemes() {
	// Apply immediately from cache (fast, no flash)
	applyColorTheme(getColorTheme());
	applyDarkMode(getDarkMode());
	applyShowTokenUsage(getShowTokenUsage());

	// Listen for system preference changes
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (getDarkMode() === "system") {
			applyDarkMode("system");
		}
	});

	// Sync from server (the server settings are the source of truth)
	syncFromServer();
}

/** Fetch settings from server and update local cache + DOM if different */
async function syncFromServer() {
	try {
		const res = await fetch("/api/settings/local");
		if (!res.ok) return;
		const data = await res.json();
		const appearance = data?.settings?.appearance;
		if (!appearance) return;

		if (appearance.colorTheme && appearance.colorTheme !== getColorTheme()) {
			localStorage.setItem("color-theme", appearance.colorTheme);
			applyColorTheme(appearance.colorTheme);
		}
		if (appearance.darkMode && appearance.darkMode !== getDarkMode()) {
			if (appearance.darkMode === "system") {
				localStorage.removeItem("theme");
			} else {
				localStorage.setItem("theme", appearance.darkMode);
			}
			applyDarkMode(appearance.darkMode);
		}
		if (typeof appearance.showTokenUsage === "boolean") {
			const cached = getShowTokenUsage();
			if (appearance.showTokenUsage !== cached) {
				localStorage.setItem("pipane-show-token-usage", String(appearance.showTokenUsage));
				applyShowTokenUsage(appearance.showTokenUsage);
			}
		}
	} catch {
		// Server may not be available yet; local cache is fine as fallback
	}
}

/**
 * Re-sync appearance settings from server. Call when local settings change
 * notification arrives via WebSocket.
 */
export async function resyncAppearanceFromServer() {
	await syncFromServer();
}

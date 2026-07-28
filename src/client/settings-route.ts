const SETTINGS_RETURN_KEY = "pipaneSettingsReturnTo";

interface SettingsHistoryState extends Record<string, unknown> {
	[SETTINGS_RETURN_KEY]?: string;
}

export function isSettingsPath(pathname: string): boolean {
	return pathname === "/settings" || pathname === "/settings/";
}

export function enterSettingsRoute(): void {
	if (isSettingsPath(window.location.pathname)) return;
	const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	const currentState = isRecord(window.history.state) ? window.history.state : {};
	window.history.pushState({ ...currentState, [SETTINGS_RETURN_KEY]: returnTo }, "", "/settings");
}

export function leaveSettingsRoute(): void {
	if (!isSettingsPath(window.location.pathname)) return;
	const returnTo = isRecord(window.history.state) ? window.history.state[SETTINGS_RETURN_KEY] : undefined;
	if (isSafeReturnPath(returnTo)) {
		window.history.back();
		return;
	}
	window.history.replaceState(null, "", "/");
}

function isRecord(value: unknown): value is SettingsHistoryState {
	return !!value && typeof value === "object";
}

function isSafeReturnPath(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !isSettingsPath(value.split(/[?#]/u, 1)[0]);
}

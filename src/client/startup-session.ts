const STARTUP_SESSION_KEY = "pipane-startup-session-v1";

export interface StartupSessionSelection {
	backendId?: string;
	path: string;
	cwd?: string;
}

function optionalString(value: unknown, maximumLength: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : undefined;
}

export function loadStartupSession(storage: Pick<Storage, "getItem"> = localStorage): StartupSessionSelection | undefined {
	try {
		const parsed: unknown = JSON.parse(storage.getItem(STARTUP_SESSION_KEY) ?? "null");
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = parsed as Record<string, unknown>;
		const path = optionalString(record.path, 16_384);
		if (!path?.startsWith("/")) return undefined;
		return {
			path,
			...(optionalString(record.backendId, 512) ? { backendId: String(record.backendId) } : {}),
			...(optionalString(record.cwd, 16_384) ? { cwd: String(record.cwd) } : {}),
		};
	} catch {
		return undefined;
	}
}

export function saveStartupSession(
	selection: StartupSessionSelection,
	storage: Pick<Storage, "setItem"> = localStorage,
): void {
	if (!selection.path.startsWith("/")) return;
	try {
		storage.setItem(STARTUP_SESSION_KEY, JSON.stringify(selection));
	} catch {
		// Startup restoration is an optional acceleration; storage denial must not
		// interfere with the authoritative backend session.
	}
}

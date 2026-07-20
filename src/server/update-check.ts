export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

async function fetchJson(url: string, timeoutMs: number, headers: Record<string, string>): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers,
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Check the npm registry for the latest version of a package. */
export async function fetchLatestVersion(packageName: string, timeoutMs = 3000): Promise<string | null> {
	const data = await fetchJson(
		`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
		timeoutMs,
		{ Accept: "application/json" },
	) as { version?: unknown } | null;
	return typeof data?.version === "string" && data.version.trim() ? data.version.trim() : null;
}

/** Check Pi's release endpoint, including package migration metadata. */
export async function fetchLatestPiRelease(currentVersion: string, timeoutMs = 3000): Promise<LatestPiRelease | null> {
	const data = await fetchJson(
		"https://pi.dev/api/latest-version",
		timeoutMs,
		{
			Accept: "application/json",
			"User-Agent": `pipane/${currentVersion}`,
		},
	) as { version?: unknown; packageName?: unknown; note?: unknown } | null;
	if (typeof data?.version !== "string" || !data.version.trim()) return null;
	return {
		version: data.version.trim(),
		...(typeof data.packageName === "string" && data.packageName.trim()
			? { packageName: data.packageName.trim() }
			: {}),
		...(typeof data.note === "string" && data.note.trim()
			? { note: data.note.trim() }
			: {}),
	};
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const va = pa[i] ?? 0;
		const vb = pb[i] ?? 0;
		if (va < vb) return -1;
		if (va > vb) return 1;
	}
	return 0;
}

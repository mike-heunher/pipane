/**
 * Check the npm registry for the latest version of a package.
 * Returns null if the check fails (network error, timeout, etc.)
 */
export async function fetchLatestVersion(packageName: string, timeoutMs = 3000): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: string };
		return data.version ?? null;
	} catch {
		return null;
	}
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

import { readFileSync } from "node:fs";

interface BuildInfo {
	packageVersion: string;
	developmentCommit: boolean;
}

export function isDevelopmentCommit(buildInfoPath: string, packageVersion: string): boolean {
	try {
		const value: unknown = JSON.parse(readFileSync(buildInfoPath, "utf8"));
		if (!value || typeof value !== "object") return false;
		const info = value as Partial<BuildInfo>;
		return info.packageVersion === packageVersion && info.developmentCommit === true;
	} catch {
		return false;
	}
}

export const UPDATE_TARGETS = ["pipane", "pi", "extensions"] as const;

export type UpdateTarget = typeof UPDATE_TARGETS[number];

export interface UpdateNotice {
	target: UpdateTarget;
	currentVersion?: string;
	latestVersion?: string;
	packages?: string[];
}

export interface UpdateSnapshot {
	checkedAt: string;
	notices: UpdateNotice[];
}

export interface UpdateRunResult {
	target: UpdateTarget;
	message: string;
	restartRequired: boolean;
}

export interface UpdateRunResponse {
	result: UpdateRunResult;
	snapshot: UpdateSnapshot;
}

export function isUpdateTarget(value: unknown): value is UpdateTarget {
	return typeof value === "string" && UPDATE_TARGETS.includes(value as UpdateTarget);
}

import type { UpdateNotice } from "../shared/updates.js";

export const UPDATE_SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;
const UPDATE_SNOOZE_STORAGE_KEY = "pipane-update-snoozes-v1";

type UpdateSnoozeStorage = Pick<Storage, "getItem" | "setItem">;
type UpdateSnoozeState = Record<string, number>;

function updateNoticeIdentity(notice: UpdateNotice, scope = "local"): string {
	return JSON.stringify([
		scope,
		notice.target,
		notice.currentVersion ?? null,
		notice.latestVersion ?? null,
		notice.packages ?? [],
	]);
}

function loadUpdateSnoozes(storage: UpdateSnoozeStorage, now: number): UpdateSnoozeState {
	try {
		const parsed: unknown = JSON.parse(storage.getItem(UPDATE_SNOOZE_STORAGE_KEY) ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, number] => (
				typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > now
			)),
		);
	} catch {
		return {};
	}
}

export class UpdateNoticeSnoozeStore {
	private readonly state: UpdateSnoozeState;

	constructor(
		private readonly storage: UpdateSnoozeStorage,
		private readonly now: () => number = Date.now,
	) {
		this.state = loadUpdateSnoozes(storage, now());
	}

	isSnoozed(notice: UpdateNotice, scope?: string): boolean {
		return (this.state[updateNoticeIdentity(notice, scope)] ?? 0) > this.now();
	}

	snooze(notice: UpdateNotice, scope?: string): void {
		this.state[updateNoticeIdentity(notice, scope)] = this.now() + UPDATE_SNOOZE_DURATION_MS;
		try {
			this.storage.setItem(UPDATE_SNOOZE_STORAGE_KEY, JSON.stringify(this.state));
		} catch {
			// Storage is an optional browser convenience; the in-memory snooze still works.
		}
	}

	nextExpiry(notices: readonly UpdateNotice[], scope?: string): number | undefined {
		const now = this.now();
		let next: number | undefined;
		for (const notice of notices) {
			const expiresAt = this.state[updateNoticeIdentity(notice, scope)];
			if (expiresAt !== undefined && expiresAt > now && (next === undefined || expiresAt < next)) {
				next = expiresAt;
			}
		}
		return next;
	}
}

function versionTransition(notice: UpdateNotice): string {
	return notice.currentVersion && notice.latestVersion
		? `v${notice.currentVersion} → v${notice.latestVersion}`
		: "new version available";
}

export function updateNoticeTitle(notice: UpdateNotice): string {
	switch (notice.target) {
		case "pipane": return `pipane update ${versionTransition(notice)}`;
		case "pi": return `Pi update ${versionTransition(notice)}`;
		case "extensions": {
			const count = notice.packages?.length ?? 0;
			return `${count} Pi package update${count === 1 ? "" : "s"} available`;
		}
	}
}

export function updateNoticeDetail(notice: UpdateNotice): string {
	switch (notice.target) {
		case "pipane": return "Install now; restart pipane when it finishes.";
		case "pi": return "Install now; Pi workers restart automatically.";
		case "extensions": return notice.packages?.join(", ") || "Managed Pi packages";
	}
}

export function updateConfirmationMessage(notice: UpdateNotice): string {
	switch (notice.target) {
		case "pipane":
			return `Install pipane ${notice.latestVersion ? `v${notice.latestVersion}` : "update"} now?\n\nYou will need to restart pipane after installation.`;
		case "pi":
			return `Install Pi ${notice.latestVersion ? `v${notice.latestVersion}` : "update"} now?\n\nPi workers will restart after active operations finish.`;
		case "extensions": {
			const packages = notice.packages?.join("\n• ") || "Managed Pi packages";
			return `Update these Pi packages now?\n\n• ${packages}\n\nPi workers will restart after active operations finish.`;
		}
	}
}

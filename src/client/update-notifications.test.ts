import { describe, expect, it } from "vitest";
import {
	UPDATE_SNOOZE_DURATION_MS,
	UpdateNoticeSnoozeStore,
	updateConfirmationMessage,
	updateNoticeDetail,
	updateNoticeTitle,
} from "./update-notifications.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => { values.set(key, value); },
	};
}

describe("update notification copy", () => {
	it("describes a pipane update and restart requirement", () => {
		const notice = { target: "pipane" as const, currentVersion: "0.1.6", latestVersion: "0.1.7" };
		expect(updateNoticeTitle(notice)).toBe("pipane update v0.1.6 → v0.1.7");
		expect(updateNoticeDetail(notice)).toContain("restart pipane");
		expect(updateConfirmationMessage(notice)).toContain("Install pipane v0.1.7 now?");
	});

	it("describes a Pi update and worker restart", () => {
		const notice = { target: "pi" as const, currentVersion: "0.80.6", latestVersion: "0.80.10" };
		expect(updateNoticeTitle(notice)).toBe("Pi update v0.80.6 → v0.80.10");
		expect(updateNoticeDetail(notice)).toContain("workers restart automatically");
		expect(updateConfirmationMessage(notice)).toContain("active operations finish");
	});

	it("lists every managed Pi package in the confirmation", () => {
		const notice = { target: "extensions" as const, packages: ["npm:one", "git:example/two"] };
		expect(updateNoticeTitle(notice)).toBe("2 Pi package updates available");
		expect(updateNoticeDetail(notice)).toBe("npm:one, git:example/two");
		expect(updateConfirmationMessage(notice)).toContain("• npm:one\n• git:example/two");
	});
});

describe("update notice snoozes", () => {
	it("snoozes a notice for exactly 24 hours", () => {
		let now = 1_000;
		const notice = { target: "pipane" as const, currentVersion: "0.1.6", latestVersion: "0.1.7" };
		const store = new UpdateNoticeSnoozeStore(memoryStorage(), () => now);

		store.snooze(notice);
		expect(store.isSnoozed(notice)).toBe(true);
		expect(store.nextExpiry([notice])).toBe(1_000 + UPDATE_SNOOZE_DURATION_MS);

		now += UPDATE_SNOOZE_DURATION_MS - 1;
		expect(store.isSnoozed(notice)).toBe(true);
		now += 1;
		expect(store.isSnoozed(notice)).toBe(false);
		expect(store.nextExpiry([notice])).toBeUndefined();
	});

	it("persists a snooze for the same update without hiding a newer one", () => {
		const storage = memoryStorage();
		const now = () => 2_000;
		const notice = { target: "pi" as const, currentVersion: "0.80.6", latestVersion: "0.80.10" };
		new UpdateNoticeSnoozeStore(storage, now).snooze(notice);

		const restored = new UpdateNoticeSnoozeStore(storage, now);
		expect(restored.isSnoozed(notice)).toBe(true);
		expect(restored.isSnoozed({ ...notice, latestVersion: "0.80.11" })).toBe(false);
		expect(restored.isSnoozed({ target: "pipane", currentVersion: "0.80.6", latestVersion: "0.80.10" })).toBe(false);
	});

	it("falls back to in-memory snoozes when browser storage is unavailable", () => {
		const storage = {
			getItem: () => { throw new Error("denied"); },
			setItem: () => { throw new Error("denied"); },
		};
		const notice = { target: "extensions" as const, packages: ["npm:one"] };
		const store = new UpdateNoticeSnoozeStore(storage, () => 3_000);

		expect(() => store.snooze(notice)).not.toThrow();
		expect(store.isSnoozed(notice)).toBe(true);
	});
});

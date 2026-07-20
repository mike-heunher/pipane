import { describe, expect, it } from "vitest";
import {
	updateConfirmationMessage,
	updateNoticeDetail,
	updateNoticeTitle,
} from "./update-notifications.js";

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

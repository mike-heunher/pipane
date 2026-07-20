import type { UpdateNotice } from "../shared/updates.js";

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

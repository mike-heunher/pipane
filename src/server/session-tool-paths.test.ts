/** @vitest-environment node */

import { describe, expect, it } from "vitest";
import { buildActiveSessionEntries, extractSuccessfulToolPaths } from "./session-tool-paths.js";

function message(id: string, parentId: string | null, value: any): any {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: value };
}

describe("session tool path activity", () => {
	it("retains successful direct and parallel path calls in active-branch order", () => {
		const entries = [
			{ type: "session", id: "session", cwd: "/repo" },
			message("assistant-1", null, {
				role: "assistant",
				content: [{ type: "toolCall", id: "write-1", name: "functions.write", arguments: { path: "/repo--wt-feature/docs/plan.md" } }],
			}),
			message("result-1", "assistant-1", { role: "toolResult", toolCallId: "write-1", isError: false, content: [] }),
			message("assistant-2", "result-1", {
				role: "assistant",
				content: [{
					type: "toolCall",
					id: "parallel-1",
					name: "multi_tool_use.parallel",
					arguments: {
						tool_uses: [
							{ recipient_name: "functions.hypa_read", parameters: { path: "/repo--wt-feature/src/main.ts" } },
							{ recipient_name: "functions.edit", parameters: { path: "README.md" } },
						],
					},
				}],
			}),
			message("result-2", "assistant-2", { role: "toolResult", toolCallId: "parallel-1", content: [] }),
		];

		expect(extractSuccessfulToolPaths(entries, "/repo")).toEqual([
			{ path: "/repo--wt-feature/docs/plan.md", toolName: "write", mutatesFile: true },
			{ path: "/repo--wt-feature/src/main.ts", toolName: "hypa_read", mutatesFile: false },
			{ path: "/repo/README.md", toolName: "edit", mutatesFile: true },
		]);
	});

	it("ignores failed, pending, and abandoned-branch calls", () => {
		const entries = [
			{ type: "session", id: "session", cwd: "/repo" },
			message("root-assistant", null, {
				role: "assistant",
				content: [{ type: "toolCall", id: "root-write", name: "write", arguments: { path: "docs/root.md" } }],
			}),
			message("root-result", "root-assistant", { role: "toolResult", toolCallId: "root-write", content: [] }),
			message("abandoned-assistant", "root-result", {
				role: "assistant",
				content: [{ type: "toolCall", id: "abandoned-write", name: "write", arguments: { path: "/repo--wt-old/docs/old.md" } }],
			}),
			message("abandoned-result", "abandoned-assistant", { role: "toolResult", toolCallId: "abandoned-write", content: [] }),
			message("active-assistant", "root-result", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "failed-write", name: "write", arguments: { path: "/tmp/secret.md" } },
					{ type: "toolCall", id: "pending-write", name: "write", arguments: { path: "/tmp/pending.md" } },
				],
			}),
			message("active-result", "active-assistant", { role: "toolResult", toolCallId: "failed-write", isError: true, content: [] }),
		];

		expect(buildActiveSessionEntries(entries).map((entry) => entry.id)).toEqual([
			"root-assistant",
			"root-result",
			"active-assistant",
			"active-result",
		]);
		expect(extractSuccessfulToolPaths(entries, "/repo")).toEqual([
			{ path: "/repo/docs/root.md", toolName: "write", mutatesFile: true },
		]);
	});

	it("keeps pre-compaction mutation evidence on the active lineage", () => {
		const entries = [
			{ type: "session", id: "session", cwd: "/repo" },
			message("assistant", null, {
				role: "assistant",
				content: [{ type: "toolCall", id: "write", name: "write", arguments: { path: "/repo--wt-feature/design.md" } }],
			}),
			message("result", "assistant", { role: "toolResult", toolCallId: "write", content: [] }),
			{ type: "compaction", id: "compact", parentId: "result", timestamp: "2026-01-01T00:01:00.000Z", summary: "summary", firstKeptEntryId: "result", tokensBefore: 1 },
			message("after", "compact", { role: "user", content: "open design.md" }),
		];

		expect(extractSuccessfulToolPaths(entries, "/repo")).toEqual([
			{ path: "/repo--wt-feature/design.md", toolName: "write", mutatesFile: true },
		]);
	});
});

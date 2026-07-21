import { expect, test } from "@playwright/test";
import { startMockPipaneServer } from "./mock-pipane-server.js";

const SESSION_PATH = "/tmp/mock-sessions/file-preview.jsonl";
const PROJECT_CWD = "/tmp/file-preview-project";
const GUIDE_PATH = `${PROJECT_CWD}/docs/guide.md`;
const DETAILS_PATH = `${PROJECT_CWD}/docs/details.md`;

async function startServer() {
	return startMockPipaneServer({
		sessions: [{
			id: "file-preview",
			path: SESSION_PATH,
			cwd: PROJECT_CWD,
			created: "2026-07-21T12:00:00.000Z",
			modified: "2026-07-21T12:01:00.000Z",
			lastUserPromptTime: "2026-07-21T12:01:00.000Z",
			messageCount: 2,
			firstMessage: "Show the project guide",
		}],
		states: {
			[SESSION_PATH]: {
				messages: [
					{ role: "user", content: "Where is the guide?", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "Open the [project guide](docs/guide.md)." }],
						timestamp: 2,
						stopReason: "end_turn",
					},
				],
			},
		},
		files: {
			[GUIDE_PATH]: "# Project Guide\n\nThis is **rendered markdown**.\n\n[More details](details.md)",
			[DETAILS_PATH]: "# Details\n\nNested file links resolve beside the open document.",
		},
	});
}

test("opens linked markdown files in a right-hand pane", async ({ page }) => {
	const server = await startServer();
	try {
		await page.goto(`http://localhost:${server.port}`);
		const guideLink = page.getByRole("link", { name: "project guide" });
		await expect(guideLink).toBeVisible();
		await guideLink.click();

		const panel = page.locator(".file-preview-panel");
		await expect(panel).toBeVisible();
		await expect(panel.locator(".file-preview-title")).toHaveText("guide.md");
		await expect(panel.getByRole("heading", { name: "Project Guide" })).toBeVisible();
		await expect(panel.locator("strong")).toHaveText("rendered markdown");

		await panel.getByRole("link", { name: "More details" }).click();
		await expect(panel.locator(".file-preview-title")).toHaveText("details.md");
		await expect(panel.getByRole("heading", { name: "Details" })).toBeVisible();

		await panel.getByRole("button", { name: "Close file preview" }).click();
		await expect(panel).toBeHidden();
	} finally {
		await server.close();
	}
});

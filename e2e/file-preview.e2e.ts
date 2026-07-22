import { expect, test, type Page } from "@playwright/test";
import { startMockPipaneServer } from "./mock-pipane-server.js";

const SESSION_PATH = "/tmp/mock-sessions/file-preview.jsonl";
const OTHER_SESSION_PATH = "/tmp/mock-sessions/file-preview-other.jsonl";
const PROJECT_CWD = "/tmp/file-preview-project";
const GUIDE_PATH = `${PROJECT_CWD}/docs/guide.md`;
const DETAILS_PATH = `${PROJECT_CWD}/docs/details.md`;
const HTML_PATH = `${PROJECT_CWD}/examples/demo.html`;

async function switchSession(page: Page, sessionPath: string): Promise<void> {
	await page.evaluate(async (path) => {
		const picker = document.querySelector("session-picker") as any;
		if (!picker?.agent) throw new Error("Session picker agent was not ready");
		await picker.agent.switchSession(path);
	}, sessionPath);
	await expect.poll(async () => page.evaluate(() => {
		const picker = document.querySelector("session-picker") as any;
		return picker?.agent?.sessionFile;
	})).toBe(sessionPath);
}

async function startServer() {
	return startMockPipaneServer({
		sessions: [
			{
				id: "file-preview",
				path: SESSION_PATH,
				cwd: PROJECT_CWD,
				created: "2026-07-21T12:00:00.000Z",
				modified: "2026-07-21T12:01:00.000Z",
				lastUserPromptTime: "2026-07-21T12:01:00.000Z",
				messageCount: 4,
				firstMessage: "Show the project guide",
			},
			{
				id: "file-preview-other",
				path: OTHER_SESSION_PATH,
				cwd: PROJECT_CWD,
				created: "2026-07-21T11:00:00.000Z",
				modified: "2026-07-21T11:01:00.000Z",
				lastUserPromptTime: "2026-07-21T11:01:00.000Z",
				messageCount: 1,
				firstMessage: "A conversation without a preview",
			},
		],
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
					{
						role: "assistant",
						content: [{ type: "text", text: `Or open \`${DETAILS_PATH}\` directly.` }],
						timestamp: 3,
						stopReason: "end_turn",
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "Try the [interactive HTML example](examples/demo.html)." }],
						timestamp: 4,
						stopReason: "end_turn",
					},
				],
			},
			[OTHER_SESSION_PATH]: {
				messages: [{ role: "user", content: "No file is open here.", timestamp: 1 }],
			},
		},
		files: {
			[GUIDE_PATH]: "# Project Guide\n\nThis is **rendered markdown** with $E = mc^2$.\n\n\\[\n\\int_0^1 x^2 \\, dx\n\\]\n\n[More details](details.md)",
			[DETAILS_PATH]: "# Details\n\nNested file links resolve beside the open document.",
			[HTML_PATH]: "<!doctype html><html><head><title>Demo</title></head><body><h1>Interactive HTML</h1><output id=\"script-status\"></output><a href=\"../docs/details.md\">Open details</a><script>document.getElementById('script-status').textContent = 'Scripts work';<\/script></body></html>",
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
		const previewFrame = page.frameLocator(".file-preview-frame");
		await expect(panel).toBeVisible();
		await expect(panel.locator(".file-preview-title")).toHaveText("guide.md");
		await expect(previewFrame.getByRole("heading", { name: "Project Guide" })).toBeVisible();
		await expect(previewFrame.locator("strong")).toHaveText("rendered markdown");
		await expect(previewFrame.locator(".katex")).toHaveCount(2);
		await expect(previewFrame.locator(".katex-display")).toBeVisible();
		const panelBackground = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
		const previewBackground = await previewFrame.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
		expect(previewBackground).toBe(panelBackground);

		const panelContainer = page.locator(".file-preview-container");
		const resizeHandle = page.getByRole("separator", { name: "Resize file preview" });
		const initialBox = await panelContainer.boundingBox();
		const handleBox = await resizeHandle.boundingBox();
		if (!initialBox || !handleBox) throw new Error("Preview resize controls have no layout box");
		await page.mouse.move(handleBox.x + handleBox.width / 2, initialBox.y + initialBox.height / 2);
		await page.mouse.down();
		await expect(page.locator(".file-preview-resize-overlay")).toBeVisible();
		// The first move lands over the iframe's old bounds. The viewport overlay
		// must retain the drag instead of allowing the child frame to take it.
		await page.mouse.move(initialBox.x + 40, initialBox.y + initialBox.height / 2);
		await expect.poll(async () => (await panelContainer.boundingBox())?.width ?? 0)
			.toBeLessThan(initialBox.width - 20);
		await page.mouse.up();
		await expect(page.locator(".file-preview-resize-overlay")).toHaveCount(0);

		await previewFrame.getByRole("link", { name: "More details" }).click();
		await expect(panel.locator(".file-preview-title")).toHaveText("details.md");
		await expect(previewFrame.getByRole("heading", { name: "Details" })).toBeVisible();

		await switchSession(page, OTHER_SESSION_PATH);
		await expect(panel).toBeHidden();
		await switchSession(page, SESSION_PATH);
		await expect(panel.locator(".file-preview-title")).toHaveText("details.md");
		await expect(previewFrame.getByRole("heading", { name: "Details" })).toBeVisible();

		const inlinePathLink = page.getByRole("link", { name: DETAILS_PATH });
		await expect(inlinePathLink.locator("code")).toHaveText(DETAILS_PATH);
		await inlinePathLink.click();
		await expect(panel.locator(".file-preview-title")).toHaveText("details.md");

		await panel.getByRole("button", { name: "Close file preview" }).click();
		await expect(panel).toBeHidden();
	} finally {
		await server.close();
	}
});

test("renders active HTML in the isolated preview iframe", async ({ page }) => {
	const server = await startServer();
	try {
		await page.goto(`http://localhost:${server.port}`);
		await page.getByRole("link", { name: "interactive HTML example" }).click();

		const panel = page.locator(".file-preview-panel");
		const previewFrame = page.frameLocator(".file-preview-frame");
		await expect(panel.locator(".file-preview-title")).toHaveText("demo.html");
		await expect(previewFrame.getByRole("heading", { name: "Interactive HTML" })).toBeVisible();
		await expect(previewFrame.locator("#script-status")).toHaveText("Scripts work");

		await previewFrame.getByRole("link", { name: "Open details" }).click();
		await expect(panel.locator(".file-preview-title")).toHaveText("details.md");
		await expect(previewFrame.getByRole("heading", { name: "Details" })).toBeVisible();
	} finally {
		await server.close();
	}
});

import { expect, test, type Page } from "@playwright/test";
import { startMockPipaneServer } from "./mock-pipane-server.js";

const SESSION_A = "/tmp/mock-sessions/draft-a.jsonl";
const SESSION_B = "/tmp/mock-sessions/draft-b.jsonl";

function session(id: string, path: string, firstMessage: string, modified: string) {
	return {
		id,
		path,
		cwd: "/tmp/project",
		created: modified,
		modified,
		lastUserPromptTime: modified,
		messageCount: 1,
		firstMessage,
	};
}

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

test.describe("conversation composer drafts", () => {
	test("restores each conversation's own text and attachments", async ({ page }) => {
		const mock = await startMockPipaneServer({
			sessions: [
				session("a", SESSION_A, "Conversation A", "2026-07-21T12:00:00.000Z"),
				session("b", SESSION_B, "Conversation B", "2026-07-21T11:00:00.000Z"),
			],
			states: {
				[SESSION_A]: [],
				[SESSION_B]: [],
			},
		});

		try {
			await page.goto(`http://localhost:${mock.port}`);
			const editor = page.locator("message-editor");
			const textarea = editor.locator("textarea");
			await expect(textarea).toBeEnabled({ timeout: 10_000 });
			await expect.poll(async () => page.evaluate(() => {
				const picker = document.querySelector("session-picker") as any;
				return picker?.agent?.sessionFile;
			})).toBe(SESSION_A);

			await textarea.fill("draft for A");
			await editor.locator("input[type=file]").setInputFiles({
				name: "alpha.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("alpha"),
			});
			await expect(editor.locator("attachment-tile [title='alpha.txt']")).toBeVisible();

			await switchSession(page, SESSION_B);
			await expect(textarea).toHaveValue("");
			await expect(editor.locator("attachment-tile")).toHaveCount(0);

			await textarea.fill("draft for B");
			await editor.locator("input[type=file]").setInputFiles({
				name: "beta.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("beta"),
			});
			await expect(editor.locator("attachment-tile [title='beta.txt']")).toBeVisible();

			await switchSession(page, SESSION_A);
			await expect(textarea).toHaveValue("draft for A");
			await expect(editor.locator("attachment-tile [title='alpha.txt']")).toBeVisible();
			await expect(editor.locator("attachment-tile [title='beta.txt']")).toHaveCount(0);

			await switchSession(page, SESSION_B);
			await expect(textarea).toHaveValue("draft for B");
			await expect(editor.locator("attachment-tile [title='beta.txt']")).toBeVisible();
			await expect(editor.locator("attachment-tile [title='alpha.txt']")).toHaveCount(0);
		} finally {
			await mock.close();
		}
	});

	test("reconciles a disconnected prompt without restoring a duplicate draft", async ({ page }) => {
		const mock = await startMockPipaneServer({
			sessions: [session("a", SESSION_A, "Conversation A", "2026-07-21T12:00:00.000Z")],
			states: { [SESSION_A]: [] },
			disconnectOnCommands: ["prompt"],
		});

		try {
			await page.goto(`http://localhost:${mock.port}`);
			const editor = page.locator("message-editor");
			const textarea = editor.locator("textarea");
			await expect(textarea).toBeEnabled({ timeout: 10_000 });
			await textarea.fill("do not lose this prompt");
			await editor.locator("input[type=file]").setInputFiles([
				{ name: "alpha.txt", mimeType: "text/plain", buffer: Buffer.from("alpha") },
				{ name: "beta.txt", mimeType: "text/plain", buffer: Buffer.from("beta") },
			]);
			await expect(editor.locator("attachment-tile")).toHaveCount(2);

			await textarea.press("Enter");

			await expect(textarea).toHaveValue("");
			await expect(editor.locator("attachment-tile")).toHaveCount(0);
			await expect.poll(() => mock.getReceivedCommands("prompt").length, { timeout: 12_000 }).toBe(2);
			const prompts = mock.getReceivedCommands("prompt");
			expect(prompts[1]).toMatchObject({ id: prompts[0].id, operationId: prompts[0].operationId });
			await expect(page.getByText("Prompt failed: Backend transport disconnected", { exact: false })).toHaveCount(0);
		} finally {
			await mock.close();
		}
	});
});

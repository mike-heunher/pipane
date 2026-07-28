import { expect, test } from "@playwright/test";
import { startMockPipaneServer, type MockPipaneServer } from "./mock-pipane-server.js";

const SESSION_PATH = "/tmp/mock-sessions/mobile-sidebar.jsonl";

const sessions = [{
	id: "mobile-sidebar",
	path: SESSION_PATH,
	cwd: "/Users/dev/mobile-project",
	name: "Mobile sidebar",
	created: new Date().toISOString(),
	modified: new Date().toISOString(),
	lastUserPromptTime: new Date().toISOString(),
	messageCount: 0,
	firstMessage: "",
}];

test.describe("Mobile sidebar", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	let mock: MockPipaneServer;

	test.beforeAll(async () => {
		mock = await startMockPipaneServer({
			sessions,
			states: { [SESSION_PATH]: [] },
			browse: { path: "/Users/dev", dirs: [] },
		});
	});
	test.afterAll(async () => { await mock.close(); });
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			const viewport = new EventTarget() as EventTarget & Record<string, number>;
			Object.assign(viewport, {
				offsetTop: 0,
				offsetLeft: 0,
				width: 390,
				height: 844,
				scale: 1,
			});
			Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
			(window as typeof window & { setTestVisualViewport: (top: number, height: number) => void }).setTestVisualViewport = (top, height) => {
				viewport.offsetTop = top;
				viewport.height = height;
				viewport.dispatchEvent(new Event("resize"));
			};
		});
	});

	test("opening it dismisses the composer keyboard without recreating the editor", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);

		const textarea = page.locator("message-editor textarea");
		await expect(textarea).toBeVisible();
		await textarea.focus();
		await expect(textarea).toBeFocused();
		await textarea.evaluate((element) => { element.dataset.mobileSidebarOriginal = "true"; });

		await page.getByRole("button", { name: "Open sessions" }).click();

		await expect(page.locator(".sidebar-mobile-overlay")).toBeVisible();
		await expect(page.locator("textarea[data-mobile-sidebar-original='true']")).toHaveCount(1);
		await expect(textarea).not.toBeFocused();
	});

	test("keeps the composer and bottom status inside the visual viewport across renders", async ({ page }) => {
		await page.goto(`http://localhost:${mock.port}`);
		await page.getByRole("button", { name: "Open sessions" }).click();
		await page.locator("session-picker").evaluate((picker: any) => {
			picker.shadowRoot.querySelector(".session-item")?.click();
		});

		const textarea = page.locator("message-editor textarea");
		await expect(textarea).toBeVisible();
		await textarea.focus();
		await page.evaluate(() => {
			(window as typeof window & { setTestVisualViewport: (top: number, height: number) => void })
				.setTestVisualViewport(120, 500);
		});

		mock.sendSessionState(SESSION_PATH, { isStreaming: true });
		await expect(page.locator(".conversation-status-bar")).toHaveClass(/is-streaming/);

		const layout = await page.evaluate(() => {
			const shell = document.querySelector(".app-viewport-shell")!.getBoundingClientRect();
			const editor = document.querySelector("message-editor")!.getBoundingClientRect();
			const status = document.querySelector(".conversation-status-bar")!.getBoundingClientRect();
			return {
				shellTop: shell.top,
				shellHeight: shell.height,
				editorBottom: editor.bottom,
				statusTop: status.top,
				statusBottom: status.bottom,
			};
		});
		expect(layout.shellTop).toBeCloseTo(120, 0);
		expect(layout.shellHeight).toBeCloseTo(500, 0);
		expect(layout.editorBottom).toBeLessThanOrEqual(620);
		expect(layout.statusTop).toBeGreaterThanOrEqual(120);
		expect(layout.statusBottom).toBeLessThanOrEqual(620);
	});
});

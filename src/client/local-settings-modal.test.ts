import { beforeEach, describe, expect, it, vi } from "vitest";
import { openLocalSettingsDialog } from "./local-settings-modal.js";

const SETTINGS = {
	version: 1 as const,
	sidebar: {
		cwdTitle: {
			filters: [{ pattern: "^~/dev/", replacement: "dev/" }],
		},
		sessionsPerProject: 7,
	},
	canvas: { enabled: true },
	appearance: {
		colorTheme: "gruvbox",
		darkMode: "dark",
		showTokenUsage: true,
	},
	toolCollapse: { keepOpen: 4 },
	messages: { initialCount: 75 },
};

function createApi() {
	return {
		getLocalSettings: vi.fn().mockResolvedValue({
			path: "/home/test/.piweb/settings.json",
			exists: true,
			errors: [],
			settings: structuredClone(SETTINGS),
			formatted: `${JSON.stringify(SETTINGS, null, 2)}\n`,
		}),
		saveLocalSettings: vi.fn().mockResolvedValue({
			valid: true,
			errors: [],
			formatted: `${JSON.stringify(SETTINGS, null, 2)}\n`,
		}),
	};
}

async function waitForSettings(): Promise<HTMLElement> {
	await vi.waitFor(() => {
		expect(document.querySelector(".local-settings-status.is-valid")).not.toBeNull();
	});
	return document.querySelector(".local-settings-panel") as HTMLElement;
}

function clickCategory(panel: HTMLElement, label: string): void {
	const button = Array.from(panel.querySelectorAll<HTMLButtonElement>(".local-settings-nav-item"))
		.find((candidate) => candidate.textContent?.trim() === label);
	expect(button).toBeDefined();
	button!.click();
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("local settings command center", () => {
	it("loads categorized controls and filters categories with search", async () => {
		const api = createApi();
		const closed = openLocalSettingsDialog({ api });
		const panel = await waitForSettings();

		expect(panel.getAttribute("role")).toBe("dialog");
		expect(panel.querySelector(".local-settings-nav-item.is-active")?.textContent?.trim()).toBe("Sidebar");
		expect(panel.querySelector(".local-settings-content-header h3")?.textContent).toBe("Sidebar");
		expect(panel.querySelectorAll(".local-settings-nav-item")).toHaveLength(6);

		const search = panel.querySelector<HTMLInputElement>(".local-settings-search input")!;
		search.value = "token";
		search.dispatchEvent(new Event("input", { bubbles: true }));

		expect(panel.querySelectorAll(".local-settings-nav-item")).toHaveLength(1);
		expect(panel.querySelector(".local-settings-nav-item")?.textContent?.trim()).toBe("Appearance");
		expect(panel.querySelector(".local-settings-content-header h3")?.textContent).toBe("Appearance");
		expect(panel.textContent).toContain("Show token usage");

		panel.querySelector<HTMLButtonElement>(".local-settings-close")!.click();
		await closed;
		expect(document.querySelector(".local-settings-overlay")).toBeNull();
	});

	it("saves edited settings as validated structured JSON", async () => {
		const api = createApi();
		const onSaved = vi.fn();
		const closed = openLocalSettingsDialog({ api, onSaved });
		const panel = await waitForSettings();

		const sessions = panel.querySelector<HTMLInputElement>('input[aria-label="Sessions per project"]')!;
		sessions.value = "9";
		sessions.dispatchEvent(new Event("input", { bubbles: true }));

		clickCategory(panel, "Appearance");
		const colorTheme = panel.querySelector<HTMLSelectElement>('select[aria-label="Color theme"]')!;
		colorTheme.value = "default";
		colorTheme.dispatchEvent(new Event("change", { bubbles: true }));
		panel.querySelector<HTMLButtonElement>('button[aria-label="Show token usage"]')!.click();

		clickCategory(panel, "Messages");
		const initialCount = panel.querySelector<HTMLInputElement>('input[aria-label="Messages loaded initially"]')!;
		initialCount.value = "30";
		initialCount.dispatchEvent(new Event("input", { bubbles: true }));
		const hideOlderThinking = panel.querySelector<HTMLButtonElement>('button[aria-label="Hide older thinking"]')!;
		expect(hideOlderThinking.getAttribute("aria-checked")).toBe("false");
		hideOlderThinking.click();
		const keepThinkingParts = panel.querySelector<HTMLInputElement>('input[aria-label="Thinking parts kept visible"]')!;
		expect(keepThinkingParts.value).toBe("3");
		keepThinkingParts.value = "2";
		keepThinkingParts.dispatchEvent(new Event("input", { bubbles: true }));

		panel.querySelector<HTMLButtonElement>(".local-settings-btn-primary")!.click();
		await closed;

		expect(api.saveLocalSettings).toHaveBeenCalledOnce();
		const saved = JSON.parse(api.saveLocalSettings.mock.calls[0][0]);
		expect(saved.sidebar.sessionsPerProject).toBe(9);
		expect(saved.sidebar.cwdTitle.filters).toEqual([{ pattern: "^~/dev/", replacement: "dev/" }]);
		expect(saved.appearance).toEqual({ colorTheme: "default", darkMode: "dark", showTokenUsage: false });
		expect(saved.messages).toEqual({
			initialCount: 30,
			hideOlderThinking: true,
			keepThinkingParts: 2,
		});
		expect(saved.toolCollapse.keepOpen).toBe(4);
		expect(onSaved).toHaveBeenCalledWith(saved);
	});

	it("keeps the modal open and reports invalid numeric settings", async () => {
		const api = createApi();
		const closed = openLocalSettingsDialog({ api });
		const panel = await waitForSettings();
		const sessions = panel.querySelector<HTMLInputElement>('input[aria-label="Sessions per project"]')!;
		sessions.value = "0";
		sessions.dispatchEvent(new Event("input", { bubbles: true }));

		panel.querySelector<HTMLButtonElement>(".local-settings-btn-primary")!.click();

		expect(api.saveLocalSettings).not.toHaveBeenCalled();
		expect(panel.querySelector(".local-settings-status.is-error")?.textContent).toContain("positive whole number");
		expect(document.body.contains(panel)).toBe(true);

		panel.querySelector<HTMLButtonElement>(".local-settings-close")!.click();
		await closed;
	});

	it("opens the JSONL viewer from the Messages category", async () => {
		const api = createApi();
		const onToggleJsonl = vi.fn();
		const closed = openLocalSettingsDialog({ api, onToggleJsonl, isJsonlVisible: false });
		const panel = await waitForSettings();

		clickCategory(panel, "Messages");
		const openViewer = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"))
			.find((button) => button.textContent === "Open viewer");
		expect(openViewer).toBeDefined();
		openViewer!.click();
		await closed;

		expect(onToggleJsonl).toHaveBeenCalledOnce();
		expect(document.querySelector(".local-settings-overlay")).toBeNull();
	});
});

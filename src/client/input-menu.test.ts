import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureInputMenuButton, getSessionJsonlFilename } from "./input-menu.js";

describe("input menu", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("extracts jsonl filename from a full path", () => {
		expect(getSessionJsonlFilename("/tmp/pi/sessions/chat_abc123.jsonl")).toBe("chat_abc123.jsonl");
		expect(getSessionJsonlFilename(undefined)).toBe("");
	});

	it("injects a hamburger menu button into the editor toolbar", () => {
		const editor = document.createElement("div");
		const toolbar = document.createElement("div");
		toolbar.className = "flex gap-2 items-center";
		editor.appendChild(toolbar);

		ensureInputMenuButton(editor, () => "/tmp/pi/sessions/chat_abc123.jsonl");

		const button = editor.querySelector(".injected-menu-btn");
		expect(button).not.toBeNull();
	});

	it("copies the attached session jsonl filename from the menu", async () => {
		const editor = document.createElement("div");
		const toolbar = document.createElement("div");
		toolbar.className = "flex gap-2 items-center";
		editor.appendChild(toolbar);
		document.body.appendChild(editor);

		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		ensureInputMenuButton(editor, () => "/tmp/pi/sessions/chat_abc123.jsonl");
		(editor.querySelector(".injected-menu-btn") as HTMLButtonElement).click();
		(editor.querySelector(".menu-copy-session-file") as HTMLButtonElement).click();

		expect(writeText).toHaveBeenCalledWith("chat_abc123.jsonl");
	});
});

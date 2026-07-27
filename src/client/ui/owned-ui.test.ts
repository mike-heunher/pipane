import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./index.js";
import { MarkdownBlock } from "./components/MarkdownBlock.js";
import { MessageEditor } from "./components/MessageEditor.js";
import { PiMessageList } from "./components/MessageList.js";
import { formatToolRuntime, ToolRuntime } from "./components/Messages.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { getToolRenderer, renderTool } from "./tool-registry.js";
import { escapeStrikethrough } from "./utils/markdown.js";
import { mergeSlashCommands } from "../slash-commands.js";

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function sourceFiles(root: string): string[] {
	const result: string[] = [];
	for (const name of readdirSync(root)) {
		const file = path.join(root, name);
		if (statSync(file).isDirectory()) result.push(...sourceFiles(file));
		else if (/\.(?:ts|tsx|js)$/.test(name)) result.push(file);
	}
	return result;
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("owned UI architecture", () => {
	it("has no upstream web-ui package, patch-package, patch directory, or prototype mutation", () => {
		const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
		expect(packageJson.dependencies?.["@mariozechner/pi-web-ui"]).toBeUndefined();
		expect(packageJson.dependencies?.["@earendil-works/pi-web-ui"]).toBeUndefined();
		expect(packageJson.dependencies?.["patch-package"]).toBeUndefined();
		expect(packageJson.scripts?.postinstall).toBeUndefined();
		expect(existsSync(path.resolve("patches"))).toBe(false);

		const clientSource = sourceFiles(path.resolve("src/client"))
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		expect(clientSource).not.toMatch(/from ["']@(?:mariozechner|earendil-works)\/pi-web-ui/);
		expect(clientSource).not.toMatch(/\.prototype\.[A-Za-z_$][\w$]*\s*=/);
	});

	it("registers only the local flat renderer component path", () => {
		expect(customElements.get("markdown-block")).toBe(MarkdownBlock);
		expect(customElements.get("pi-message-list")).toBe(PiMessageList);
		expect(customElements.get("message-editor")).toBe(MessageEditor);
		expect(customElements.get("thinking-block")).toBe(ThinkingBlock);
		expect(customElements.get("streaming-message-container")).toBeUndefined();
		expect(customElements.get("agent-interface")).toBeUndefined();
	});
});

describe("owned markdown renderer", () => {
	it("renders Unicode punctuation in math without KaTeX strict-mode warnings", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const block = new MarkdownBlock();
		block.content = "Range: $1–2$";
		document.body.appendChild(block);
		await block.updateComplete;

		expect(block.querySelector(".katex")).not.toBeNull();
		expect(warning).not.toHaveBeenCalled();
	});
});

describe("owned message editor", () => {
	it("sends steering input while streaming and still exposes abort", async () => {
		const editor = new MessageEditor();
		editor.isStreaming = true;
		editor.allowSendDuringStreaming = true;
		editor.value = "steer this turn";
		editor.currentModel = { provider: "test", id: "model" } as any;
		const onSend = vi.fn();
		const onAbort = vi.fn();
		editor.onSend = onSend;
		editor.onAbort = onAbort;
		document.body.appendChild(editor);
		await editor.updateComplete;

		const textarea = editor.querySelector("textarea")!;
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onSend).toHaveBeenCalledWith("steer this turn", []);

		const buttons = Array.from(editor.querySelectorAll("button"));
		expect(buttons.length).toBeGreaterThanOrEqual(3);
		editor.querySelector<HTMLButtonElement>(".status-stop-button")!.click();
		expect(onAbort).toHaveBeenCalledOnce();
	});

	it("renders the calm status hierarchy below the prompt controls", async () => {
		const editor = new MessageEditor();
		editor.isStreaming = true;
		editor.allowSendDuringStreaming = true;
		editor.value = "steer";
		editor.currentModel = { provider: "test", id: "gpt-5.6-sol" } as any;
		document.body.appendChild(editor);
		await editor.updateComplete;

		const inputLine = editor.querySelector(".message-editor-input-line")!;
		expect(inputLine.querySelector("textarea")).not.toBeNull();
		expect(inputLine.querySelector<HTMLButtonElement>("[aria-label='Attach files']")?.disabled).toBe(false);
		expect(inputLine.querySelector<HTMLButtonElement>(".message-send-action")?.disabled).toBe(false);

		const status = editor.querySelector(".conversation-status-bar")!;
		expect(status.compareDocumentPosition(inputLine) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
		expect(status.querySelector(".conversation-status-dot")?.getAttribute("title")).toBe("Agent working");
		expect(status.querySelector(".status-model-name")?.textContent).toBe("gpt-5.6-sol");
		expect(status.querySelector(".status-model-button")?.getAttribute("title"))
			.toBe("Change model (currently gpt-5.6-sol)");
		expect(status.querySelector(".status-escape-hint")).toBeNull();
		expect(status.querySelector(".status-stop-button")?.getAttribute("title"))
			.toBe("Stop generation (Esc)");
	});

	it("uploads arbitrary dropped files and retains their backend path", async () => {
		const editor = new MessageEditor();
		const onFileUpload = vi.fn(async () => "/tmp/pipane-upload-test/bundle.tar");
		editor.onFileUpload = onFileUpload;
		document.body.appendChild(editor);
		await editor.updateComplete;

		const file = new File([new Uint8Array([0, 1, 2, 255])], "bundle.tar", {
			type: "application/x-tar",
		});
		await (editor as any).handleDrop({
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
			dataTransfer: { files: [file] },
		});

		expect(onFileUpload).toHaveBeenCalledWith(expect.objectContaining({
			type: "document",
			fileName: "bundle.tar",
			mimeType: "application/x-tar",
		}));
		expect(editor.attachments).toEqual([
			expect.objectContaining({ uploadedPath: "/tmp/pipane-upload-test/bundle.tar" }),
		]);
		expect(editor.querySelector<HTMLInputElement>("input[type=file]")?.accept).toBe("");
	});

	it("uploads images before retaining them in the composer", async () => {
		const editor = new MessageEditor();
		const onFileUpload = vi.fn(async () => "/tmp/pipane-upload-test/photo.png");
		editor.onFileUpload = onFileUpload;
		document.body.appendChild(editor);
		await editor.updateComplete;

		await (editor as any).handleDrop({
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
			dataTransfer: {
				files: [new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })],
			},
		});

		expect(onFileUpload).toHaveBeenCalledWith(expect.objectContaining({
			type: "image",
			fileName: "photo.png",
			content: "AQID",
		}));
		expect(editor.attachments).toEqual([
			expect.objectContaining({ uploadedPath: "/tmp/pipane-upload-test/photo.png" }),
		]);
	});

	it("does not submit Enter while an IME composition is active", async () => {
		const editor = new MessageEditor();
		editor.value = "変換中";
		const onSend = vi.fn();
		editor.onSend = onSend;
		document.body.appendChild(editor);
		await editor.updateComplete;

		const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
		Object.defineProperty(event, "isComposing", { value: true });
		editor.querySelector("textarea")!.dispatchEvent(event);
		expect(onSend).not.toHaveBeenCalled();
	});

	it("fuzzy-filters slash commands with help and inserts a selection without sending", async () => {
		const editor = new MessageEditor();
		editor.slashCommands = mergeSlashCommands([
			{ name: "project-review", description: "Review the current project", source: "prompt" },
			{ name: "skill:search", description: "Search the web", source: "skill" },
		]);
		const onSend = vi.fn();
		editor.onSend = onSend;
		document.body.appendChild(editor);
		await editor.updateComplete;

		const textarea = editor.querySelector("textarea")!;
		textarea.value = "/pjrv";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await editor.updateComplete;

		const options = editor.querySelectorAll(".slash-command-option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("/project-review");
		expect(options[0].textContent).toContain("Review the current project");
		expect(options[0].textContent).toContain("Prompt");

		(options[0] as HTMLButtonElement).click();
		await editor.updateComplete;
		expect(textarea.value).toBe("/project-review ");
		expect(editor.querySelector(".slash-command-menu")).toBeNull();
		expect(onSend).not.toHaveBeenCalled();

		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onSend).toHaveBeenCalledWith("/project-review ", []);
	});

	it("supports slash-menu keyboard navigation and lets Escape dismiss before aborting", async () => {
		const editor = new MessageEditor();
		editor.isStreaming = true;
		editor.slashCommands = mergeSlashCommands([]);
		const onAbort = vi.fn();
		editor.onAbort = onAbort;
		document.body.appendChild(editor);
		await editor.updateComplete;

		const textarea = editor.querySelector("textarea")!;
		textarea.value = "/";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		await editor.updateComplete;
		expect(textarea.value).toBe("/new");

		textarea.value = "/";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await editor.updateComplete;
		expect(editor.querySelector(".slash-command-menu")).toBeNull();
		expect(onAbort).not.toHaveBeenCalled();
	});
});

describe("owned message and tool rendering", () => {
	it("renders one assistant/tool tree from the flat message array", async () => {
		const list = new PiMessageList();
		list.messages = [
			{ role: "user", content: "run it", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "Bash", arguments: { command: "echo ok" } }],
				stopReason: "toolUse",
				timestamp: 2,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "Bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			},
		] as any;
		list.pendingToolCalls = new Set(["call-1"]);
		list.isStreaming = true;
		document.body.appendChild(list);
		await list.updateComplete;
		await settle();

		expect(list.querySelectorAll("assistant-message")).toHaveLength(1);
		expect(list.querySelectorAll("tool-message")).toHaveLength(1);
		expect(list.querySelector("tool-message")?.getAttribute("data-tool-call-id")).toBe("call-1");
	});

	it("expands truncated history and resets only when the session changes", async () => {
		const makeMessages = (count: number) => Array.from({ length: count }, (_, index) => ({
			role: "user",
			content: `message ${index + 1}`,
			timestamp: index + 1,
		})) as any;
		const list = new PiMessageList();
		list.sessionPath = "/tmp/a.jsonl";
		list.initialCount = 2;
		list.messages = makeMessages(5);
		document.body.appendChild(list);
		await list.updateComplete;

		expect(list.querySelectorAll("user-message")).toHaveLength(2);
		expect(list.querySelector(".show-earlier-btn")?.textContent).toContain("3 hidden");
		(list.querySelector(".show-earlier-btn") as HTMLButtonElement).click();
		await list.updateComplete;
		expect(list.querySelectorAll("user-message")).toHaveLength(4);

		// Session snapshots contain fresh object identities and must not collapse
		// history that the user already expanded.
		list.messages = makeMessages(6);
		await list.updateComplete;
		expect(list.querySelectorAll("user-message")).toHaveLength(4);

		list.sessionPath = "/tmp/b.jsonl";
		await list.updateComplete;
		expect(list.querySelectorAll("user-message")).toHaveLength(2);
	});

	it("paints a small tail before expanding to the configured history window", async () => {
		const list = new PiMessageList();
		list.sessionPath = "/tmp/progressive.jsonl";
		list.initialCount = 20;
		list.firstPaintCount = 3;
		list.messages = Array.from({ length: 30 }, (_, index) => ({
			role: "user",
			content: `message ${index + 1}`,
			timestamp: index + 1,
		})) as any;
		document.body.appendChild(list);
		await list.updateComplete;

		const firstPaint = Array.from(list.querySelectorAll<any>("user-message"), (message) => message.message.content);
		expect(firstPaint).toEqual(["message 28", "message 29", "message 30"]);

		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		await list.updateComplete;
		expect(list.querySelectorAll("user-message")).toHaveLength(20);
		expect(list.querySelector(".show-earlier-btn")?.textContent).toContain("10 hidden");
	});

	it("hides all but the most recent configured thinking parts", async () => {
		const list = new PiMessageList();
		list.hideOlderThinking = true;
		list.keepThinkingParts = 2;
		list.messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "oldest" },
					{ type: "text", text: "First answer" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "middle" },
					{ type: "text", text: "Second answer" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "recent" },
					{ type: "text", text: "Final answer" },
					{ type: "thinking", thinking: "newest" },
				],
			},
		] as any;
		document.body.appendChild(list);
		await list.updateComplete;
		await settle();

		expect(Array.from(list.querySelectorAll<ThinkingBlock>("thinking-block"), (part) => part.content))
			.toEqual(["recent", "newest"]);
		expect(list.textContent).toContain("First answer");

		list.keepThinkingParts = 1;
		await list.updateComplete;
		expect(Array.from(list.querySelectorAll<ThinkingBlock>("thinking-block"), (part) => part.content))
			.toEqual(["newest"]);

		list.keepThinkingParts = 0;
		await list.updateComplete;
		expect(list.querySelectorAll("thinking-block")).toHaveLength(0);

		list.hideOlderThinking = false;
		await list.updateComplete;
		expect(Array.from(list.querySelectorAll<ThinkingBlock>("thinking-block"), (part) => part.content))
			.toEqual(["oldest", "middle", "recent", "newest"]);
	});

	it("renders elapsed time in the output-card corner independently of usage", async () => {
		const list = new PiMessageList();
		list.messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "timed-call", name: "Bash", arguments: { command: "echo ok" } }],
				timestamp: 1_000,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "timed-call",
				toolName: "Bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3_340,
			},
		] as any;
		list.toolCallTimings = {
			"timed-call": { startedAt: 1_000, completedAt: 3_340 },
		};
		document.body.appendChild(list);
		await list.updateComplete;
		await settle();

		const runtime = list.querySelector(".tool-runtime-card > tool-runtime");
		expect(runtime?.textContent?.trim()).toBe("2.3s");
		expect(list.querySelector(".px-4.mt-2.text-xs.text-muted-foreground")).toBeNull();
	});

	it("counts a running tool up live", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-07-20T12:00:05.000Z"));
			const runtime = new ToolRuntime();
			runtime.startedAt = Date.now() - 1_250;
			runtime.running = true;
			document.body.appendChild(runtime);
			await runtime.updateComplete;
			expect(runtime.textContent?.trim()).toBe("1.2s");

			vi.advanceTimersByTime(200);
			await runtime.updateComplete;
			expect(runtime.textContent?.trim()).toBe("1.4s");
			runtime.remove();
		} finally {
			vi.useRealTimers();
		}
	});

	it("formats compact runtimes across minute and hour boundaries", () => {
		expect(formatToolRuntime(23_499)).toBe("23.4s");
		expect(formatToolRuntime(65_430)).toBe("1m 05.4s");
		expect(formatToolRuntime(3_723_450)).toBe("1h 02m 03.4s");
	});

	it("normalizes tool names and owns the generic fallback", () => {
		expect(getToolRenderer("BASH")).toBe(getToolRenderer("bash"));
		expect(renderTool("unknown_extension_tool", { value: 1 }, undefined, true).isCustom).toBe(true);
	});

	it("renders approximation tildes literally while preserving code", () => {
		expect(escapeStrikethrough("about ~500~ and ~~old~~, but `~code~`"))
			.toBe("about \\~500\\~ and \\~\\~old\\~\\~, but `~code~`");
	});

	it("renders thinking token estimates without mutating a prototype", async () => {
		const thinking = new ThinkingBlock();
		thinking.content = "12345678";
		thinking.isStreaming = true;
		document.body.appendChild(thinking);
		await thinking.updateComplete;
		expect(thinking.textContent).toContain("Thinking… (2 tokens)");
	});
});

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./index.js";
import { MessageEditor } from "./components/MessageEditor.js";
import { PiMessageList } from "./components/MessageList.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { getToolRenderer, renderTool } from "./tool-registry.js";

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
		expect(customElements.get("pi-message-list")).toBe(PiMessageList);
		expect(customElements.get("message-editor")).toBe(MessageEditor);
		expect(customElements.get("thinking-block")).toBe(ThinkingBlock);
		expect(customElements.get("streaming-message-container")).toBeUndefined();
		expect(customElements.get("agent-interface")).toBeUndefined();
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

	it("normalizes tool names and owns the generic fallback", () => {
		expect(getToolRenderer("BASH")).toBe(getToolRenderer("bash"));
		expect(renderTool("unknown_extension_tool", { value: 1 }, undefined, true).isCustom).toBe(true);
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

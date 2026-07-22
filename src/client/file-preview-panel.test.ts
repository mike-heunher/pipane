import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpBackendApi } from "./backend-api.js";
import {
	closeFilePreview,
	getFilePreviewPath,
	initFilePreview,
	isFilePreviewVisible,
	isPreviewableFileHref,
	linkifyPreviewableInlineCode,
	openFilePreviewLink,
	resolveFileHref,
	setFilePreviewSession,
} from "./file-preview-panel.js";

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function setupPanel(): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	initFilePreview(container, () => {});
	return container;
}

afterEach(() => {
	closeFilePreview();
	document.body.replaceChildren();
	document.documentElement.classList.remove("dark");
	document.documentElement.removeAttribute("data-color-theme");
	for (const property of ["--background", "--foreground", "--muted-foreground", "--border", "--muted", "--primary"]) {
		document.documentElement.style.removeProperty(property);
	}
	vi.restoreAllMocks();
});

describe("linked file preview", () => {
	it("recognizes local file links without taking over web links or page fragments", () => {
		expect(isPreviewableFileHref("README.md")).toBe(true);
		expect(isPreviewableFileHref("docs/architecture.md#transport")).toBe(true);
		expect(isPreviewableFileHref("file:///tmp/project/notes.md")).toBe(true);
		expect(isPreviewableFileHref("https://example.com/readme.md")).toBe(false);
		expect(isPreviewableFileHref("#transport")).toBe(false);
	});

	it("resolves chat links from the session cwd and nested links from the open file", () => {
		expect(resolveFileHref("docs/guide.md#intro", "/work/project"))
			.toBe("/work/project/docs/guide.md");
		expect(resolveFileHref("../api.md", "/work/project/docs"))
			.toBe("/work/project/api.md");
		expect(resolveFileHref("file:///work/project/README.md#top", "/ignored"))
			.toBe("/work/project/README.md");
	});

	it("linkifies previewable inline-code paths without changing examples or existing links", () => {
		expect(linkifyPreviewableInlineCode("Open `/tmp/project/guide.md` now."))
			.toBe("Open [`/tmp/project/guide.md`](/tmp/project/guide.md) now.");
		expect(linkifyPreviewableInlineCode("Open `docs/guide (draft).md`."))
			.toBe("Open [`docs/guide (draft).md`](docs/guide%20%28draft%29.md).");
		expect(linkifyPreviewableInlineCode("Already [open `linked.md` here](linked.md)."))
			.toBe("Already [open `linked.md` here](linked.md).");
		expect(linkifyPreviewableInlineCode("Endpoint `/api/files/content`; run `npm test`."))
			.toBe("Endpoint `/api/files/content`; run `npm test`.");
		expect(linkifyPreviewableInlineCode("```text\n/tmp/project/guide.md\n```"))
			.toBe("```text\n/tmp/project/guide.md\n```");
	});

	it("renders marked markdown in an isolated iframe", async () => {
		const container = setupPanel();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			path: "/work/project/docs/guide.md",
			content: "# Guide\n\nRead **this**.\n\n| Item | Done |\n| --- | --- |\n| Preview | yes |",
		}), { status: 200, headers: { "Content-Type": "application/json" } }));

		expect(openFilePreviewLink("docs/guide.md", "/work/project", "/sessions/test.jsonl", undefined, new HttpBackendApi({ fetch: fetchMock as typeof fetch }))).toBe(true);
		expect(isFilePreviewVisible()).toBe(true);
		expect(container.textContent).toContain("Loading file");
		await settle();

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/files/content?sessionPath=%2Fsessions%2Ftest.jsonl&path=%2Fwork%2Fproject%2Fdocs%2Fguide.md",
			{ cache: "no-store" },
		);
		expect(getFilePreviewPath()).toBe("/work/project/docs/guide.md");
		expect(container.querySelector(".file-preview-title")?.textContent).toBe("guide.md");
		const frame = container.querySelector<HTMLIFrameElement>(".file-preview-frame");
		expect(frame?.title).toBe("guide.md preview");
		expect(frame?.srcdoc).toContain("<h1>Guide</h1>");
		expect(frame?.srcdoc).toContain("<strong>this</strong>");
		expect(frame?.srcdoc).toContain("<table>");
		expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
		expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
	});

	it("renders KaTeX math with the active application theme", async () => {
		const root = document.documentElement;
		root.classList.add("dark");
		root.style.setProperty("--background", "#282828");
		root.style.setProperty("--foreground", "#ebdbb2");
		root.style.setProperty("--muted-foreground", "#a89984");
		root.style.setProperty("--border", "#665c54");
		root.style.setProperty("--muted", "#504945");
		root.style.setProperty("--primary", "#83a598");

		const container = setupPanel();
		const api = {
			getFileContent: vi.fn(async () => ({
				path: "/work/project/math.md",
				content: "Dollar $E = mc^2$ and LaTeX \\(a^2 + b^2 = c^2\\).\n\n$$\n\\int_0^1 x^2 \\, dx\n$$\n\n\\[\n\\sum_{n=1}^{\\infty} n^{-2}\n\\]",
			})),
		};
		openFilePreviewLink("math.md", "/work/project", "/sessions/math.jsonl", undefined, api);
		await settle();

		let frame = container.querySelector<HTMLIFrameElement>(".file-preview-frame");
		expect(frame?.srcdoc.match(/class="katex"/g)).toHaveLength(4);
		expect(frame?.srcdoc.match(/class="katex-display"/g)).toHaveLength(2);
		expect(frame?.srcdoc).toContain("color-scheme: dark");
		expect(frame?.srcdoc).toContain("--bg: #282828");
		expect(frame?.srcdoc).toContain("--link: #83a598");

		root.style.setProperty("--background", "#fbf1c7");
		root.classList.remove("dark");
		root.setAttribute("data-color-theme", "gruvbox");
		await settle();
		frame = container.querySelector<HTMLIFrameElement>(".file-preview-frame");
		expect(frame?.srcdoc).toContain("color-scheme: light");
		expect(frame?.srcdoc).toContain("--bg: #fbf1c7");
	});

	it("keeps each session's open preview isolated and restores it without reloading", async () => {
		const container = setupPanel();
		const sessionA = "/sessions/a.jsonl";
		const sessionB = "/sessions/b.jsonl";
		const api = {
			getFileContent: vi.fn(async (_sessionPath: string, filePath: string) => ({
				path: filePath,
				content: filePath.endsWith("guide.md") ? "# Guide A" : "# Notes B",
			})),
		};

		openFilePreviewLink("guide.md", "/work/a", sessionA, undefined, api);
		await settle();
		expect(container.querySelector(".file-preview-title")?.textContent).toBe("guide.md");

		setFilePreviewSession(sessionB);
		expect(isFilePreviewVisible()).toBe(false);
		expect(container.querySelector(".file-preview-panel")).toBeNull();

		openFilePreviewLink("notes.md", "/work/b", sessionB, undefined, api);
		await settle();
		expect(container.querySelector(".file-preview-title")?.textContent).toBe("notes.md");

		setFilePreviewSession(sessionA);
		expect(isFilePreviewVisible()).toBe(true);
		expect(container.querySelector(".file-preview-title")?.textContent).toBe("guide.md");
		expect(api.getFileContent).toHaveBeenCalledTimes(2);

		setFilePreviewSession(sessionB);
		expect(container.querySelector(".file-preview-title")?.textContent).toBe("notes.md");
		closeFilePreview();
		setFilePreviewSession(sessionA);
		closeFilePreview();
	});

	it("renders HTML with active scripts in an isolated iframe", async () => {
		const container = setupPanel();
		const source = "<!doctype html><html><head><title>Demo</title></head><body><h1>Interactive</h1><script>const template = '<head>'; document.body.dataset.ready = 'yes';<\/script></body></html>";
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			path: "/work/project/demo.html",
			content: source,
		}), { status: 200, headers: { "Content-Type": "application/json" } }));

		openFilePreviewLink("demo.html", "/work/project", "/sessions/test.jsonl", undefined, new HttpBackendApi({ fetch: fetchMock as typeof fetch }));
		await settle();

		const frame = container.querySelector<HTMLIFrameElement>(".file-preview-frame");
		expect(frame?.srcdoc).toContain("<h1>Interactive</h1>");
		expect(frame?.srcdoc).toContain("const template = '<head>'");
		expect(frame?.srcdoc).toContain("document.body.dataset.ready = 'yes'");
		expect(frame?.srcdoc).toMatch(/^<!doctype html><script>/);
		expect(frame?.srcdoc.indexOf("pipane:file-preview-link")).toBeLessThan(frame?.srcdoc.indexOf("const template") ?? 0);
		expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
	});

	it("renders non-markdown text as escaped source", async () => {
		const container = setupPanel();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			path: "/work/project/src/main.ts",
			content: "const value = '<safe>';",
		}), { status: 200, headers: { "Content-Type": "application/json" } }));

		openFilePreviewLink("src/main.ts", "/work/project", "/sessions/test.jsonl", undefined, new HttpBackendApi({ fetch: fetchMock as typeof fetch }));
		await settle();

		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector(".file-preview-source")?.textContent).toBe("const value = '<safe>';" );
		expect(container.querySelector(".file-preview-source")?.innerHTML).not.toContain("<safe>");
	});

	it("shows retrieval errors without navigating away", async () => {
		const container = setupPanel();
		const fetchMock = vi.fn(async () => new Response(
			JSON.stringify({ error: "File not found" }),
			{ status: 404, headers: { "Content-Type": "application/json" } },
		));

		openFilePreviewLink("missing.md", "/work/project", "/sessions/test.jsonl", undefined, new HttpBackendApi({ fetch: fetchMock as typeof fetch }));
		await settle();

		expect(container.querySelector("[role=alert]")?.textContent).toContain("File not found");
	});

	it("resizes behind a viewport overlay and supports keyboard adjustments", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const container = setupPanel();
		host.appendChild(container);
		vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
		vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 450 } as DOMRect);
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			path: "/work/project/docs/guide.md",
			content: "# Guide",
		}), { status: 200, headers: { "Content-Type": "application/json" } }));

		openFilePreviewLink("docs/guide.md", "/work/project", "/sessions/test.jsonl", undefined, new HttpBackendApi({ fetch: fetchMock as typeof fetch }));
		await settle();

		const handle = container.querySelector<HTMLElement>(".file-preview-resize-handle");
		expect(handle?.getAttribute("role")).toBe("separator");
		handle?.dispatchEvent(new PointerEvent("pointerdown", {
			bubbles: true,
			button: 0,
			clientX: 500,
			isPrimary: true,
			pointerId: 7,
		}));
		expect(document.body.classList.contains("is-file-preview-resizing")).toBe(true);
		expect(document.querySelector(".file-preview-resize-overlay")).not.toBeNull();

		window.dispatchEvent(new PointerEvent("pointermove", {
			clientX: 440,
			isPrimary: true,
			pointerId: 7,
		}));
		expect(container.style.width).toBe("510px");
		expect(handle?.getAttribute("aria-valuenow")).toBe("510");

		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
		expect(document.querySelector(".file-preview-resize-overlay")).toBeNull();
		expect(document.body.classList.contains("is-file-preview-resizing")).toBe(false);

		handle?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
		expect(container.style.width).toBe("494px");
	});
});

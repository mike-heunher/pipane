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

	it("loads and renders markdown in the right-hand pane", async () => {
		const container = setupPanel();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			path: "/work/project/docs/guide.md",
			content: "# Guide\n\nRead **this**.",
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
		expect((container.querySelector("markdown-block") as any).content).toContain("# Guide");
	});

	it("renders non-markdown text as escaped source", async () => {
		const container = setupPanel();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			path: "/work/project/src/main.ts",
			content: "const value = '<safe>';",
		}), { status: 200, headers: { "Content-Type": "application/json" } }));

		openFilePreviewLink("src/main.ts", "/work/project", "/sessions/test.jsonl", undefined, new HttpBackendApi({ fetch: fetchMock as typeof fetch }));
		await settle();

		expect(container.querySelector("markdown-block")).toBeNull();
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
});

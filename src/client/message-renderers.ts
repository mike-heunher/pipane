/**
 * Custom message renderer for user messages that includes inline images.
 *
 * pi-coding-agent stores user messages with role "user" and content as an array
 * of TextContent and ImageContent blocks. The default UserMessage
 * component only renders text from the content array and ignores ImageContent.
 * This renderer adds support for displaying those inline images.
 */

import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import type { UserMessage as UserMessageType, ImageContent } from "@mariozechner/pi-ai";
import { html } from "lit";

function openImageFullscreen(img: HTMLImageElement) {
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out;";
	const fullImg = document.createElement("img");
	fullImg.src = img.src;
	fullImg.style.cssText = "max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px;";
	overlay.appendChild(fullImg);
	overlay.addEventListener("click", () => overlay.remove());
	document.addEventListener("keydown", function handler(e: KeyboardEvent) {
		if (e.key === "Escape") {
			overlay.remove();
			document.removeEventListener("keydown", handler);
		}
	});
	document.body.appendChild(overlay);
}

registerMessageRenderer("user", {
	render(message: UserMessageType) {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content.find((c) => c.type === "text")?.text || "";

		const inlineImages: ImageContent[] =
			typeof message.content === "string"
				? []
				: (message.content.filter((c) => c.type === "image") as ImageContent[]);

		return html`
			<div class="flex justify-start mx-4">
				<div class="user-message-container py-2 px-4 rounded-xl">
					<markdown-block .content=${content}></markdown-block>
					${inlineImages.length > 0
						? html`
							<div class="mt-3 flex flex-wrap gap-2">
								${inlineImages.map(
									(img) => html`<img
										src="data:${img.mimeType};base64,${img.data}"
										alt="Attached image"
										class="max-w-xs max-h-64 rounded-md border border-border object-contain cursor-pointer"
										@click=${(e: Event) => openImageFullscreen(e.target as HTMLImageElement)}
									/>`,
								)}
							</div>
						`
						: ""}
				</div>
			</div>
		`;
	},
});

import { describe, expect, it } from "vitest";
import { conversationDraftKey, ConversationDraftStore } from "./conversation-drafts.js";

describe("conversation drafts", () => {
	it("uses persisted paths and virtual IDs as distinct conversation identities", () => {
		expect(conversationDraftKey("/tmp/sessions/a.jsonl", "ignored"))
			.toBe("session:/tmp/sessions/a.jsonl");
		expect(conversationDraftKey(undefined, "new-a")).toBe("virtual:new-a");
		expect(conversationDraftKey("/tmp/sessions/a.jsonl", "ignored", "b_host"))
			.toBe("backend:b_host:session:/tmp/sessions/a.jsonl");
	});

	it("keeps text and attachments isolated by conversation", () => {
		const drafts = new ConversationDraftStore<{ name: string }>();
		const originalAttachments = [{ name: "alpha.txt" }];

		drafts.setValue("a", "draft A");
		drafts.setAttachments("a", originalAttachments);
		drafts.setValue("b", "draft B");
		originalAttachments.push({ name: "later.txt" });

		expect(drafts.get("a")).toEqual({
			value: "draft A",
			attachments: [{ name: "alpha.txt" }],
		});
		expect(drafts.get("b")).toEqual({ value: "draft B", attachments: [] });
		expect(drafts.get("missing")).toEqual({ value: "", attachments: [] });
	});

	it("clears only the selected conversation after sending or removing its last content", () => {
		const drafts = new ConversationDraftStore<string>();
		drafts.setValue("a", "draft A");
		drafts.setValue("b", "draft B");

		drafts.clear("a");
		expect(drafts.get("a")).toEqual({ value: "", attachments: [] });
		expect(drafts.get("b").value).toBe("draft B");

		drafts.setAttachments("b", ["file"]);
		drafts.setValue("b", "");
		expect(drafts.get("b")).toEqual({ value: "", attachments: ["file"] });
		drafts.setAttachments("b", []);
		expect(drafts.get("b")).toEqual({ value: "", attachments: [] });
	});
});

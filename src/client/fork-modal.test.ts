import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForkBackendClient } from "./backend-client.js";
import { ForkModal } from "./fork-modal.js";

function createAgent(overrides: Partial<ForkBackendClient> = {}): ForkBackendClient {
	return {
		getForkMessages: vi.fn().mockResolvedValue([{ entryId: "entry-1", text: "Earlier prompt" }]),
		fork: vi.fn().mockResolvedValue({ text: "Earlier prompt", cancelled: false, newSessionPath: "/sessions/earlier.jsonl" }),
		forkCurrent: vi.fn().mockResolvedValue({ newSessionPath: "/sessions/current.jsonl" }),
		...overrides,
	};
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("ForkModal", () => {
	it("offers a complete current-state fork without restoring a draft", async () => {
		const agent = createAgent();
		const modal = new ForkModal();
		document.body.appendChild(modal);
		const result = modal.open(agent);
		await modal.updateComplete;

		const button = modal.shadowRoot!.querySelector<HTMLButtonElement>(".current-state")!;
		expect(button.textContent).toContain("Fork current state");
		button.click();

		await expect(result).resolves.toEqual({ text: "", newSessionPath: "/sessions/current.jsonl" });
		expect(agent.forkCurrent).toHaveBeenCalledOnce();
		expect(agent.fork).not.toHaveBeenCalled();
		expect(modal.isConnected).toBe(false);
	});

	it("still forks from an earlier message and returns its text", async () => {
		const agent = createAgent();
		const modal = new ForkModal();
		document.body.appendChild(modal);
		const result = modal.open(agent);
		await vi.waitFor(() => {
			expect(modal.shadowRoot!.querySelector(".message-item")).not.toBeNull();
		});

		modal.shadowRoot!.querySelector<HTMLButtonElement>(".message-item")!.click();

		await expect(result).resolves.toEqual({
			text: "Earlier prompt",
			newSessionPath: "/sessions/earlier.jsonl",
		});
		expect(agent.fork).toHaveBeenCalledWith("entry-1");
	});
});

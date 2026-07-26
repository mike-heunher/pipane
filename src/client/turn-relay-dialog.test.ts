import { afterEach, describe, expect, it, vi } from "vitest";
import { openTurnRelayDialog } from "./turn-relay-dialog.js";
import type { TurnRelayProfile } from "./turn-relay.js";

afterEach(() => document.body.replaceChildren());

function input(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	target.value = value;
	target.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TURN relay settings dialog", () => {
	it("guides Metered setup, tests temporary credentials, and saves locally", async () => {
		const save = vi.fn(async (_profile: TurnRelayProfile) => undefined);
		const testProfile = vi.fn(async () => ({
			url: "turns:global.relay.metered.ca:443?transport=tcp",
			protocol: "tcp",
			relayProtocol: "tls",
		}));
		const onSaved = vi.fn();
		const closed = openTurnRelayDialog({
			store: { load: async () => undefined, save, clear: vi.fn() },
			testProfile,
			onSaved,
			saveLabel: "Save and reconnect",
		});
		await vi.waitFor(() => expect(document.querySelector("[data-testid='turn-relay-dialog']")).not.toBeNull());
		const fields = document.querySelectorAll<HTMLInputElement>(".turn-relay-field input");
		input(fields[0], "my-pipane");
		input(fields[1], "dedicated-api-key");
		(document.querySelector("[data-testid='turn-relay-test']") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(testProfile).toHaveBeenCalledWith(expect.objectContaining({
			kind: "metered",
			application: "my-pipane",
			apiKey: "dedicated-api-key",
		}), "d_turn_test"));
		await vi.waitFor(() => expect(document.querySelector(".turn-relay-status")?.textContent).toContain("Relay test passed"));
		const saveButton = document.querySelector("[data-testid='turn-relay-save']") as HTMLButtonElement;
		await vi.waitFor(() => expect(saveButton.disabled).toBe(false));
		saveButton.click();
		await closed;
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "metered", application: "my-pipane" }));
		expect(onSaved).toHaveBeenCalledOnce();
	});

	it("loads and removes an existing coturn profile", async () => {
		const profile: TurnRelayProfile = {
			version: 1,
			kind: "coturn-rest",
			urls: ["turn:turn.example:3478?transport=udp"],
			sharedSecret: "rest-secret",
			ttlSeconds: 600,
		};
		const clear = vi.fn(async () => undefined);
		const closed = openTurnRelayDialog({ store: { load: async () => profile, save: vi.fn(), clear } });
		await vi.waitFor(() => expect(document.querySelector("[data-provider='coturn-rest']")?.className).toContain("is-active"));
		const remove = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove relay")!;
		remove.click();
		await closed;
		expect(clear).toHaveBeenCalledOnce();
	});

	it("validates generic provider JSON without executing snippets", async () => {
		const closed = openTurnRelayDialog({ store: { load: async () => undefined, save: vi.fn(), clear: vi.fn() } });
		await vi.waitFor(() => expect(document.querySelector("[data-provider='static']")).not.toBeNull());
		(document.querySelector("[data-provider='static']") as HTMLButtonElement).click();
		const textarea = document.querySelector(".turn-relay-json") as HTMLTextAreaElement;
		input(textarea, "not JavaScript()");
		(document.querySelector("[data-testid='turn-relay-save']") as HTMLButtonElement).click();
		expect(document.querySelector(".turn-relay-status")?.textContent).toContain("not valid JSON");
		(document.querySelector("[aria-label='Close TURN relay settings']") as HTMLButtonElement).click();
		await closed;
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { enterSettingsRoute, isSettingsPath, leaveSettingsRoute } from "./settings-route.js";

beforeEach(() => {
	window.history.replaceState(null, "", "/");
});

describe("settings route", () => {
	it("recognizes only the settings page", () => {
		expect(isSettingsPath("/settings")).toBe(true);
		expect(isSettingsPath("/settings/")).toBe(true);
		expect(isSettingsPath("/settings/host")).toBe(false);
	});

	it("opens settings while retaining the current in-app location", () => {
		window.history.replaceState({ existing: true }, "", "/backend/b_one?view=all#latest");
		enterSettingsRoute();

		expect(window.location.pathname).toBe("/settings");
		expect(window.history.state).toEqual({
			existing: true,
			pipaneSettingsReturnTo: "/backend/b_one?view=all#latest",
		});
	});

	it("returns through browser history when settings was opened in-app", () => {
		window.history.replaceState(null, "", "/backend/b_one");
		enterSettingsRoute();
		const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);

		leaveSettingsRoute();

		expect(back).toHaveBeenCalledOnce();
	});

	it("closes a directly loaded settings page to the workspace root", () => {
		window.history.replaceState(null, "", "/settings");
		leaveSettingsRoute();
		expect(window.location.pathname).toBe("/");
	});
});

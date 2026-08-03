import { afterEach, describe, expect, it, vi } from "vitest";
import { RECONNECT_WARNING_DELAY_MS, ReconnectWarningVisibility } from "./reconnect-warning.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("ReconnectWarningVisibility", () => {
	it("hides interruptions that recover within the grace period", () => {
		vi.useFakeTimers();
		const changed = vi.fn();
		const warning = new ReconnectWarningVisibility(changed);

		warning.update(false);
		vi.advanceTimersByTime(RECONNECT_WARNING_DELAY_MS - 1);
		expect(warning.visible).toBe(false);

		warning.update(true);
		vi.advanceTimersByTime(1);
		expect(warning.visible).toBe(false);
		expect(changed).not.toHaveBeenCalled();
	});

	it("shows sustained outages and hides them immediately after recovery", () => {
		vi.useFakeTimers();
		const changed = vi.fn();
		const warning = new ReconnectWarningVisibility(changed);

		warning.update(false);
		vi.advanceTimersByTime(RECONNECT_WARNING_DELAY_MS);
		expect(warning.visible).toBe(true);
		expect(changed).toHaveBeenCalledTimes(1);

		warning.update(true);
		expect(warning.visible).toBe(false);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("cancels pending visibility work when disposed", () => {
		vi.useFakeTimers();
		const changed = vi.fn();
		const warning = new ReconnectWarningVisibility(changed);

		warning.update(false);
		warning.dispose();
		vi.advanceTimersByTime(RECONNECT_WARNING_DELAY_MS);

		expect(warning.visible).toBe(false);
		expect(changed).not.toHaveBeenCalled();
	});

	it("does not postpone an already scheduled warning on duplicate disconnect events", () => {
		vi.useFakeTimers();
		const warning = new ReconnectWarningVisibility(vi.fn());

		warning.update(false);
		vi.advanceTimersByTime(RECONNECT_WARNING_DELAY_MS - 100);
		warning.update(false);
		vi.advanceTimersByTime(100);

		expect(warning.visible).toBe(true);
	});
});

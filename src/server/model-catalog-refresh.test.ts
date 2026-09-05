// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { ModelCatalogCoordinator } from "./model-catalog-refresh.js";

describe("ModelCatalogCoordinator", () => {
	it("refreshes and invalidates stale workers before reporting success", async () => {
		const calls: string[] = [];
		const coordinator = new ModelCatalogCoordinator({
			refresh: vi.fn(async () => { calls.push("refresh"); }),
			onRefreshed: vi.fn(async () => { calls.push("invalidate"); }),
		});

		await expect(coordinator.prepare()).resolves.toBe(true);
		expect(calls).toEqual(["refresh", "invalidate"]);
	});

	it("deduplicates concurrent refreshes and throttles later requests", async () => {
		let finish!: () => void;
		const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
		const onRefreshed = vi.fn();
		let now = 1_000;
		const coordinator = new ModelCatalogCoordinator({
			refresh,
			onRefreshed,
			minimumRefreshIntervalMs: 500,
			now: () => now,
		});

		const first = coordinator.prepare();
		const concurrent = coordinator.prepare();
		expect(refresh).toHaveBeenCalledOnce();
		finish();
		await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);
		expect(onRefreshed).toHaveBeenCalledOnce();

		now = 1_499;
		await expect(coordinator.prepare()).resolves.toBe(false);
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("keeps existing workers when refresh fails", async () => {
		const error = new Error("catalog unavailable");
		const onRefreshed = vi.fn();
		const onError = vi.fn();
		const coordinator = new ModelCatalogCoordinator({
			refresh: vi.fn(async () => { throw error; }),
			onRefreshed,
			onError,
		});

		await expect(coordinator.prepare()).resolves.toBe(false);
		expect(onRefreshed).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(error);
	});
});

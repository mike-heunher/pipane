import { expect, test as base } from "@playwright/test";
import { startHarness, type E2EHarness } from "./harness.js";

interface RealStackWorkerFixtures {
	harness: E2EHarness;
}

/**
 * Reuse one isolated real-stack harness per Playwright worker. Tests still get
 * fresh browser contexts and create fresh Pi sessions, while avoiding repeated
 * server and Pi RPC startup for every spec file.
 */
export const test = base.extend<Record<string, never>, RealStackWorkerFixtures>({
	harness: [async ({}, use) => {
		const harness = await startHarness();
		try {
			await use(harness);
		} finally {
			await harness.close();
		}
	}, { scope: "worker", timeout: 60_000 }],
});

export { expect };

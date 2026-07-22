/** @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_RENDEZVOUS_URL,
	resolveBackendName,
	resolveRendezvousUrl,
} from "./backend-registration-config.js";

describe("backend registration configuration", () => {
	it("uses pipane.dev unless another rendezvous URL is configured", () => {
		expect(resolveRendezvousUrl(undefined)).toBe(DEFAULT_RENDEZVOUS_URL);
		expect(resolveRendezvousUrl("https://pipane.example")).toBe("https://pipane.example");
		expect(resolveRendezvousUrl("")).toBe("");
	});

	it("uses the non-fully-qualified hostname when no backend name is configured", () => {
		expect(resolveBackendName(undefined, "worker.example.test")).toBe("worker");
		expect(resolveBackendName("", "worker.example.test")).toBe("worker");
		expect(resolveBackendName(undefined, "worker")).toBe("worker");
		expect(resolveBackendName("friendly-name", "worker.example.test")).toBe("friendly-name");
	});
});

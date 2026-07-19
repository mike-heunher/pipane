import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Absolute entrypoint for the bundled common-subscription usage extension. */
export function resolveUsageExtensionPath(): string {
	return require.resolve("@sreetej510/pi-usage/dist/index.js");
}

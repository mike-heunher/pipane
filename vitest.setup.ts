import { afterAll, afterEach, beforeEach } from "vitest";

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalFetch = globalThis.fetch;

interface UnexpectedActivity {
	console: string[];
	network: string[];
	unhandled: string[];
}

let pendingBeforeTest: UnexpectedActivity = { console: [], network: [], unhandled: [] };
let currentTest: UnexpectedActivity | null = null;

const allowedDependencyWarnings = [
	"KaTeX doesn't work in quirks mode",
	"Lit is in dev mode",
	"Please use the `legacy` build in Node.js environments",
];

function formatArgs(args: unknown[]): string {
	return args.map((value) => {
		if (value instanceof Error) return value.stack || value.message;
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}).join(" ");
}

function recordConsole(kind: "error" | "warn", args: unknown[]): void {
	const message = formatArgs(args);
	if (allowedDependencyWarnings.some((allowed) => message.includes(allowed))) return;
	const activity = currentTest ?? pendingBeforeTest;
	activity.console.push(`${kind}: ${message}`);
	(kind === "error" ? originalConsoleError : originalConsoleWarn)(...args);
}

console.error = (...args: unknown[]) => recordConsole("error", args);
console.warn = (...args: unknown[]) => recordConsole("warn", args);

function recordUnhandled(reason: unknown): void {
	const activity = currentTest ?? pendingBeforeTest;
	activity.unhandled.push(formatArgs([reason]));
}

process.prependListener("unhandledRejection", recordUnhandled);

beforeEach(() => {
	currentTest = pendingBeforeTest;
	pendingBeforeTest = { console: [], network: [], unhandled: [] };

	// Happy DOM resolves relative URLs against localhost. Unit tests must inject
	// or explicitly stub HTTP instead of accidentally contacting a developer's
	// machine. Node-environment integration tests retain the real fetch API.
	if (typeof window !== "undefined") {
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			currentTest?.network.push(url);
			return Promise.reject(new Error(`Unexpected unit-test network request: ${url}`));
		}) as typeof fetch;
	}
});

afterEach(async () => {
	// Give promise rejection handlers queued by the test a chance to settle.
	await Promise.resolve();
	if (typeof window !== "undefined") globalThis.fetch = originalFetch;

	const activity = currentTest;
	currentTest = null;
	if (!activity) return;

	const failures: string[] = [];
	if (activity.network.length > 0) {
		failures.push(`Unexpected network requests:\n${activity.network.map((url) => `  - ${url}`).join("\n")}`);
	}
	if (activity.console.length > 0) {
		failures.push(`Unexpected console output:\n${activity.console.map((line) => `  - ${line}`).join("\n")}`);
	}
	if (activity.unhandled.length > 0) {
		failures.push(`Unhandled promise rejections:\n${activity.unhandled.map((line) => `  - ${line}`).join("\n")}`);
	}
	if (failures.length > 0) throw new Error(failures.join("\n\n"));
});

afterAll(() => {
	process.removeListener("unhandledRejection", recordUnhandled);
	console.error = originalConsoleError;
	console.warn = originalConsoleWarn;
	globalThis.fetch = originalFetch;
});

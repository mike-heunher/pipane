type TraceAttrs = Record<string, any>;

function randomId(len = 16): string {
	const bytes = new Uint8Array(len);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const TRACE_STORAGE_KEY = "pipane-load-trace-id";

const traceId = (() => {
	const existing = sessionStorage.getItem(TRACE_STORAGE_KEY);
	if (existing) return existing;
	const created = randomId(16);
	sessionStorage.setItem(TRACE_STORAGE_KEY, created);
	return created;
})();

function postEvent(name: string, durationMs?: number, attrs?: TraceAttrs): void {
	const payload = {
		traceId,
		name,
		durationMs,
		attrs,
	};
	fetch("/api/debug/load-trace/event", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-pi-trace-id": traceId,
		},
		body: JSON.stringify(payload),
	}).catch(() => {});
}

export function getLoadTraceId(): string {
	return traceId;
}

export function traceInstant(name: string, attrs?: TraceAttrs): void {
	postEvent(name, undefined, attrs);
}

export function traceSpanStart(name: string, attrs?: TraceAttrs): () => void {
	const start = performance.now();
	return () => {
		const durationMs = Number((performance.now() - start).toFixed(2));
		postEvent(name, durationMs, attrs);
	};
}

export async function tracedFetch(input: RequestInfo | URL, init: RequestInit = {}, spanName?: string): Promise<Response> {
	const endSpan = traceSpanStart(spanName || `fetch ${typeof input === "string" ? input : input.toString()}`);
	const headers = new Headers(init.headers || undefined);
	headers.set("x-pi-trace-id", traceId);
	try {
		return await fetch(input, {
			...init,
			headers,
		});
	} finally {
		endSpan();
	}
}

export function sendNavigationTiming() {
	const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
	if (!nav) return;
	traceInstant("navigation_timing", {
		domInteractive: Number(nav.domInteractive.toFixed(2)),
		domContentLoadedEventEnd: Number(nav.domContentLoadedEventEnd.toFixed(2)),
		loadEventEnd: Number(nav.loadEventEnd.toFixed(2)),
		responseEnd: Number(nav.responseEnd.toFixed(2)),
	});
}

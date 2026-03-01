export interface LoadTraceEvent {
	ts: string;
	source: "frontend" | "backend";
	kind: "instant" | "span";
	name: string;
	durationMs?: number;
	attrs?: Record<string, any>;
}

export interface LoadTrace {
	traceId: string;
	startedAt: string;
	updatedAt: string;
	events: LoadTraceEvent[];
}

const MAX_TRACES = 50;
const MAX_EVENTS_PER_TRACE = 1000;

export class LoadTraceStore {
	private traces = new Map<string, LoadTrace>();

	record(traceId: string, event: LoadTraceEvent): void {
		if (!traceId) return;
		const trace = this.ensure(traceId);
		trace.events.push(event);
		if (trace.events.length > MAX_EVENTS_PER_TRACE) {
			trace.events.splice(0, trace.events.length - MAX_EVENTS_PER_TRACE);
		}
		trace.updatedAt = event.ts;
	}

	get(traceId: string): LoadTrace | undefined {
		return this.traces.get(traceId);
	}

	getLatest(): LoadTrace[] {
		return Array.from(this.traces.values())
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, 10);
	}

	private ensure(traceId: string): LoadTrace {
		let trace = this.traces.get(traceId);
		if (!trace) {
			const now = new Date().toISOString();
			trace = {
				traceId,
				startedAt: now,
				updatedAt: now,
				events: [],
			};
			this.traces.set(traceId, trace);
			this.compact();
		}
		return trace;
	}

	private compact(): void {
		if (this.traces.size <= MAX_TRACES) return;
		const oldest = Array.from(this.traces.values())
			.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
			.slice(0, this.traces.size - MAX_TRACES);
		for (const trace of oldest) {
			this.traces.delete(trace.traceId);
		}
	}
}

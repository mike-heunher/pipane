import type {
	FrameTrafficDiagnostics,
	FrameTrafficDirectionDiagnostics,
} from "./frame-transport.js";

interface MutableDirection {
	physicalMessages: number;
	physicalBytes: number;
	logicalFrames: number;
	logicalBytes: number;
	logicalBytesByType: Map<string, number>;
	logicalFramesByType: Map<string, number>;
}

/** Exact Pipane payload counters, independent of browser-specific WebRTC stats. */
export class FrameTrafficMeter {
	private readonly startedAt = new Date().toISOString();
	private reconnects = 0;
	private readonly sent = emptyDirection();
	private readonly received = emptyDirection();

	recordReconnect(): void {
		this.reconnects++;
	}

	recordPhysical(direction: "sent" | "received", value: unknown): void {
		const target = this[direction];
		target.physicalMessages++;
		target.physicalBytes += physicalByteLength(value);
	}

	recordLogical(direction: "sent" | "received", frame: string): void {
		const target = this[direction];
		const bytes = new TextEncoder().encode(frame).byteLength;
		const type = classifyFrame(frame);
		target.logicalFrames++;
		target.logicalBytes += bytes;
		target.logicalBytesByType.set(type, (target.logicalBytesByType.get(type) ?? 0) + bytes);
		target.logicalFramesByType.set(type, (target.logicalFramesByType.get(type) ?? 0) + 1);
	}

	snapshot(): FrameTrafficDiagnostics {
		return {
			startedAt: this.startedAt,
			reconnects: this.reconnects,
			sent: snapshotDirection(this.sent),
			received: snapshotDirection(this.received),
		};
	}
}

function emptyDirection(): MutableDirection {
	return {
		physicalMessages: 0,
		physicalBytes: 0,
		logicalFrames: 0,
		logicalBytes: 0,
		logicalBytesByType: new Map(),
		logicalFramesByType: new Map(),
	};
}

function snapshotDirection(value: MutableDirection): FrameTrafficDirectionDiagnostics {
	return {
		physicalMessages: value.physicalMessages,
		physicalBytes: value.physicalBytes,
		logicalFrames: value.logicalFrames,
		logicalBytes: value.logicalBytes,
		logicalBytesByType: Object.fromEntries(value.logicalBytesByType),
		logicalFramesByType: Object.fromEntries(value.logicalFramesByType),
	};
}

function physicalByteLength(value: unknown): number {
	if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
	return new TextEncoder().encode(String(value)).byteLength;
}

/** Classify only the small envelope prefix; never parse a multi-megabyte state twice. */
function classifyFrame(frame: string): string {
	const prefix = frame.slice(0, 4_096);
	const kind = field(prefix, "kind");
	if (kind) {
		const method = field(prefix, "method");
		const eventType = field(prefix, "type");
		return `semantic.${kind}.${method ?? eventType ?? "unknown"}`;
	}

	const type = field(prefix, "type") ?? "unknown";
	if (type === "session_sync") return `${type}.${field(prefix, "op") ?? "unknown"}`;
	if (type === "response") return `${type}.${field(prefix, "command") ?? "unknown"}`;
	return type;
}

function field(prefix: string, name: string): string | undefined {
	const match = new RegExp(`"${name}":"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, "u").exec(prefix);
	if (!match?.[1]) return undefined;
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return undefined;
	}
}

export interface ToolCallTiming {
	startedAt: number;
	completedAt?: number;
}

export type ToolCallTimings = Record<string, ToolCallTiming>;

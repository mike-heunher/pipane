const promptFailureSessionPaths = new WeakMap<object, string>();

/** Associate a rejected prompt request with the persisted session it created or targeted. */
export function associatePromptFailureSession(error: unknown, sessionPath: string | undefined): unknown {
	if (!sessionPath) return error;
	const failure = error !== null && (typeof error === "object" || typeof error === "function")
		? error as object
		: new Error(String(error));
	promptFailureSessionPaths.set(failure, sessionPath);
	return failure;
}

/** Recover the authoritative session target without changing the displayed error. */
export function getPromptFailureSession(error: unknown): string | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
	return promptFailureSessionPaths.get(error as object);
}

/** A coding turn can legitimately remain active for far longer than 90 seconds. */
export const PROMPT_CLIENT_TIMEOUT_MS = 30 * 60_000;

/** Compaction performs an LLM summarization and can legitimately take minutes. */
export const COMPACT_RPC_TIMEOUT_MS = 10 * 60_000;

/** Allow for process acquisition/switching before the server starts compaction. */
export const COMPACT_CLIENT_TIMEOUT_MS = COMPACT_RPC_TIMEOUT_MS + 90_000;

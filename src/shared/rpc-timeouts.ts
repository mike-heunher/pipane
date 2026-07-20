/** Compaction performs an LLM summarization and can legitimately take minutes. */
export const COMPACT_RPC_TIMEOUT_MS = 10 * 60_000;

/** Allow for process acquisition/switching before the server starts compaction. */
export const COMPACT_CLIENT_TIMEOUT_MS = COMPACT_RPC_TIMEOUT_MS + 90_000;

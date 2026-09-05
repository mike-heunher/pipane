const DEFAULT_MINIMUM_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface ModelCatalogCoordinatorOptions {
	refresh: () => Promise<void>;
	onRefreshed: () => void | Promise<void>;
	onError?: (error: unknown) => void;
	minimumRefreshIntervalMs?: number;
	now?: () => number;
}

/**
 * Deduplicate and throttle forced remote model-catalog refreshes.
 *
 * Pi RPC workers retain an in-memory model snapshot, so a successful refresh
 * must be followed by worker invalidation before querying the catalog again.
 */
export class ModelCatalogCoordinator {
	private readonly refresh: () => Promise<void>;
	private readonly onRefreshed: () => void | Promise<void>;
	private readonly onError: (error: unknown) => void;
	private readonly minimumRefreshIntervalMs: number;
	private readonly now: () => number;
	private lastAttemptAt = Number.NEGATIVE_INFINITY;
	private active: Promise<boolean> | undefined;

	constructor(options: ModelCatalogCoordinatorOptions) {
		this.refresh = options.refresh;
		this.onRefreshed = options.onRefreshed;
		this.onError = options.onError ?? (() => {});
		this.minimumRefreshIntervalMs = options.minimumRefreshIntervalMs
			?? DEFAULT_MINIMUM_REFRESH_INTERVAL_MS;
		this.now = options.now ?? Date.now;
	}

	/** Refresh when due. Failures preserve the currently cached catalog. */
	prepare(): Promise<boolean> {
		if (this.active) return this.active;
		const now = this.now();
		if (now - this.lastAttemptAt < this.minimumRefreshIntervalMs) {
			return Promise.resolve(false);
		}
		this.lastAttemptAt = now;

		const operation = this.refresh()
			.then(async () => {
				await this.onRefreshed();
				return true;
			})
			.catch((error) => {
				this.onError(error);
				return false;
			})
			.finally(() => {
				if (this.active === operation) this.active = undefined;
			});
		this.active = operation;
		return operation;
	}
}

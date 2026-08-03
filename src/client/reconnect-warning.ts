export const RECONNECT_WARNING_DELAY_MS = 1_250;

/**
 * Avoid flashing connection chrome for carrier interruptions that recover before
 * they affect the user. Longer outages still become visible after a short grace
 * period and disappear immediately when the connection returns.
 */
export class ReconnectWarningVisibility {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private connected = true;
	private _visible = false;

	constructor(
		private readonly onChange: () => void,
		private readonly delayMs = RECONNECT_WARNING_DELAY_MS,
		private readonly schedule: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis),
		private readonly cancel: typeof globalThis.clearTimeout = globalThis.clearTimeout.bind(globalThis),
	) {}

	get visible(): boolean {
		return this._visible;
	}

	update(connected: boolean): void {
		this.connected = connected;
		if (connected) {
			if (this.timer) this.cancel(this.timer);
			this.timer = undefined;
			if (!this._visible) return;
			this._visible = false;
			this.onChange();
			return;
		}

		if (this._visible || this.timer) return;
		this.timer = this.schedule(() => {
			this.timer = undefined;
			if (this.connected || this._visible) return;
			this._visible = true;
			this.onChange();
		}, this.delayMs);
	}

	dispose(): void {
		if (this.timer) this.cancel(this.timer);
		this.timer = undefined;
	}
}

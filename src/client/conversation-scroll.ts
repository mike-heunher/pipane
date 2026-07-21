const BOTTOM_THRESHOLD_PX = 10;

export interface ConversationScrollTarget {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

/**
 * Owns the conversation's follow-the-tail behavior.
 *
 * User intent always wins: pausing cancels queued work, and every queued frame
 * rechecks the pin before changing scrollTop. Programmatic scroll events are
 * ignored only while their exact write is settling; wheel/touch handlers call
 * pauseForUser() directly and therefore are never hidden by that window.
 */
export class ConversationScrollController {
	private following = true;
	private forceNextScroll = false;
	private pendingFrame: number | undefined;
	private settlingFrame: number | undefined;
	private programmaticScrollSettling = false;

	constructor(
		private readonly requestFrame: RequestFrame = (callback) => requestAnimationFrame(callback),
		private readonly cancelFrame: CancelFrame = (handle) => cancelAnimationFrame(handle),
	) {}

	/** Explicitly follow the next rendered tail, such as after send/session switch. */
	pinToBottom(): void {
		this.following = true;
		this.forceNextScroll = true;
	}

	/** Stop following immediately and invalidate work queued by an older render. */
	pauseForUser(): void {
		this.following = false;
		this.forceNextScroll = false;
		if (this.pendingFrame !== undefined) {
			this.cancelFrame(this.pendingFrame);
			this.pendingFrame = undefined;
		}
	}

	handleScroll(target: ConversationScrollTarget): void {
		if (this.programmaticScrollSettling || this.forceNextScroll) return;
		this.following = this.distanceFromBottom(target) < BOTTOM_THRESHOLD_PX;
	}

	scrollToBottomIfNeeded(getTarget: () => ConversationScrollTarget | null): void {
		if ((!this.following && !this.forceNextScroll) || this.pendingFrame !== undefined) return;

		this.pendingFrame = this.requestFrame(() => {
			this.pendingFrame = undefined;
			if (!this.following && !this.forceNextScroll) return;

			const target = getTarget();
			if (!target) return;

			this.programmaticScrollSettling = true;
			this.forceNextScroll = false;
			target.scrollTop = target.scrollHeight;

			if (this.settlingFrame !== undefined) this.cancelFrame(this.settlingFrame);
			this.settlingFrame = this.requestFrame(() => {
				this.settlingFrame = undefined;
				this.programmaticScrollSettling = false;
			});
		});
	}

	dispose(): void {
		if (this.pendingFrame !== undefined) this.cancelFrame(this.pendingFrame);
		if (this.settlingFrame !== undefined) this.cancelFrame(this.settlingFrame);
		this.pendingFrame = undefined;
		this.settlingFrame = undefined;
		this.programmaticScrollSettling = false;
	}

	private distanceFromBottom(target: ConversationScrollTarget): number {
		return target.scrollHeight - target.scrollTop - target.clientHeight;
	}
}

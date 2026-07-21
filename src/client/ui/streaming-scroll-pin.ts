import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import {
	directive,
	PartType,
	type ElementPart,
	type PartInfo,
} from "lit/directive.js";

const BOTTOM_THRESHOLD_PX = 8;

/** A per-element scroll pin for an individual streaming tool output body. */
class StreamingScrollPinDirective extends AsyncDirective {
	private element: HTMLElement | undefined;
	private observer: MutationObserver | undefined;
	private streaming = false;
	private initialized = false;
	private userScrolledUp = false;
	private pendingFrame: number | undefined;
	private touchY: number | undefined;

	constructor(partInfo: PartInfo) {
		super(partInfo);
		if (partInfo.type !== PartType.ELEMENT) {
			throw new Error("streamingScrollPin must be used in an element binding");
		}
	}

	render(_streaming: boolean) {
		return nothing;
	}

	override update(part: ElementPart, [streaming]: Parameters<this["render"]>) {
		const element = part.element;
		if (!(element instanceof HTMLElement)) return nothing;

		if (element !== this.element) {
			this.detach();
			this.element = element;
			this.initialized = false;
			this.userScrolledUp = false;
		}

		const wasStreaming = this.streaming;
		this.streaming = streaming;

		if (!this.initialized) {
			this.initialized = true;
			this.userScrolledUp = false;
			this.scheduleScrollToEnd();
		} else if (!wasStreaming && streaming) {
			this.userScrolledUp = false;
			this.scheduleScrollToEnd();
		} else if (wasStreaming && !streaming && !this.userScrolledUp) {
			this.scheduleScrollToEnd();
		}

		if (this.isConnected) this.attach();
		return nothing;
	}

	protected override disconnected(): void {
		this.detach(false);
	}

	protected override reconnected(): void {
		this.attach();
	}

	private readonly handleScroll = (): void => {
		if (!this.element || (!this.streaming && this.pendingFrame === undefined)) return;
		this.userScrolledUp = !this.isAtBottom();
		if (this.userScrolledUp) this.cancelPendingFrame();
	};

	private readonly handleWheel = (event: WheelEvent): void => {
		if (event.deltaY < 0) this.detachForUser();
	};

	private readonly handleTouchStart = (event: TouchEvent): void => {
		this.touchY = event.touches[0]?.clientY;
	};

	private readonly handleTouchMove = (event: TouchEvent): void => {
		const nextY = event.touches[0]?.clientY;
		if (nextY === undefined) return;
		if (this.touchY !== undefined && nextY > this.touchY) this.detachForUser();
		this.touchY = nextY;
	};

	private readonly handleTouchEnd = (): void => {
		this.touchY = undefined;
	};

	private readonly handleMutation = (): void => {
		if (this.streaming && !this.userScrolledUp) this.scrollToEnd();
	};

	private attach(): void {
		if (!this.element || this.observer) return;
		this.element.addEventListener("scroll", this.handleScroll, { passive: true });
		this.element.addEventListener("wheel", this.handleWheel, { passive: true });
		this.element.addEventListener("touchstart", this.handleTouchStart, { passive: true });
		this.element.addEventListener("touchmove", this.handleTouchMove, { passive: true });
		this.element.addEventListener("touchend", this.handleTouchEnd, { passive: true });
		this.element.addEventListener("touchcancel", this.handleTouchEnd, { passive: true });
		this.observer = new MutationObserver(this.handleMutation);
		this.observer.observe(this.element, { childList: true, subtree: true, characterData: true });
	}

	private detach(clearElement = true): void {
		this.cancelPendingFrame();
		this.observer?.disconnect();
		this.observer = undefined;
		this.element?.removeEventListener("scroll", this.handleScroll);
		this.element?.removeEventListener("wheel", this.handleWheel);
		this.element?.removeEventListener("touchstart", this.handleTouchStart);
		this.element?.removeEventListener("touchmove", this.handleTouchMove);
		this.element?.removeEventListener("touchend", this.handleTouchEnd);
		this.element?.removeEventListener("touchcancel", this.handleTouchEnd);
		this.touchY = undefined;
		if (clearElement) this.element = undefined;
	}

	private detachForUser(): void {
		this.userScrolledUp = true;
		this.cancelPendingFrame();
	}

	private scheduleScrollToEnd(): void {
		if (this.pendingFrame !== undefined) return;
		this.pendingFrame = requestAnimationFrame(() => {
			this.pendingFrame = undefined;
			if (!this.userScrolledUp) this.scrollToEnd();
		});
	}

	private cancelPendingFrame(): void {
		if (this.pendingFrame === undefined) return;
		cancelAnimationFrame(this.pendingFrame);
		this.pendingFrame = undefined;
	}

	private isAtBottom(): boolean {
		if (!this.element) return true;
		return this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight < BOTTOM_THRESHOLD_PX;
	}

	private scrollToEnd(): void {
		if (this.element) this.element.scrollTop = this.element.scrollHeight;
	}
}

export const streamingScrollPin = directive(StreamingScrollPinDirective);

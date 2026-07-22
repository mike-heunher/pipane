export interface ConversationDraft<TAttachment> {
	readonly value: string;
	readonly attachments: readonly TAttachment[];
}

const EMPTY_DRAFT: ConversationDraft<never> = {
	value: "",
	attachments: [],
};

/** Stable identity for the currently selected persisted or virtual conversation. */
export function conversationDraftKey(sessionFile: string | undefined, sessionId: string, backendId?: string): string {
	const conversation = sessionFile ? `session:${sessionFile}` : `virtual:${sessionId}`;
	return backendId ? `backend:${backendId}:${conversation}` : conversation;
}

/** In-memory composer drafts, isolated by conversation identity. */
export class ConversationDraftStore<TAttachment> {
	private readonly drafts = new Map<string, ConversationDraft<TAttachment>>();

	get(key: string): ConversationDraft<TAttachment> {
		return this.drafts.get(key) ?? EMPTY_DRAFT;
	}

	setValue(key: string, value: string): void {
		const current = this.get(key);
		this.set(key, value, current.attachments);
	}

	setAttachments(key: string, attachments: readonly TAttachment[]): void {
		const current = this.get(key);
		this.set(key, current.value, attachments);
	}

	clear(key: string): void {
		this.drafts.delete(key);
	}

	private set(key: string, value: string, attachments: readonly TAttachment[]): void {
		if (!value && attachments.length === 0) {
			this.clear(key);
			return;
		}
		this.drafts.set(key, { value, attachments: [...attachments] });
	}
}

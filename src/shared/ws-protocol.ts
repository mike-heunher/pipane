export type ExtensionStatuses = Record<string, string>;

/** Complete status snapshot for one session. */
export interface ExtensionStatusMessage {
	type: "extension_status";
	sessionPath: string;
	statuses: ExtensionStatuses;
}

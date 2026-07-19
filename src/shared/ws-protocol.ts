export type ExtensionStatuses = Record<string, string>;
export type ProviderUsageStatuses = Record<string, string>;

/** Complete status snapshot for one session. */
export interface ExtensionStatusMessage {
	type: "extension_status";
	sessionPath: string;
	statuses: ExtensionStatuses;
}

/** Latest account-wide subscription usage, keyed by provider family. */
export interface ProviderUsageMessage {
	type: "provider_usage";
	statuses: ProviderUsageStatuses;
}

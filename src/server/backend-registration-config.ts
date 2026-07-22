export const DEFAULT_RENDEZVOUS_URL = "https://pipane.dev";

export function resolveRendezvousUrl(configuredUrl: string | undefined): string {
	return configuredUrl ?? DEFAULT_RENDEZVOUS_URL;
}

export function resolveBackendName(configuredName: string | undefined, systemHostname: string): string {
	return configuredName || systemHostname.split(".", 1)[0] || systemHostname;
}

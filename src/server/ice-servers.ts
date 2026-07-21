import type { IceServer } from "node-datachannel";
import type { IceServerConfiguration } from "../shared/trust-protocol.js";

/** Converts browser ICE server records into node-datachannel's explicit relay shape. */
export function toNodeIceServers(servers: IceServerConfiguration[]): Array<string | IceServer> {
	const result: Array<string | IceServer> = [];
	for (const server of servers) {
		for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) {
			if (url.startsWith("stun:")) {
				result.push(url);
				continue;
			}
			const match = /^(turns?):(?:\/\/)?(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/iu.exec(url);
			if (!match) throw new Error(`Unsupported ICE server URL: ${url}`);
			const secure = match[1].toLowerCase() === "turns";
			result.push({
				hostname: match[2].replace(/^\[|\]$/gu, ""),
				port: match[3] ? Number.parseInt(match[3], 10) : secure ? 5349 : 3478,
				username: server.username,
				password: server.credential,
				relayType: secure ? "TurnTls" : match[4]?.toLowerCase() === "tcp" ? "TurnTcp" : "TurnUdp",
			});
		}
	}
	return result;
}

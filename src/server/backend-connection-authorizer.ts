import type { BackendAuthorizationContext, BackendAuthorizationResult } from "./backend-webrtc.js";
import { BackendTrustStore } from "./backend-trust-store.js";
import type { PairingConfirmation } from "./rendezvous-client.js";

export interface PairingConfirmationClient {
	confirmPairing(connectionId: string): Promise<PairingConfirmation>;
}

export class BackendConnectionAuthorizer {
	constructor(
		private readonly trustStore: BackendTrustStore,
		private readonly signaling: PairingConfirmationClient,
	) {}

	async authorize(context: BackendAuthorizationContext): Promise<BackendAuthorizationResult> {
		const { claims } = context;
		this.trustStore.authorizeTicket(claims);
		let accountId: string;
		if (claims.kind === "pairing") {
			if (!claims.pairId || !context.pairingSecret) throw new Error("Pairing secret is required");
			this.trustStore.consumePairing(claims.pairId, context.pairingSecret);
			const confirmation = await this.signaling.confirmPairing(claims.connectionId);
			if (confirmation.pairId !== claims.pairId || confirmation.deviceId !== claims.deviceId) {
				throw new Error("Rendezvous pairing confirmation does not match the connection ticket");
			}
			this.trustStore.completePairing(confirmation.accountId);
			accountId = confirmation.accountId;
		} else {
			accountId = claims.accountId!;
		}
		this.trustStore.markTicketUsed(claims);
		return { accountId, deviceId: claims.deviceId };
	}
}

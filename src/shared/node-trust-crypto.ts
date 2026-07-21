import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import {
	connectionTicketSignaturePayload,
	parseConnectionTicketClaims,
	type ConnectionTicketClaims,
} from "./trust-protocol.js";

const DEVICE_ID_PREFIX = "d_";

export function deriveDeviceId(publicKey: string): string {
	const bytes = decodeP256PublicKey(publicKey);
	return `${DEVICE_ID_PREFIX}${createHash("sha256").update(bytes).digest("base64url")}`;
}

export function verifyDeviceSignature(publicKey: string, payload: string, signature: string): boolean {
	try {
		const key = createPublicKey({ key: decodeP256PublicKey(publicKey), format: "der", type: "spki" });
		return verify("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
	} catch {
		return false;
	}
}

export function verifyConnectionTicket(ticket: string, publicKey: string, now = Date.now()): ConnectionTicketClaims {
	const parts = ticket.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Malformed connection ticket");
	const [encodedClaims, encodedSignature] = parts;
	let claims: unknown;
	try {
		const bytes = Buffer.from(encodedClaims, "base64url");
		if (bytes.toString("base64url") !== encodedClaims) throw new Error("non-canonical payload");
		claims = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("Malformed connection ticket claims");
	}
	const parsed = parseConnectionTicketClaims(claims);
	if (!parsed) throw new Error("Invalid connection ticket claims");
	if (!verifyDeviceSignature(publicKey, connectionTicketSignaturePayload(encodedClaims), encodedSignature)) {
		throw new Error("Invalid connection ticket signature");
	}
	if (parsed.expiresAt <= now) throw new Error("Connection ticket expired");
	if (parsed.issuedAt > now + 30_000) throw new Error("Connection ticket was issued in the future");
	return parsed;
}

export function decodeP256PublicKey(publicKey: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) throw new Error("Invalid public key encoding");
	const bytes = Buffer.from(publicKey, "base64url");
	if (bytes.length === 0 || bytes.toString("base64url") !== publicKey) throw new Error("Invalid public key encoding");
	const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
	assertP256Key(key);
	const canonical = Buffer.from(key.export({ type: "spki", format: "der" }));
	if (!canonical.equals(bytes)) throw new Error("Public key is not canonical");
	return bytes;
}

export function assertP256Key(key: KeyObject): void {
	if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
		throw new Error("Identity must use P-256");
	}
}

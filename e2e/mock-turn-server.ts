import { createHash, createHmac, randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;
const REFRESH_REQUEST = 0x0004;
const REFRESH_SUCCESS = 0x0104;
const REFRESH_ERROR = 0x0114;
const CREATE_PERMISSION_REQUEST = 0x0008;
const CREATE_PERMISSION_SUCCESS = 0x0108;
const CREATE_PERMISSION_ERROR = 0x0118;
const CHANNEL_BIND_REQUEST = 0x0009;
const CHANNEL_BIND_SUCCESS = 0x0109;
const CHANNEL_BIND_ERROR = 0x0119;
const SEND_INDICATION = 0x0016;
const DATA_INDICATION = 0x0017;

const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_CHANNEL_NUMBER = 0x000c;
const ATTR_LIFETIME = 0x000d;
const ATTR_XOR_PEER_ADDRESS = 0x0012;
const ATTR_DATA = 0x0013;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

interface StunAttribute {
	type: number;
	value: Buffer;
}

interface StunMessage {
	type: number;
	transactionId: Buffer;
	attributes: StunAttribute[];
}

interface Allocation {
	client: { address: string; port: number };
	relay: Socket;
	channels: Map<number, { address: string; port: number }>;
	peerChannels: Map<string, number>;
}

export interface MockTurnServerOptions {
	username?: string;
	password?: string;
	realm?: string;
}

/** Minimal deterministic UDP TURN server for forcing both E2E peers through relay candidates. */
export class MockTurnServer {
	readonly username: string;
	readonly password: string;
	readonly realm: string;
	private readonly nonce = randomBytes(16).toString("hex");
	private readonly control = createSocket("udp4");
	private readonly allocations = new Map<string, Allocation>();
	private port = 0;

	constructor(options: MockTurnServerOptions = {}) {
		this.username = options.username ?? "pipane-test";
		this.password = options.password ?? "pipane-test-password";
		this.realm = options.realm ?? "pipane.test";
		this.control.on("message", (packet, remote) => {
			void this.handleControl(packet, remote).catch(() => {
				// E2E assertions report connectivity failure; malformed probe packets are ignored.
			});
		});
	}

	get url(): string {
		if (!this.port) throw new Error("TURN server is not listening");
		return `turn:127.0.0.1:${this.port}?transport=udp`;
	}

	async listen(): Promise<number> {
		if (this.port) return this.port;
		await bind(this.control, 0, "127.0.0.1");
		const address = this.control.address();
		if (typeof address === "string") throw new Error("TURN server did not bind UDP");
		this.port = address.port;
		return this.port;
	}

	async close(): Promise<void> {
		for (const allocation of this.allocations.values()) allocation.relay.close();
		this.allocations.clear();
		if (this.port) await closeSocket(this.control);
		this.port = 0;
	}

	private async handleControl(packet: Buffer, remote: RemoteInfo): Promise<void> {
		if (packet.length >= 4 && (packet.readUInt16BE(0) & 0xc000) === 0x4000) {
			this.handleChannelData(packet, remote);
			return;
		}
		const message = parseStun(packet);
		if (!message) return;
		if (message.type === BINDING_REQUEST) {
			this.sendStun(remote, buildStun(BINDING_SUCCESS, message.transactionId, [xorAddress(ATTR_XOR_MAPPED_ADDRESS, remote.address, remote.port)]));
			return;
		}
		if (message.type === SEND_INDICATION) {
			this.handleSendIndication(message, remote);
			return;
		}

		const responseTypes = responseType(message.type);
		if (!responseTypes) return;
		const username = attributeText(message, ATTR_USERNAME);
		if (!username || !getAttribute(message, ATTR_MESSAGE_INTEGRITY)) {
			this.sendStun(remote, buildStun(responseTypes.error, message.transactionId, [
				errorAttribute(401, "Unauthorized"),
				textAttribute(ATTR_REALM, this.realm),
				textAttribute(ATTR_NONCE, this.nonce),
			]));
			return;
		}

		const key = createHash("md5").update(`${username}:${this.realm}:${this.password}`).digest();
		if (message.type === ALLOCATE_REQUEST) {
			const requestedTransport = getAttribute(message, ATTR_REQUESTED_TRANSPORT)?.value[0];
			if (requestedTransport !== 17) {
				this.sendStun(remote, buildAuthenticatedStun(responseTypes.error, message.transactionId, [errorAttribute(442, "Unsupported Transport")], key));
				return;
			}
			const allocation = await this.allocationFor(remote);
			const relayAddress = allocation.relay.address();
			if (typeof relayAddress === "string") throw new Error("TURN relay address is unavailable");
			this.sendStun(remote, buildAuthenticatedStun(ALLOCATE_SUCCESS, message.transactionId, [
				xorAddress(ATTR_XOR_RELAYED_ADDRESS, relayAddress.address, relayAddress.port),
				xorAddress(ATTR_XOR_MAPPED_ADDRESS, remote.address, remote.port),
				uint32Attribute(ATTR_LIFETIME, 600),
			], key));
			return;
		}

		const allocation = this.allocations.get(clientKey(remote));
		if (!allocation) {
			this.sendStun(remote, buildAuthenticatedStun(responseTypes.error, message.transactionId, [errorAttribute(437, "Allocation Mismatch")], key));
			return;
		}
		if (message.type === CREATE_PERMISSION_REQUEST) {
			this.sendStun(remote, buildAuthenticatedStun(CREATE_PERMISSION_SUCCESS, message.transactionId, [], key));
			return;
		}
		if (message.type === CHANNEL_BIND_REQUEST) {
			const channelAttribute = getAttribute(message, ATTR_CHANNEL_NUMBER);
			const peerAttribute = getAttribute(message, ATTR_XOR_PEER_ADDRESS);
			const peer = peerAttribute ? decodeXorAddress(peerAttribute.value) : undefined;
			if (!channelAttribute || channelAttribute.value.length < 2 || !peer) {
				this.sendStun(remote, buildAuthenticatedStun(CHANNEL_BIND_ERROR, message.transactionId, [errorAttribute(400, "Bad Request")], key));
				return;
			}
			const channel = channelAttribute.value.readUInt16BE(0);
			allocation.channels.set(channel, peer);
			allocation.peerChannels.set(peerKey(peer), channel);
			this.sendStun(remote, buildAuthenticatedStun(CHANNEL_BIND_SUCCESS, message.transactionId, [], key));
			return;
		}
		if (message.type === REFRESH_REQUEST) {
			const requestedLifetime = getAttribute(message, ATTR_LIFETIME)?.value.readUInt32BE(0) ?? 600;
			this.sendStun(remote, buildAuthenticatedStun(REFRESH_SUCCESS, message.transactionId, [
				uint32Attribute(ATTR_LIFETIME, requestedLifetime === 0 ? 0 : 600),
			], key));
			if (requestedLifetime === 0) this.removeAllocation(clientKey(remote));
		}
	}

	private async allocationFor(remote: RemoteInfo): Promise<Allocation> {
		const key = clientKey(remote);
		const existing = this.allocations.get(key);
		if (existing) return existing;
		const relay = createSocket("udp4");
		const allocation: Allocation = {
			client: { address: remote.address, port: remote.port },
			relay,
			channels: new Map(),
			peerChannels: new Map(),
		};
		relay.on("message", (data, peer) => this.relayToClient(allocation, data, peer));
		await bind(relay, 0, "127.0.0.1");
		this.allocations.set(key, allocation);
		return allocation;
	}

	private handleChannelData(packet: Buffer, remote: RemoteInfo): void {
		const allocation = this.allocations.get(clientKey(remote));
		if (!allocation) return;
		const channel = packet.readUInt16BE(0);
		const length = packet.readUInt16BE(2);
		const peer = allocation.channels.get(channel);
		if (!peer || packet.length < 4 + length) return;
		allocation.relay.send(packet.subarray(4, 4 + length), peer.port, peer.address);
	}

	private handleSendIndication(message: StunMessage, remote: RemoteInfo): void {
		const allocation = this.allocations.get(clientKey(remote));
		const peerAttribute = getAttribute(message, ATTR_XOR_PEER_ADDRESS);
		const data = getAttribute(message, ATTR_DATA)?.value;
		const peer = peerAttribute ? decodeXorAddress(peerAttribute.value) : undefined;
		if (!allocation || !peer || !data) return;
		allocation.relay.send(data, peer.port, peer.address);
	}

	private relayToClient(allocation: Allocation, data: Buffer, remote: RemoteInfo): void {
		const channel = allocation.peerChannels.get(peerKey(remote));
		if (channel !== undefined) {
			const header = Buffer.alloc(4);
			header.writeUInt16BE(channel, 0);
			header.writeUInt16BE(data.length, 2);
			this.control.send(Buffer.concat([header, data]), allocation.client.port, allocation.client.address);
			return;
		}
		const indication = buildStun(DATA_INDICATION, randomBytes(12), [
			xorAddress(ATTR_XOR_PEER_ADDRESS, remote.address, remote.port),
			attribute(ATTR_DATA, data),
		]);
		this.control.send(indication, allocation.client.port, allocation.client.address);
	}

	private sendStun(remote: RemoteInfo, packet: Buffer): void {
		this.control.send(packet, remote.port, remote.address);
	}

	private removeAllocation(key: string): void {
		const allocation = this.allocations.get(key);
		if (!allocation) return;
		this.allocations.delete(key);
		allocation.relay.close();
	}
}

function parseStun(packet: Buffer): StunMessage | undefined {
	if (packet.length < 20 || (packet.readUInt16BE(0) & 0xc000) !== 0 || packet.readUInt32BE(4) !== MAGIC_COOKIE) return undefined;
	const length = packet.readUInt16BE(2);
	if (packet.length < 20 + length) return undefined;
	const attributes: StunAttribute[] = [];
	let offset = 20;
	while (offset + 4 <= 20 + length) {
		const type = packet.readUInt16BE(offset);
		const attributeLength = packet.readUInt16BE(offset + 2);
		if (offset + 4 + attributeLength > packet.length) return undefined;
		attributes.push({ type, value: packet.subarray(offset + 4, offset + 4 + attributeLength) });
		offset += 4 + align4(attributeLength);
	}
	return { type: packet.readUInt16BE(0), transactionId: packet.subarray(8, 20), attributes };
}

function buildStun(type: number, transactionId: Buffer, attributes: StunAttribute[]): Buffer {
	const body = Buffer.concat(attributes.map(encodeAttribute));
	return Buffer.concat([stunHeader(type, body.length, transactionId), body]);
}

function buildAuthenticatedStun(type: number, transactionId: Buffer, attributes: StunAttribute[], key: Buffer): Buffer {
	const body = Buffer.concat(attributes.map(encodeAttribute));
	const header = stunHeader(type, body.length + 24, transactionId);
	const integrity = createHmac("sha1", key).update(Buffer.concat([header, body])).digest();
	return Buffer.concat([header, body, encodeAttribute(attribute(ATTR_MESSAGE_INTEGRITY, integrity))]);
}

function stunHeader(type: number, length: number, transactionId: Buffer): Buffer {
	const header = Buffer.alloc(20);
	header.writeUInt16BE(type, 0);
	header.writeUInt16BE(length, 2);
	header.writeUInt32BE(MAGIC_COOKIE, 4);
	transactionId.copy(header, 8, 0, 12);
	return header;
}

function encodeAttribute(value: StunAttribute): Buffer {
	const result = Buffer.alloc(4 + align4(value.value.length));
	result.writeUInt16BE(value.type, 0);
	result.writeUInt16BE(value.value.length, 2);
	value.value.copy(result, 4);
	return result;
}

function attribute(type: number, value: Buffer): StunAttribute {
	return { type, value };
}

function textAttribute(type: number, value: string): StunAttribute {
	return attribute(type, Buffer.from(value));
}

function uint32Attribute(type: number, value: number): StunAttribute {
	const data = Buffer.alloc(4);
	data.writeUInt32BE(value, 0);
	return attribute(type, data);
}

function errorAttribute(code: number, reason: string): StunAttribute {
	const data = Buffer.alloc(4 + Buffer.byteLength(reason));
	data[2] = Math.floor(code / 100);
	data[3] = code % 100;
	data.write(reason, 4);
	return attribute(ATTR_ERROR_CODE, data);
}

function xorAddress(type: number, address: string, port: number): StunAttribute {
	if (!/^\d+\.\d+\.\d+\.\d+$/u.test(address)) throw new Error(`Mock TURN supports IPv4 only: ${address}`);
	const data = Buffer.alloc(8);
	data[1] = 0x01;
	data.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
	const cookie = Buffer.alloc(4);
	cookie.writeUInt32BE(MAGIC_COOKIE, 0);
	address.split(".").forEach((part, index) => { data[4 + index] = Number.parseInt(part, 10) ^ cookie[index]; });
	return attribute(type, data);
}

function decodeXorAddress(value: Buffer): { address: string; port: number } | undefined {
	if (value.length < 8 || value[1] !== 0x01) return undefined;
	const cookie = Buffer.alloc(4);
	cookie.writeUInt32BE(MAGIC_COOKIE, 0);
	return {
		port: value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16),
		address: [0, 1, 2, 3].map((index) => value[4 + index] ^ cookie[index]).join("."),
	};
}

function getAttribute(message: StunMessage, type: number): StunAttribute | undefined {
	return message.attributes.find((value) => value.type === type);
}

function attributeText(message: StunMessage, type: number): string | undefined {
	return getAttribute(message, type)?.value.toString("utf8");
}

function responseType(requestType: number): { success: number; error: number } | undefined {
	if (requestType === ALLOCATE_REQUEST) return { success: ALLOCATE_SUCCESS, error: ALLOCATE_ERROR };
	if (requestType === REFRESH_REQUEST) return { success: REFRESH_SUCCESS, error: REFRESH_ERROR };
	if (requestType === CREATE_PERMISSION_REQUEST) return { success: CREATE_PERMISSION_SUCCESS, error: CREATE_PERMISSION_ERROR };
	if (requestType === CHANNEL_BIND_REQUEST) return { success: CHANNEL_BIND_SUCCESS, error: CHANNEL_BIND_ERROR };
	return undefined;
}

function clientKey(remote: Pick<RemoteInfo, "address" | "port">): string {
	return `${remote.address}:${remote.port}`;
}

function peerKey(remote: Pick<RemoteInfo, "address" | "port">): string {
	return `${remote.address}:${remote.port}`;
}

function align4(value: number): number {
	return (value + 3) & ~3;
}

function bind(socket: Socket, port: number, address: string): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.bind(port, address, () => {
			socket.off("error", reject);
			resolve();
		});
	});
}

function closeSocket(socket: Socket): Promise<void> {
	return new Promise((resolve) => socket.close(() => resolve()));
}

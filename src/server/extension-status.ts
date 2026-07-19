import { stripVTControlCharacters } from "node:util";
import type { ExtensionStatuses } from "../shared/ws-protocol.js";

const MAX_STATUS_KEY_LENGTH = 128;
const MAX_STATUS_TEXT_LENGTH = 512;
const KEY_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function isValidExtensionStatusKey(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_STATUS_KEY_LENGTH
		&& !KEY_CONTROL_CHARACTER.test(value);
}

export function normalizeExtensionStatusText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(CONTROL_CHARACTERS, "")
		.replace(/\s{2,}/g, " ")
		.trim()
		.slice(0, MAX_STATUS_TEXT_LENGTH);
}

export function extensionStatusSnapshot(statuses: ReadonlyMap<string, string> | undefined): ExtensionStatuses {
	return Object.fromEntries(statuses ?? []);
}

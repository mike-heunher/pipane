import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SessionPathErrorCode = "invalid" | "not_found";

export class SessionPathError extends Error {
	constructor(
		message: string,
		readonly code: SessionPathErrorCode,
	) {
		super(message);
		this.name = "SessionPathError";
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ""
		&& relative !== ".."
		&& !relative.startsWith(`..${path.sep}`)
		&& !path.isAbsolute(relative);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

/** Canonicalizes and confines all client-provided Pi session file paths. */
export class SessionPathGuard {
	readonly configuredRoot: string;

	constructor(sessionsRoot = path.join(getAgentDir(), "sessions")) {
		this.configuredRoot = path.resolve(sessionsRoot);
	}

	resolveExisting(value: unknown): string {
		const candidate = this.resolveLexical(value);
		const canonicalRoot = this.resolveRoot();
		let canonicalCandidate: string;
		try {
			canonicalCandidate = realpathSync(candidate);
		} catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
				throw new SessionPathError("Session file not found", "not_found");
			}
			throw new SessionPathError("Invalid session path", "invalid");
		}

		if (path.extname(canonicalCandidate) !== ".jsonl" || !isWithin(canonicalRoot, canonicalCandidate)) {
			throw new SessionPathError("Session path escapes the Pi sessions directory", "invalid");
		}

		try {
			if (!statSync(canonicalCandidate).isFile()) {
				throw new SessionPathError("Session path is not a file", "invalid");
			}
		} catch (error) {
			if (error instanceof SessionPathError) throw error;
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
				throw new SessionPathError("Session file not found", "not_found");
			}
			throw new SessionPathError("Invalid session path", "invalid");
		}

		return canonicalCandidate;
	}

	/**
	 * Canonicalizes a path allocated by Pi before Pi has flushed the new file.
	 * Its existing parent is still resolved so a symlinked directory cannot escape.
	 */
	resolvePending(value: unknown): string {
		const candidate = this.resolveLexical(value);
		try {
			return this.resolveExisting(candidate);
		} catch (error) {
			if (!(error instanceof SessionPathError) || error.code !== "not_found") throw error;
		}

		const canonicalRoot = this.resolveRoot();
		let canonicalParent: string;
		try {
			canonicalParent = realpathSync(path.dirname(candidate));
		} catch {
			throw new SessionPathError("Session parent directory not found", "not_found");
		}
		if (canonicalParent !== canonicalRoot && !isWithin(canonicalRoot, canonicalParent)) {
			throw new SessionPathError("Session path escapes the Pi sessions directory", "invalid");
		}
		try {
			if (!statSync(canonicalParent).isDirectory()) {
				throw new SessionPathError("Invalid session parent directory", "invalid");
			}
		} catch (error) {
			if (error instanceof SessionPathError) throw error;
			throw new SessionPathError("Invalid session parent directory", "invalid");
		}
		return path.join(canonicalParent, path.basename(candidate));
	}

	/** Returns a confined, canonical destination for a server-generated filename. */
	createPath(filename: string): string {
		if (!filename || path.basename(filename) !== filename || path.extname(filename) !== ".jsonl") {
			throw new SessionPathError("Invalid generated session filename", "invalid");
		}
		const canonicalRoot = this.resolveRoot();
		const candidate = path.join(canonicalRoot, filename);
		if (!isWithin(canonicalRoot, candidate)) {
			throw new SessionPathError("Generated session path escapes the Pi sessions directory", "invalid");
		}
		return candidate;
	}

	private resolveLexical(value: unknown): string {
		if (typeof value !== "string" || !value || value.includes("\0")) {
			throw new SessionPathError("Missing or invalid session path", "invalid");
		}
		if (!path.isAbsolute(value)) {
			throw new SessionPathError("Session path must be absolute", "invalid");
		}

		const candidate = path.resolve(value);
		if (path.extname(candidate) !== ".jsonl" || !isWithin(this.configuredRoot, candidate)) {
			throw new SessionPathError("Session path must be a .jsonl file within the Pi sessions directory", "invalid");
		}
		return candidate;
	}

	private resolveRoot(): string {
		let canonicalRoot: string;
		try {
			canonicalRoot = realpathSync(this.configuredRoot);
		} catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
				throw new SessionPathError("Pi sessions directory not found", "not_found");
			}
			throw new SessionPathError("Invalid Pi sessions directory", "invalid");
		}

		try {
			if (!statSync(canonicalRoot).isDirectory()) {
				throw new SessionPathError("Invalid Pi sessions directory", "invalid");
			}
		} catch (error) {
			if (error instanceof SessionPathError) throw error;
			throw new SessionPathError("Invalid Pi sessions directory", "invalid");
		}
		return canonicalRoot;
	}
}

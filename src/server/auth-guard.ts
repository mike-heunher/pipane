import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";

const AUTH_COOKIE_NAME = "pipane_auth";

export interface AuthGuardOptions {
	token: string;
	/** Explicit compatibility escape hatch. Token authentication is secure-by-default. */
	allowLocalBypass?: boolean;
	secureCookie?: boolean;
}

export class AuthGuard {
	private readonly token: string;
	private readonly allowLocalBypass: boolean;
	private readonly secureCookie: boolean;

	constructor(options: AuthGuardOptions) {
		this.token = options.token;
		this.allowLocalBypass = options.allowLocalBypass ?? false;
		this.secureCookie = options.secureCookie ?? false;
	}

	private parseCookies(header: string | undefined): Record<string, string> {
		const cookies: Record<string, string> = {};
		if (!header) return cookies;
		for (const part of header.split(";")) {
			const separator = part.indexOf("=");
			if (separator <= 0) continue;
			const key = part.slice(0, separator).trim();
			const value = part.slice(separator + 1).trim();
			try {
				cookies[key] = decodeURIComponent(value);
			} catch {
				// A malformed cookie is unauthenticated, not a server error.
			}
		}
		return cookies;
	}

	private isLocalRequest(req: Pick<IncomingMessage, "socket">): boolean {
		if (!this.allowLocalBypass) return false;
		const address = req.socket.remoteAddress;
		return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
	}

	private hasValidCookie(req: Pick<IncomingMessage, "headers">): boolean {
		return secretsEqual(this.parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME], this.token);
	}

	private setAuthCookie(res: Response): void {
		const secure = this.secureCookie ? "; Secure" : "";
		const maxAgeSeconds = 60 * 60 * 24 * 30;
		res.setHeader(
			"Set-Cookie",
			`${AUTH_COOKIE_NAME}=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`,
		);
	}

	isAuthorizedRequest(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
		return this.hasValidCookie(req) || this.isLocalRequest(req);
	}

	/**
	 * Browsers may open WebSockets across origins, so cookie authentication alone
	 * does not establish that the page controlling the socket is Pipane itself.
	 */
	isAuthorizedWebSocketRequest(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
		const cookieAuthorized = this.hasValidCookie(req);
		const localAuthorized = this.isLocalRequest(req);
		if (!cookieAuthorized && !localAuthorized) return false;

		const origin = req.headers.origin;
		if (origin === undefined) return cookieAuthorized || localAuthorized;
		if (!isSameHttpOrigin(origin, req.headers.host)) return false;

		// Even when the unsafe compatibility bypass is explicitly enabled, do not
		// let DNS rebinding turn an attacker-controlled hostname into localhost.
		if (!cookieAuthorized && localAuthorized) {
			return isLoopbackHostname(new URL(origin).hostname);
		}
		return true;
	}

	register(app: Express): void {
		app.get("/auth", (req: Request, res: Response) => {
			const token = typeof req.query.token === "string" ? req.query.token : undefined;
			if (this.isLocalRequest(req) || secretsEqual(token, this.token)) {
				this.setAuthCookie(res);
				res.redirect("/");
				return;
			}
			res.status(401).type("html").send("<h3>Unauthorized</h3><p>Invalid auth token.</p>");
		});

		app.use((req: Request, res: Response, next: NextFunction) => {
			if (this.isAuthorizedRequest(req)) {
				if (this.isLocalRequest(req)) this.setAuthCookie(res);
				next();
				return;
			}
			res.status(401).type("html").send(
				"<h3>Unauthorized</h3><p>Open the one-time auth URL shown in the pipane terminal.</p>",
			);
		});
	}
}

function secretsEqual(actual: string | undefined, expected: string): boolean {
	if (actual === undefined) return false;
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.byteLength === expectedBytes.byteLength
		&& timingSafeEqual(actualBytes, expectedBytes);
}

function isSameHttpOrigin(origin: string, host: string | undefined): boolean {
	if (!host) return false;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:")
			&& parsed.host.toLowerCase() === host.toLowerCase()
			&& parsed.username === ""
			&& parsed.password === "";
	} catch {
		return false;
	}
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

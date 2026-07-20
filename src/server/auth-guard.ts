import type { Express, Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";

const AUTH_COOKIE_NAME = "pipane_auth";

export interface AuthGuardOptions {
	token: string;
	disableLocalBypass?: boolean;
	secureCookie?: boolean;
}

export class AuthGuard {
	private readonly token: string;
	private readonly disableLocalBypass: boolean;
	private readonly secureCookie: boolean;

	constructor(options: AuthGuardOptions) {
		this.token = options.token;
		this.disableLocalBypass = options.disableLocalBypass ?? false;
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
			cookies[key] = decodeURIComponent(value);
		}
		return cookies;
	}

	private isLocalRequest(req: Pick<IncomingMessage, "socket">): boolean {
		if (this.disableLocalBypass) return false;
		const address = req.socket.remoteAddress;
		return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
	}

	private setAuthCookie(res: Response): void {
		const secure = this.secureCookie ? "; Secure" : "";
		const maxAgeSeconds = 60 * 60 * 24 * 30;
		res.setHeader(
			"Set-Cookie",
			`${AUTH_COOKIE_NAME}=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`,
		);
	}

	isAuthorizedRequest(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
		if (this.isLocalRequest(req)) return true;
		return this.parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME] === this.token;
	}

	register(app: Express): void {
		app.get("/auth", (req: Request, res: Response) => {
			const token = typeof req.query.token === "string" ? req.query.token : undefined;
			if (this.isLocalRequest(req) || token === this.token) {
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

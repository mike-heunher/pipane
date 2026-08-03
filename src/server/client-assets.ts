import express, { type Express, type RequestHandler } from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ClientRuntimeMode = "local" | "rendezvous";

export interface MountClientAppOptions {
	clientDist: string;
	runtimeMode: ClientRuntimeMode;
	isAppPath(pathname: string): boolean;
}

function acceptsEncoding(value: string | undefined, encoding: "br" | "gzip"): boolean {
	if (!value) return false;
	return value.split(",").some((entry) => {
		const [name, ...parameters] = entry.trim().toLowerCase().split(";");
		if (name !== encoding && name !== "*") return false;
		const quality = parameters
			.map((parameter) => /^q\s*=\s*([0-9.]+)$/u.exec(parameter.trim()))
			.find(Boolean)?.[1];
		return quality === undefined || Number.parseFloat(quality) > 0;
	});
}

function safeAssetPath(assetsDirectory: string, requestPath: string): { relative: string; absolute: string } | undefined {
	let relative: string;
	try {
		relative = decodeURIComponent(requestPath).replace(/^\/+/, "");
	} catch {
		return undefined;
	}
	if (!relative || relative.includes("\0")) return undefined;
	const absolute = path.resolve(assetsDirectory, relative);
	if (!absolute.startsWith(`${assetsDirectory}${path.sep}`)) return undefined;
	return { relative, absolute };
}

export function createClientAssetMiddleware(assetsDirectory: string): RequestHandler {
	const serve = express.static(assetsDirectory, {
		fallthrough: true,
		immutable: true,
		index: false,
		maxAge: "1y",
	});

	return (request, response, next) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.sendStatus(405);
			return;
		}
		const asset = safeAssetPath(assetsDirectory, request.path);
		if (!asset) {
			response.sendStatus(404);
			return;
		}

		const accepted = request.headers["accept-encoding"];
		const representation = acceptsEncoding(accepted, "br") && existsSync(`${asset.absolute}.br`)
			? { suffix: ".br", encoding: "br" }
			: acceptsEncoding(accepted, "gzip") && existsSync(`${asset.absolute}.gz`)
				? { suffix: ".gz", encoding: "gzip" }
				: { suffix: "", encoding: undefined };
		const originalUrl = request.url;
		request.url = `${request.path}${representation.suffix}${originalUrl.slice(request.path.length)}`;
		response.vary("Accept-Encoding");
		response.type(asset.relative);
		if (representation.encoding) response.setHeader("Content-Encoding", representation.encoding);

		serve(request, response, (error) => {
			request.url = originalUrl;
			if (error) {
				next(error);
				return;
			}
			response.sendStatus(404);
		});
	};
}

function runtimeIndexHtml(clientDist: string, runtimeMode: ClientRuntimeMode): string {
	const indexPath = path.join(clientDist, "index.html");
	const source = readFileSync(indexPath, "utf8");
	const runtimeMeta = `<meta name="pipane-runtime" content="${runtimeMode}" />`;
	const marker = /<meta\s+name=["']pipane-runtime["']\s+content=["'][^"']*["']\s*\/?\s*>/iu;
	if (marker.test(source)) return source.replace(marker, runtimeMeta);
	const headEnd = source.search(/<\/head\s*>/iu);
	return headEnd >= 0
		? `${source.slice(0, headEnd)}\t\t${runtimeMeta}\n\t${source.slice(headEnd)}`
		: `${runtimeMeta}\n${source}`;
}

export function mountClientApp(app: Express, options: MountClientAppOptions): void {
	const { clientDist, runtimeMode, isAppPath } = options;
	const indexHtml = runtimeIndexHtml(clientDist, runtimeMode);
	app.use("/assets", createClientAssetMiddleware(path.join(clientDist, "assets")));
	app.use(express.static(clientDist, {
		fallthrough: true,
		index: false,
		maxAge: "1h",
		setHeaders(response) {
			response.setHeader("Cache-Control", "public, max-age=3600");
		},
	}));
	app.use((request, response, next) => {
		if (request.method !== "GET" || !isAppPath(request.path)) {
			next();
			return;
		}
		response.setHeader("Cache-Control", "no-cache");
		response.type("html").send(indexHtml);
	});
}

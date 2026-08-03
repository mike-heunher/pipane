import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const assetsDirectory = path.resolve("dist/client/assets");
const mainBundles = readdirSync(assetsDirectory).filter((name) => /^main-[\w-]+\.js$/u.test(name));
if (mainBundles.length !== 1) {
	throw new Error(`Expected one browser main bundle, found ${mainBundles.length}`);
}

const maximumMainBytes = 450 * 1024;
const mainPath = path.join(assetsDirectory, mainBundles[0]);
const mainBytes = statSync(mainPath).size;
if (mainBytes > maximumMainBytes) {
	throw new Error(
		`Initial browser bundle ${mainBundles[0]} is ${Math.round(mainBytes / 1024)} KiB; `
		+ `keep optional preview, document, dialog, and highlighting code behind dynamic imports (limit ${maximumMainBytes / 1024} KiB)`,
	);
}

console.log(`initial browser bundle: ${Math.round(mainBytes / 1024)} KiB (limit ${maximumMainBytes / 1024} KiB)`);

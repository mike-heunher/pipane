import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createBrotliCompress, createGzip, constants } from "node:zlib";
import path from "node:path";

const assetsDirectory = path.resolve("dist/client/assets");
const compressibleAsset = /\.(?:css|html|js|json|mjs|svg)$/iu;
const minimumBytes = 1024;

if (!existsSync(assetsDirectory)) process.exit(0);

const assets = readdirSync(assetsDirectory)
	.filter((name) => compressibleAsset.test(name))
	.map((name) => path.join(assetsDirectory, name))
	.filter((filePath) => statSync(filePath).size >= minimumBytes);

await Promise.all(assets.flatMap((filePath) => [
	pipeline(
		createReadStream(filePath),
		createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
		createWriteStream(`${filePath}.br`),
	),
	pipeline(
		createReadStream(filePath),
		createGzip({ level: 9 }),
		createWriteStream(`${filePath}.gz`),
	),
]));

const rawBytes = assets.reduce((total, filePath) => total + statSync(filePath).size, 0);
const brotliBytes = assets.reduce((total, filePath) => total + statSync(`${filePath}.br`).size, 0);
console.log(`precompressed ${assets.length} client assets (${Math.round(rawBytes / 1024)} KiB raw, ${Math.round(brotliBytes / 1024)} KiB Brotli)`);

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "unknown";
let revision;
let developmentCommit = false;

function git(...args) {
	return execFileSync("git", ["-C", repositoryRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

try {
	if (git("rev-parse", "--is-inside-work-tree") === "true") {
		revision = git("rev-parse", "--short", "HEAD") || undefined;
		const releaseTag = `v${packageVersion}`;
		const tags = git("tag", "--points-at", "HEAD", "--list", releaseTag).split(/\r?\n/).filter(Boolean);
		const dirty = git("status", "--porcelain", "--untracked-files=normal").length > 0;
		developmentCommit = dirty || !tags.includes(releaseTag);
	}
} catch {
	// Builds without Git metadata are treated as release builds so normal npm
	// installations continue checking for pipane updates.
}

const outputPath = path.join(repositoryRoot, "dist", "build-info.json");
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ packageVersion, revision, developmentCommit }, null, 2)}\n`);

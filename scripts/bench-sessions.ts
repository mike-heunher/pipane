import express from "express";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { registerRestApi } from "../src/server/rest-api.js";

type Options = {
	sessions: number;
	messagesPerSession: number;
	warmup: number;
	iterations: number;
	agentDir?: string;
};

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		sessions: 250,
		messagesPerSession: 120,
		warmup: 3,
		iterations: 15,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--agent-dir") {
			if (!next) throw new Error("--agent-dir requires a path");
			opts.agentDir = path.resolve(next);
			i++;
			continue;
		}
		if (!next) continue;
		if (arg === "--sessions") {
			opts.sessions = Number(next);
			i++;
		} else if (arg === "--messages") {
			opts.messagesPerSession = Number(next);
			i++;
		} else if (arg === "--warmup") {
			opts.warmup = Number(next);
			i++;
		} else if (arg === "--iterations") {
			opts.iterations = Number(next);
			i++;
		}
	}

	if (!Number.isFinite(opts.sessions) || opts.sessions <= 0) throw new Error("--sessions must be > 0");
	if (!Number.isFinite(opts.messagesPerSession) || opts.messagesPerSession <= 0) throw new Error("--messages must be > 0");
	if (!Number.isFinite(opts.warmup) || opts.warmup < 0) throw new Error("--warmup must be >= 0");
	if (!Number.isFinite(opts.iterations) || opts.iterations <= 0) throw new Error("--iterations must be > 0");

	return opts;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

function fmtMs(ms: number): string {
	return `${ms.toFixed(2)} ms`;
}

function getLastUserPromptTimeFromContent(content: string): string | undefined {
	const entries = parseSessionEntries(content);
	let latestUserTs = 0;
	for (const entry of entries) {
		if ((entry as any).type !== "message") continue;
		const msg = (entry as any).message;
		if (!msg || msg.role !== "user") continue;
		if (typeof msg.timestamp === "number" && msg.timestamp > latestUserTs) {
			latestUserTs = msg.timestamp;
		} else if (typeof (entry as any).timestamp === "string") {
			const t = new Date((entry as any).timestamp).getTime();
			if (!Number.isNaN(t) && t > latestUserTs) latestUserTs = t;
		}
	}
	return latestUserTs > 0 ? new Date(latestUserTs).toISOString() : undefined;
}

function generateSessionJsonl(sessionIdx: number, messagesPerSession: number): string {
	const rootId = `root_${sessionIdx}`;
	const baseTs = Date.now() - sessionIdx * 60_000;
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			id: rootId,
			cwd: `/tmp/project-${sessionIdx % 7}`,
			timestamp: new Date(baseTs).toISOString(),
		}),
	];

	let prevId = rootId;
	for (let i = 0; i < messagesPerSession; i++) {
		const role = i % 2 === 0 ? "user" : "assistant";
		const ts = baseTs + i * 1_000;
		const id = `msg_${sessionIdx}_${i}`;
		lines.push(JSON.stringify({
			type: "message",
			id,
			parentId: prevId,
			timestamp: new Date(ts).toISOString(),
			message: {
				role,
				timestamp: ts,
				content: role === "user"
					? `prompt ${sessionIdx}-${i} lorem ipsum dolor sit amet ${"x".repeat(40)}`
					: [{ type: "text", text: `response ${sessionIdx}-${i} ${"y".repeat(60)}` }],
			},
		}));
		prevId = id;
	}

	return lines.join("\n") + "\n";
}

async function createFixture(opts: Options): Promise<{ agentDir: string; contents: string[]; label: string; cleanupDir: string }> {
	const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipane-bench-"));
	const agentDir = path.join(rootDir, ".pi-agent");
	const sessionsDir = path.join(agentDir, "sessions");
	await mkdir(sessionsDir, { recursive: true });

	const contents: string[] = [];
	for (let i = 0; i < opts.sessions; i++) {
		const content = generateSessionJsonl(i, opts.messagesPerSession);
		const file = path.join(sessionsDir, `session-${String(i).padStart(5, "0")}.jsonl`);
		await writeFile(file, content, "utf8");
		contents.push(content);
	}

	return {
		agentDir,
		contents,
		label: `synthetic fixture (${opts.sessions} sessions x ${opts.messagesPerSession} messages)`,
		cleanupDir: rootDir,
	};
}

async function listJsonlFilesRecursive(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...await listJsonlFilesRecursive(full));
		} else if (entry.isFile() && full.endsWith(".jsonl")) {
			out.push(full);
		}
	}
	return out;
}

async function loadRealSessionContents(agentDir: string): Promise<{ contents: string[]; label: string }> {
	const sessionsDir = path.join(agentDir, "sessions");
	const files = await listJsonlFilesRecursive(sessionsDir);
	const contents = await Promise.all(files.map((f) => readFile(f, "utf8")));
	return {
		contents,
		label: `real sessions (${files.length} files under ${sessionsDir})`,
	};
}

async function benchmarkJsonlParser(contents: string[], opts: Options): Promise<number[]> {
	const samples: number[] = [];
	const rounds = opts.warmup + opts.iterations;
	for (let i = 0; i < rounds; i++) {
		const start = performance.now();
		for (const content of contents) {
			getLastUserPromptTimeFromContent(content);
		}
		const elapsed = performance.now() - start;
		if (i >= opts.warmup) samples.push(elapsed);
	}
	return samples;
}

async function benchmarkApiSessions(opts: Options): Promise<{ coldMs: number; warmSamples: number[] }> {
	const app = express();
	registerRestApi(app);

	const server = await new Promise<import("node:http").Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("Failed to get listen address");
	const url = `http://127.0.0.1:${addr.port}/api/sessions`;

	const runOne = async (): Promise<number> => {
		const start = performance.now();
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		await res.json();
		return performance.now() - start;
	};

	try {
		const coldMs = await runOne();

		for (let i = 0; i < opts.warmup; i++) await runOne();

		const warmSamples: number[] = [];
		for (let i = 0; i < opts.iterations; i++) warmSamples.push(await runOne());

		return { coldMs, warmSamples };
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
}

function summarize(samples: number[]): { mean: number; p50: number; p95: number; min: number; max: number } {
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return {
		mean,
		p50: percentile(samples, 50),
		p95: percentile(samples, 95),
		min: Math.min(...samples),
		max: Math.max(...samples),
	};
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	let cleanupDir: string | undefined;
	let agentDir: string;
	let contents: string[];
	let label: string;

	if (opts.agentDir) {
		agentDir = opts.agentDir;
		const real = await loadRealSessionContents(agentDir);
		contents = real.contents;
		label = real.label;
	} else {
		const fixture = await createFixture(opts);
		agentDir = fixture.agentDir;
		contents = fixture.contents;
		label = fixture.label;
		cleanupDir = fixture.cleanupDir;
	}

	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		console.log("Benchmarking session listing + JSONL parsing");
		console.log(`Source: ${label}`);
		console.log(`Warmup: ${opts.warmup}, iterations: ${opts.iterations}`);
		console.log("");

		const parseSamples = await benchmarkJsonlParser(contents, opts);
		const parseStats = summarize(parseSamples);

		const apiStatsRaw = await benchmarkApiSessions(opts);
		const apiWarmStats = summarize(apiStatsRaw.warmSamples);

		console.log("JSONL parse benchmark (parseSessionEntries + last user prompt scan)");
		console.log(`  mean: ${fmtMs(parseStats.mean)} | p50: ${fmtMs(parseStats.p50)} | p95: ${fmtMs(parseStats.p95)} | min/max: ${fmtMs(parseStats.min)} / ${fmtMs(parseStats.max)}`);
		console.log("");
		console.log("Backend handler benchmark (GET /api/sessions)");
		console.log(`  cold (first request): ${fmtMs(apiStatsRaw.coldMs)}`);
		console.log(`  warm mean: ${fmtMs(apiWarmStats.mean)} | p50: ${fmtMs(apiWarmStats.p50)} | p95: ${fmtMs(apiWarmStats.p95)} | min/max: ${fmtMs(apiWarmStats.min)} / ${fmtMs(apiWarmStats.max)}`);
	} finally {
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});

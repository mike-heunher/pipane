/**
 * E2E test harness: starts a real pipane server backed by a mock LLM.
 *
 * - Spins up a mock OpenAI-compatible server (mock-llm-server.ts)
 * - Creates an isolated Pi agent directory and project
 * - Launches the built pipane server on an OS-assigned port
 * - Verifies a unique instance ID before exposing the server to tests
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createMockLlmServer, type MockLlmServer, type Scenario } from "./mock-llm-server.js";
import { WS_PROTOCOL_VERSION } from "../src/shared/ws-protocol.js";

export interface E2EHarness {
	pipanePort: number;
	authUrl: string;
	mockLlm: MockLlmServer;
	setScenarios(scenarios: Scenario[]): void;
	agentDir: string;
	projectDir: string;
	close(): Promise<void>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const exitedChildren = new WeakSet<ChildProcess>();

async function waitForReportedServer(
	child: ChildProcess,
	getStdout: () => string,
	getStderr: () => string,
	instanceId: string,
	authToken: string,
	timeoutMs = 30_000,
): Promise<number> {
	const startedAt = Date.now();
	let spawnError: Error | undefined;
	const onError = (error: Error) => { spawnError = error; };
	child.on("error", onError);

	try {
		let port: number | undefined;
		while (Date.now() - startedAt < timeoutMs) {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`pipane exited before startup (code=${child.exitCode}, signal=${child.signalCode})`);
			}

			const match = getStdout().match(/Local:\s+http:\/\/localhost:(\d+)/);
			if (match) {
				port = Number(match[1]);
				break;
			}
			await delay(25);
		}

		if (!port) throw new Error(`pipane did not report its bound port within ${timeoutMs}ms`);

		while (Date.now() - startedAt < timeoutMs) {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`pipane exited during readiness (code=${child.exitCode}, signal=${child.signalCode})`);
			}
			try {
				const response = await fetch(`http://127.0.0.1:${port}/api/debug/health`, {
					cache: "no-store",
					headers: { Cookie: `pipane_auth=${encodeURIComponent(authToken)}` },
				});
				if (response.ok) {
					const body = await response.json() as { ok?: boolean; instanceId?: string };
					if (body.ok === true && body.instanceId === instanceId) return port;
				}
			} catch {
				// The child reported the port before HTTP was ready; continue polling.
			}
			await delay(50);
		}

		throw new Error(`pipane instance ${instanceId} did not become ready within ${timeoutMs}ms`);
	} catch (error) {
		const detail = [
			error instanceof Error ? error.message : String(error),
			"--- pipane stdout ---",
			getStdout() || "(empty)",
			"--- pipane stderr ---",
			getStderr() || "(empty)",
		].join("\n");
		throw new Error(detail, { cause: error });
	} finally {
		child.off("error", onError);
	}
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid || child.exitCode !== null || exitedChildren.has(child)) return;
	try {
		// The harness launches pipane as a process-group leader so Pi RPC children
		// cannot survive a failed test run.
		process.kill(-child.pid, signal);
	} catch {
		try { child.kill(signal); } catch { /* already exited */ }
	}
}

async function stopProcessGroup(child: ChildProcess, graceMs = 3_000): Promise<void> {
	if (child.exitCode !== null || exitedChildren.has(child)) return;

	const waitForExit = () => new Promise<boolean>((resolve) => {
		if (child.exitCode !== null || exitedChildren.has(child)) {
			resolve(true);
			return;
		}
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, graceMs);
		child.once("exit", onExit);
	});

	// Attach the exit listener before signalling; signalCode may be populated
	// before the exit event while descendants can still recreate temp paths.
	const gracefulExit = waitForExit();
	signalProcessGroup(child, "SIGTERM");
	if (await gracefulExit) return;
	const forcedExit = waitForExit();
	signalProcessGroup(child, "SIGKILL");
	if (!await forcedExit) throw new Error(`pipane process group ${child.pid} did not exit after SIGKILL`);
}

/** Trigger Pi process acquisition without creating a session. */
async function warmUpPiProcess(port: number, authToken: string): Promise<void> {
	const { default: WebSocket } = await import("ws");
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
		headers: { Cookie: `pipane_auth=${encodeURIComponent(authToken)}` },
	});

	await new Promise<void>((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			ws.removeAllListeners();
			ws.close();
			error ? reject(error) : resolve();
		};
		const timeout = setTimeout(() => finish(new Error("Pi warm-up timed out")), 30_000);

		ws.once("open", () => {
			ws.send(JSON.stringify({
				protocolVersion: WS_PROTOCOL_VERSION,
				type: "get_default_model",
				id: "warmup_1",
			}));
		});
		ws.on("message", (data) => {
			try {
				const message = JSON.parse(data.toString());
				if (message.type !== "response" || message.id !== "warmup_1") return;
				if (message.success === false) {
					finish(new Error(message.error || "Pi warm-up request failed"));
					return;
				}
				finish();
			} catch {
				// Ignore unrelated/non-JSON records while waiting for our response.
			}
		});
		ws.once("error", (error) => finish(error));
	});
}

export async function startHarness(scenarios?: Scenario[]): Promise<E2EHarness> {
	const serverScript = path.resolve(import.meta.dirname, "../dist/server/server/server.js");
	if (!existsSync(serverScript)) {
		throw new Error(`pipane server not built. Run 'npm run build' first. Missing: ${serverScript}`);
	}

	const mockLlm = await createMockLlmServer(scenarios);
	const tmpBase = path.join("/tmp", `pi-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
	const agentDir = path.join(tmpBase, "agent");
	const sessionsDir = path.join(agentDir, "sessions");
	const projectDir = path.join(tmpBase, "project");
	const instanceId = `e2e-${crypto.randomUUID()}`;
	const authToken = crypto.randomUUID();

	mkdirSync(sessionsDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		path.join(projectDir, "config.ts"),
		'export const config = {\n  port: 3000,\n  host: "localhost",\n};\n',
	);

	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			mock: {
				baseUrl: `http://127.0.0.1:${mockLlm.port}/v1`,
				apiKey: "mock-key",
				api: "openai-completions",
				models: [
					{
						id: "mock-model",
						name: "Mock Model",
						reasoning: true,
						thinkingLevelMap: { xhigh: "xhigh", max: "max" },
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
					{
						id: "mock-sparse",
						name: "Mock Sparse Reasoning",
						reasoning: true,
						thinkingLevelMap: {
							minimal: null,
							low: null,
							medium: null,
							xhigh: null,
							max: "max",
						},
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			},
		},
	}, null, 2));
	writeFileSync(path.join(agentDir, "auth.json"), "{}");
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "mock",
		defaultModel: "mock-model",
		defaultThinkingLevel: "medium",
		autoCompaction: false,
	}, null, 2));

	const sanitizedEnv: Record<string, string> = {};
	const stripPrefixes = [
		"AWS_", "ANTHROPIC_", "OPENAI_", "GOOGLE_", "AZURE_",
		"XAI_", "GROQ_", "MISTRAL_", "GITHUB_TOKEN",
	];
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || stripPrefixes.some((prefix) => key.startsWith(prefix))) continue;
		sanitizedEnv[key] = value;
	}

	const child = spawn(process.execPath, [serverScript], {
		env: {
			...sanitizedEnv,
			PORT: "0",
			PIPANE_INSTANCE_ID: instanceId,
			PIPANE_AUTH_TOKEN: authToken,
			PIPANE_RENDEZVOUS_URL: "",
			PIPANE_SKIP_UPDATE_CHECK: "1",
			PI_CWD: projectDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CLI: path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
			NODE_ENV: "production",
			PI_MODEL: "mock/mock-model",
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	child.once("exit", () => exitedChildren.add(child));

	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (data) => { stdout += data.toString(); });
	child.stderr?.on("data", (data) => { stderr += data.toString(); });

	let closed = false;
	const cleanup = async () => {
		if (closed) return;
		closed = true;
		const results = await Promise.allSettled([
			stopProcessGroup(child),
			mockLlm.close(),
		]);
		rmSync(tmpBase, { recursive: true, force: true });
		const failures = results
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		if (failures.length > 0) throw new AggregateError(failures, "Failed to clean up E2E harness");
	};

	try {
		const pipanePort = await waitForReportedServer(child, () => stdout, () => stderr, instanceId, authToken);
		await warmUpPiProcess(pipanePort, authToken);
		return {
			pipanePort,
			authUrl: `http://localhost:${pipanePort}/auth?token=${encodeURIComponent(authToken)}`,
			mockLlm,
			setScenarios: (next) => mockLlm.setScenarios(next),
			agentDir,
			projectDir,
			close: cleanup,
		};
	} catch (error) {
		try {
			await cleanup();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "E2E harness startup and cleanup failed");
		}
		throw error;
	}
}

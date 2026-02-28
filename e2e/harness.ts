/**
 * E2E test harness: starts a real pi-web server backed by a mock LLM.
 *
 * - Spins up a mock OpenAI-compatible server (mock-llm-server.ts)
 * - Creates a temp directory with a models.json pointing at the mock
 * - Launches the real pi-web server with PI_CODING_AGENT_DIR set to the temp dir
 * - Provides a Playwright-friendly API for tests
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createMockLlmServer, type MockLlmServer, type Scenario } from "./mock-llm-server.js";
import { createServer } from "node:net";

export interface E2EHarness {
	/** The port the real pi-web server is listening on */
	piWebPort: number;
	/** The mock LLM server */
	mockLlm: MockLlmServer;
	/** Override LLM scenarios at runtime */
	setScenarios(scenarios: Scenario[]): void;
	/** The temp agent dir used for config/sessions */
	agentDir: string;
	/** The temp project cwd */
	projectDir: string;
	/** Tear everything down */
	close(): Promise<void>;
}

/**
 * Wait for a port to accept connections.
 */
async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`http://localhost:${port}/api/sessions`);
			if (res.ok) return;
		} catch {
			// Not ready yet
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Timed out waiting for port ${port} after ${timeoutMs}ms`);
}

async function getFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				server.close();
				reject(new Error("Failed to allocate free port"));
				return;
			}
			const port = addr.port;
			server.close((err) => {
				if (err) reject(err);
				else resolve(port);
			});
		});
		server.on("error", reject);
	});
}

export async function startHarness(scenarios?: Scenario[]): Promise<E2EHarness> {
	// 1. Start mock LLM
	const mockLlm = await createMockLlmServer(scenarios);

	// 2. Create temp directories
	const tmpBase = path.join("/tmp", `pi-e2e-${Date.now()}`);
	const agentDir = path.join(tmpBase, "agent");
	const sessionsDir = path.join(agentDir, "sessions");
	const projectDir = path.join(tmpBase, "project");

	mkdirSync(sessionsDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	// Create a simple file in the project for tools to read
	writeFileSync(
		path.join(projectDir, "config.ts"),
		'export const config = {\n  port: 3000,\n  host: "localhost",\n};\n',
	);

	// 3. Write models.json pointing at mock LLM
	const modelsJson = {
		providers: {
			"mock": {
				baseUrl: `http://localhost:${mockLlm.port}/v1`,
				apiKey: "mock-key",
				api: "openai-completions",
				models: [
					{
						id: "mock-model",
						name: "Mock Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			},
		},
	};
	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsJson, null, 2));

	// Write empty auth.json so pi doesn't prompt for login
	writeFileSync(path.join(agentDir, "auth.json"), "{}");

	// Write settings to disable auto-compaction and set the mock model as default
	// NOTE: pi requires both defaultProvider AND defaultModel to resolve the saved default.
	// If defaultProvider is missing, it falls through to "first model with valid API key",
	// which picks up real providers (e.g., Bedrock) from ambient credentials.
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "mock",
			defaultModel: "mock-model",
			autoCompaction: false,
		}, null, 2),
	);

	// 4. Find a guaranteed free port for pi-web
	const piWebPort = await getFreePort();

	// 5. Build server path
	const serverScript = path.resolve(import.meta.dirname, "../dist/server/server.js");
	if (!existsSync(serverScript)) {
		throw new Error(`pi-web server not built. Run 'npm run build' first. Missing: ${serverScript}`);
	}

	// 6. Start real pi-web server with a sanitized environment.
	//    Strip API keys and cloud credentials so pi only sees the mock provider.
	//    This prevents ambient AWS/Anthropic/OpenAI credentials from leaking in.
	const sanitizedEnv: Record<string, string> = {};
	const stripPrefixes = [
		"AWS_", "ANTHROPIC_", "OPENAI_", "GOOGLE_", "AZURE_",
		"XAI_", "GROQ_", "MISTRAL_", "GITHUB_TOKEN",
	];
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (stripPrefixes.some((p) => key.startsWith(p))) continue;
		sanitizedEnv[key] = value;
	}

	const env: Record<string, string> = {
		...sanitizedEnv,
		PORT: String(piWebPort),
		PI_CWD: projectDir,
		PI_CODING_AGENT_DIR: agentDir,
		NODE_ENV: "production",
		// Ensure pi uses our mock model
		PI_MODEL: "mock/mock-model",
	};

	const child: ChildProcess = spawn("node", [serverScript], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Collect output for debugging
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (d) => { stdout += d.toString(); });
	child.stderr?.on("data", (d) => { stderr += d.toString(); });

	child.on("error", (err) => {
		console.error("[pi-web] spawn error:", err);
	});

	// 7. Wait for server to be ready
	try {
		await waitForPort(piWebPort);
	} catch (err) {
		console.error("[pi-web] stdout:", stdout);
		console.error("[pi-web] stderr:", stderr);
		child.kill("SIGTERM");
		await mockLlm.close();
		throw err;
	}

	return {
		piWebPort,
		mockLlm,
		setScenarios: (s) => mockLlm.setScenarios(s),
		agentDir,
		projectDir,
		close: async () => {
			child.kill("SIGTERM");
			await new Promise<void>((r) => {
				child.on("exit", () => r());
				setTimeout(r, 3000); // force if stuck
			});
			await mockLlm.close();
			// Clean up temp dirs
			try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* */ }
		},
	};
}

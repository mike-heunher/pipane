import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProcessPool, type RpcProcess, type SpawnConfig } from "./process-pool.js";

// We can't easily spawn real pi processes in tests, so we test the
// pool logic with a mock spawn config that will fail to spawn. For
// unit-testable logic (lease selection, atomic reservation, caps),
// we inject processes directly.

function makeSpawnConfig(): SpawnConfig {
	return {
		command: "echo",
		baseArgs: ["test"],
	};
}

/**
 * Create a pool and inject mock processes for testing pool logic
 * without actually spawning child processes.
 */
function createPoolWithMocks(options?: { maxProcesses?: number }) {
	const pool = new ProcessPool(makeSpawnConfig(), {
		maxProcesses: options?.maxProcesses ?? 10,
		prewarmCount: 0,
	});

	// Access internal pools map for injecting mock processes
	const poolsMap = (pool as any).pools as Map<string, RpcProcess[]>;

	function injectProc(cwd: string, id: number, alive = true): RpcProcess {
		const proc = {
			id,
			cwd,
			process: { exitCode: alive ? null : 1, stdin: { write: vi.fn() }, kill: vi.fn(() => true) } as any,
			rl: {} as any,
			pendingRequests: new Map(),
			requestId: 0,
			lastResponseTime: Date.now(),
		} as RpcProcess;

		let cwdPool = poolsMap.get(cwd);
		if (!cwdPool) {
			cwdPool = [];
			poolsMap.set(cwd, cwdPool);
		}
		cwdPool.push(proc);
		return proc;
	}

	return { pool, injectProc, poolsMap };
}

describe("ProcessPool", () => {
	describe("leased acquisition with cwd grouping", () => {
		it("atomically leases an idle process for the matching cwd", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);

			const lease = pool.acquire("/project-a");

			expect(lease?.process).toBe(proc);
			expect(pool.isLeased(proc)).toBe(true);
			lease?.release();
			expect(pool.isLeased(proc)).toBe(false);
		});

		it("does not return a process from a different cwd at capacity", () => {
			const pool = new ProcessPool(makeSpawnConfig(), { maxProcesses: 1 });
			const pools = (pool as any).pools as Map<string, RpcProcess[]>;
			pools.set("/project-a", [{
				id: 1,
				cwd: "/project-a",
				process: { exitCode: null } as any,
				rl: {} as any,
				pendingRequests: new Map(),
				requestId: 0,
				lastResponseTime: Date.now(),
				recentStderr: [],
			} as RpcProcess]);

			expect(pool.acquire("/project-b")).toBeNull();
		});

		it("never leases the same process twice", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc1 = injectProc("/project-a", 1);
			const proc2 = injectProc("/project-a", 2);

			const first = pool.acquire("/project-a");
			const second = pool.acquire("/project-a");

			expect(first?.process).toBe(proc1);
			expect(second?.process).toBe(proc2);
			first?.release();
			second?.release();
		});

		it("skips dead processes", () => {
			const { pool, injectProc } = createPoolWithMocks();
			injectProc("/project-a", 1, false);
			const proc2 = injectProc("/project-a", 2, true);
			const lease = pool.acquire("/project-a");
			expect(lease?.process).toBe(proc2);
			lease?.release();
		});
	});

	describe("acquireAny", () => {
		it("leases any idle process across cwds", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);
			const lease = pool.acquireAny();
			expect(lease?.process).toBe(proc);
			lease?.release();
		});

		it("prefers an idle process and never falls back to a leased process", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc1 = injectProc("/project-a", 1);
			const proc2 = injectProc("/project-b", 2);
			const first = pool.acquire("/project-a");
			const second = pool.acquireAny();
			expect(first?.process).toBe(proc1);
			expect(second?.process).toBe(proc2);
			expect(pool.acquireAny()).toBeNull();
			first?.release();
			second?.release();
		});

		it("returns null when no live processes exist", () => {
			const { pool } = createPoolWithMocks();
			expect(pool.acquireAny()).toBeNull();
		});
	});

	describe("totalProcesses", () => {
		it("counts live processes across all cwds", () => {
			const { pool, injectProc } = createPoolWithMocks();
			injectProc("/project-a", 1);
			injectProc("/project-a", 2, false); // dead
			injectProc("/project-b", 3);

			expect(pool.totalProcesses).toBe(2);
		});
	});

	describe("getAllProcesses", () => {
		it("returns all processes from all pools", () => {
			const { pool, injectProc } = createPoolWithMocks();
			injectProc("/project-a", 1);
			injectProc("/project-b", 2);

			const all = pool.getAllProcesses();
			expect(all).toHaveLength(2);
			expect(all.map((p) => p.id).sort()).toEqual([1, 2]);
		});
	});

	describe("sendRpc", () => {
		it("rejects if process is dead", async () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1, false);

			await expect(pool.sendRpc(proc, { type: "test" })).rejects.toThrow("RPC process is dead");
		});

		it("sends command and resolves on response", async () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);

			// Capture what's written to stdin
			const written: string[] = [];
			(proc.process.stdin as any).write = vi.fn((data: string) => {
				written.push(data);
				// Simulate response
				const cmd = JSON.parse(data);
				const pending = proc.pendingRequests.get(cmd.id);
				if (pending) {
					setTimeout(() => {
						pending.resolve({ id: cmd.id, type: "response", success: true, data: { hello: "world" } });
					}, 0);
				}
			});

			const result = await pool.sendRpc(proc, { type: "get_state" });
			expect(result).toEqual({ id: expect.any(String), type: "response", success: true, data: { hello: "world" } });
		});
	});

	describe("process events", () => {
		it("delivers non-response events before resolving the RPC response", async () => {
			const script = [
				"let buffer = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => {",
				"  buffer += chunk;",
				"  const newline = buffer.indexOf('\\n');",
				"  if (newline < 0) return;",
				"  const command = JSON.parse(buffer.slice(0, newline));",
				"  console.log('not-json');",
				"  console.log(JSON.stringify({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'usage', statusText: '42%' }));",
				"  console.log(JSON.stringify({ type: 'response', id: command.id, success: true, data: { ready: true } }));",
				"});",
			].join("\n");
			const pool = new ProcessPool({ command: process.execPath, baseArgs: ["-e", script] }, {
				maxProcesses: 1,
				prewarmCount: 0,
			});
			const listener = vi.fn();
			const unsubscribe = pool.subscribeEvents(listener);
			const proc = pool.spawn(process.cwd());

			try {
				const response = await pool.sendRpc(proc, { type: "get_state" });
				expect(response.data).toEqual({ ready: true });
				expect(listener).toHaveBeenCalledTimes(1);
				expect(listener).toHaveBeenCalledWith(proc, expect.objectContaining({
					type: "extension_ui_request",
					statusKey: "usage",
					statusText: "42%",
				}));
			} finally {
				unsubscribe();
				proc.process.kill("SIGTERM");
			}
		});

		it("supports unsubscribing and isolates listener failures", () => {
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);
			const failing = vi.fn(() => { throw new Error("boom"); });
			const listener = vi.fn();
			const unsubscribeFailing = pool.subscribeEvents(failing);
			const unsubscribe = pool.subscribeEvents(listener);

			(pool as any).emitEvent(proc, { type: "agent_start" });
			expect(failing).toHaveBeenCalledOnce();
			expect(listener).toHaveBeenCalledOnce();

			unsubscribeFailing();
			unsubscribe();
			(pool as any).emitEvent(proc, { type: "agent_end" });
			expect(listener).toHaveBeenCalledOnce();
			consoleError.mockRestore();
		});
	});

	describe("sendRpcChecked", () => {
		it("throws on unsuccessful response", async () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);

			(proc.process.stdin as any).write = vi.fn((data: string) => {
				const cmd = JSON.parse(data);
				const pending = proc.pendingRequests.get(cmd.id);
				if (pending) {
					setTimeout(() => {
						pending.resolve({ id: cmd.id, type: "response", success: false, error: "model not found" });
					}, 0);
				}
			});

			await expect(pool.sendRpcChecked(proc, { type: "set_model" })).rejects.toThrow("model not found");
		});
	});

	describe("lease lifecycle and capacity", () => {
		it("returns null when at capacity for a new cwd", () => {
			const { pool, injectProc } = createPoolWithMocks({ maxProcesses: 2 });
			injectProc("/project-a", 1);
			injectProc("/project-b", 2);
			expect(pool.acquire("/project-c")).toBeNull();
		});

		it("releases idempotently", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);
			const lease = pool.acquire("/project-a")!;
			lease.release();
			lease.release();
			expect(pool.isLeased(proc)).toBe(false);
		});
	});

	describe("eviction and decommission", () => {
		it("evicts an idle process from another cwd", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const victim = injectProc("/project-a", 1);
			injectProc("/project-b", 2);
			const evicted = pool.evictIdleDifferentCwd("/project-b");
			expect(evicted).toBe(victim);
			expect(victim.process.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("does not evict a leased process", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const victim = injectProc("/project-a", 1);
			injectProc("/project-b", 2);
			const lease = pool.acquire("/project-a")!;
			expect(pool.evictIdleDifferentCwd("/project-b")).toBeNull();
			expect(victim.process.kill).not.toHaveBeenCalled();
			lease.release();
		});

		it("drains leased processes and kills them on release", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);
			const lease = pool.acquire("/project-a")!;
			expect(pool.decommissionAll()).toEqual({ killed: 0, draining: 1 });
			expect(proc.process.kill).not.toHaveBeenCalled();
			lease.release();
			expect(proc.process.kill).toHaveBeenCalledWith("SIGTERM");
			expect(pool.acquireAny()).toBeNull();
		});
	});

	describe("spawn validation", () => {
		it("throws when cwd does not exist", () => {
			const pool = new ProcessPool(makeSpawnConfig(), { maxProcesses: 4, prewarmCount: 0 });
			expect(() => pool.spawn("/nonexistent/path/that/does/not/exist")).toThrow(
				"Cannot spawn pi process: directory does not exist"
			);
		});
	});
});

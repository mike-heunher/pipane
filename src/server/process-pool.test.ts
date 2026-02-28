import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProcessPool, type RpcProcess, type SpawnConfig } from "./process-pool.js";

// We can't easily spawn real pi processes in tests, so we test the
// pool logic with a mock spawn config that will fail to spawn. For
// unit-testable logic (acquire selection, busySet filtering, caps),
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
			process: { exitCode: alive ? null : 1, stdin: { write: vi.fn() } } as any,
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
	describe("acquire with cwd grouping", () => {
		it("returns idle process for matching cwd", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);

			const busy = new Set<RpcProcess>();
			const result = pool.acquire("/project-a", busy);

			expect(result).toBe(proc);
		});

		it("does not return process from different cwd", () => {
			const { pool, injectProc } = createPoolWithMocks();
			injectProc("/project-a", 1);

			const busy = new Set<RpcProcess>();
			// Acquiring for /project-b should spawn a new one (or return null if at cap)
			// Since we're using a mock spawn config, it would try to spawn — but for
			// this test we set maxProcesses to 1 to force null
			const pool2 = new ProcessPool(makeSpawnConfig(), { maxProcesses: 1 });
			const poolsMap2 = (pool2 as any).pools as Map<string, RpcProcess[]>;
			poolsMap2.set("/project-a", [{
				id: 1,
				cwd: "/project-a",
				process: { exitCode: null } as any,
				rl: {} as any,
				pendingRequests: new Map(),
				requestId: 0,
				lastResponseTime: Date.now(),
			} as RpcProcess]);

			const result = pool2.acquire("/project-b", busy);
			// At max capacity, can't spawn for project-b
			expect(result).toBeNull();
		});

		it("skips busy processes", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc1 = injectProc("/project-a", 1);
			const proc2 = injectProc("/project-a", 2);

			const busy = new Set<RpcProcess>([proc1]);
			const result = pool.acquire("/project-a", busy);

			expect(result).toBe(proc2);
		});

		it("skips dead processes", () => {
			const { pool, injectProc } = createPoolWithMocks();
			injectProc("/project-a", 1, false); // dead
			const proc2 = injectProc("/project-a", 2, true);

			const busy = new Set<RpcProcess>();
			const result = pool.acquire("/project-a", busy);

			expect(result).toBe(proc2);
		});
	});

	describe("getAny", () => {
		it("returns any idle process across cwds", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc = injectProc("/project-a", 1);

			const busy = new Set<RpcProcess>();
			const result = pool.getAny(busy);

			expect(result).toBe(proc);
		});

		it("prefers idle over busy", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc1 = injectProc("/project-a", 1);
			const proc2 = injectProc("/project-b", 2);

			const busy = new Set<RpcProcess>([proc1]);
			const result = pool.getAny(busy);

			expect(result).toBe(proc2);
		});

		it("falls back to busy process if no idle", () => {
			const { pool, injectProc } = createPoolWithMocks();
			const proc1 = injectProc("/project-a", 1);

			const busy = new Set<RpcProcess>([proc1]);
			const result = pool.getAny(busy);

			expect(result).toBe(proc1);
		});

		it("returns null when no live processes exist", () => {
			const { pool } = createPoolWithMocks();
			const result = pool.getAny(new Set());
			expect(result).toBeNull();
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

	describe("maxProcesses cap", () => {
		it("returns null when at capacity for new cwd", () => {
			const { pool, injectProc } = createPoolWithMocks({ maxProcesses: 2 });
			injectProc("/project-a", 1);
			injectProc("/project-b", 2);

			const result = pool.acquire("/project-c", new Set());
			expect(result).toBeNull();
		});
	});
});

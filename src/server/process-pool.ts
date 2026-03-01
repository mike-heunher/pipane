/**
 * CWD-aware process pool for pi RPC processes.
 *
 * Processes are grouped by cwd. When acquiring a process for a session,
 * the caller provides the session's cwd and gets a process that was
 * spawned in that directory. This ensures bash/read/edit/write tools
 * operate in the correct project directory.
 *
 * Features:
 * - Lazy spawning per-cwd with configurable pre-warming
 * - Readiness check via get_state RPC (replaces setTimeout(500) hack)
 * - Dead process cleanup on exit
 * - Global process cap
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";

export interface RpcProcess {
	id: number;
	/** The cwd this process was spawned with */
	cwd: string;
	process: ChildProcess;
	rl: readline.Interface;
	pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>;
	requestId: number;
	/** Timestamp of last successful RPC response */
	lastResponseTime: number;
}

export interface PoolOptions {
	/** Max total processes across all cwds. Default: 6 */
	maxProcesses?: number;
	/** Number of processes to pre-warm for the default cwd. Default: 2 */
	prewarmCount?: number;
	/** RPC timeout in ms. Default: 30000 */
	rpcTimeout?: number;
}

export interface SpawnConfig {
	command: string;
	baseArgs: string[];
	extraArgs?: string[];
	env?: Record<string, string>;
}

export class ProcessPool {
	/** All live processes, keyed by cwd */
	private pools = new Map<string, RpcProcess[]>();
	private nextProcId = 0;
	private spawnConfig: SpawnConfig;
	private maxProcesses: number;
	private prewarmCount: number;
	private rpcTimeout: number;
	private onProcessExit?: (proc: RpcProcess) => void;

	constructor(
		spawnConfig: SpawnConfig,
		options?: PoolOptions & { onProcessExit?: (proc: RpcProcess) => void },
	) {
		this.spawnConfig = spawnConfig;
		this.maxProcesses = options?.maxProcesses ?? 6;
		this.prewarmCount = options?.prewarmCount ?? 2;
		this.rpcTimeout = options?.rpcTimeout ?? 30000;
		this.onProcessExit = options?.onProcessExit;
	}

	/** Get the total count of live processes across all cwds */
	get totalProcesses(): number {
		let count = 0;
		for (const procs of this.pools.values()) {
			count += procs.filter((p) => p.process.exitCode === null).length;
		}
		return count;
	}

	/** Get all processes (for debug endpoint) */
	getAllProcesses(): RpcProcess[] {
		const all: RpcProcess[] = [];
		for (const procs of this.pools.values()) {
			all.push(...procs);
		}
		return all;
	}

	/**
	 * Spawn a new RPC process for the given cwd.
	 * Does not wait for readiness — call waitForReady() separately.
	 */
	spawn(cwd: string): RpcProcess {
		const procId = ++this.nextProcId;
		console.log(`[pool] Spawning pi process #${procId} (cwd: ${cwd})...`);

		// Strip NODE_ENV from the child environment so tools spawned by pi
		// (e.g. bash) don't inherit pi-web's "production" setting.
		const { NODE_ENV: _, ...parentEnv } = process.env;

		const child = spawn(this.spawnConfig.command, [
			...this.spawnConfig.baseArgs,
			...(this.spawnConfig.extraArgs ?? []),
		], {
			cwd,
			env: { ...parentEnv, ...(this.spawnConfig.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});

		child.stderr?.on("data", (data: Buffer) => {
			process.stderr.write(`[pi#${procId}] ${data.toString()}`);
		});

		const rl = readline.createInterface({ input: child.stdout!, terminal: false });

		const proc: RpcProcess = {
			id: procId,
			cwd,
			process: child,
			rl,
			pendingRequests: new Map(),
			requestId: 0,
			lastResponseTime: Date.now(),
		};

		// Set up response handler
		rl.on("line", (line: string) => {
			let data: any;
			try {
				data = JSON.parse(line);
			} catch {
				return;
			}

			if (data.type === "response" && data.id && proc.pendingRequests.has(data.id)) {
				const pending = proc.pendingRequests.get(data.id)!;
				proc.pendingRequests.delete(data.id);
				proc.lastResponseTime = Date.now();
				pending.resolve(data);
			}
		});

		child.on("exit", (code) => {
			console.log(`[pool] pi#${proc.id} exited (code ${code})`);

			// Remove from pool
			const poolForCwd = this.pools.get(cwd);
			if (poolForCwd) {
				const idx = poolForCwd.indexOf(proc);
				if (idx !== -1) poolForCwd.splice(idx, 1);
				if (poolForCwd.length === 0) this.pools.delete(cwd);
			}

			// Reject any pending requests
			for (const [, pending] of proc.pendingRequests) {
				pending.reject(new Error(`pi process #${proc.id} exited unexpectedly (code ${code})`));
			}
			proc.pendingRequests.clear();

			// Notify caller
			this.onProcessExit?.(proc);
		});

		// Add to pool
		let poolForCwd = this.pools.get(cwd);
		if (!poolForCwd) {
			poolForCwd = [];
			this.pools.set(cwd, poolForCwd);
		}
		poolForCwd.push(proc);

		console.log(`[pool] pi#${procId} spawned (total: ${this.totalProcesses})`);
		return proc;
	}

	/**
	 * Wait for a process to be ready by sending a get_state RPC.
	 * Falls back to a timeout if the process doesn't respond.
	 */
	async waitForReady(proc: RpcProcess, timeoutMs = 5000): Promise<boolean> {
		try {
			await this.sendRpc(proc, { type: "get_state" }, timeoutMs);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get an idle process for the given cwd, or spawn one.
	 * An "idle" process is one that's alive and not in the busySet.
	 */
	acquire(cwd: string, busySet: Set<RpcProcess>): RpcProcess | null {
		const poolForCwd = this.pools.get(cwd);
		if (poolForCwd) {
			const idle = poolForCwd.find((p) => p.process.exitCode === null && !busySet.has(p));
			if (idle) return idle;
		}

		// Check global cap
		if (this.totalProcesses >= this.maxProcesses) {
			return null;
		}

		return this.spawn(cwd);
	}

	/**
	 * Get any live process (idle preferred). For model queries that don't
	 * need a specific cwd.
	 */
	getAny(busySet: Set<RpcProcess>): RpcProcess | null {
		// Prefer idle
		for (const procs of this.pools.values()) {
			const idle = procs.find((p) => p.process.exitCode === null && !busySet.has(p));
			if (idle) return idle;
		}
		// Fall back to any live process
		for (const procs of this.pools.values()) {
			const live = procs.find((p) => p.process.exitCode === null);
			if (live) return live;
		}
		return null;
	}

	/**
	 * Evict one idle process from a different cwd to free capacity.
	 * Returns the evicted process, or null if none can be evicted.
	 */
	evictIdleDifferentCwd(targetCwd: string, busySet: Set<RpcProcess>): RpcProcess | null {
		for (const [cwd, procs] of this.pools) {
			if (cwd === targetCwd) continue;

			const victim = procs.find((p) => p.process.exitCode === null && !busySet.has(p));
			if (!victim) continue;

			console.log(`[pool] Evicting idle pi#${victim.id} from cwd ${cwd} to make room for ${targetCwd}`);
			victim.process.kill("SIGTERM");
			return victim;
		}
		return null;
	}

	/**
	 * Pre-warm the pool with processes for the given cwd.
	 */
	/**
	 * Pre-warm the pool with processes for the given cwd.
	 * Spawns are staggered: each process must be ready (via get_state RPC)
	 * before the next one is spawned. This prevents lock contention on
	 * shared resources like auth.json during startup.
	 */
	async prewarm(cwd: string): Promise<void> {
		const existing = this.pools.get(cwd)?.filter((p) => p.process.exitCode === null).length ?? 0;
		const needed = Math.min(this.prewarmCount, this.maxProcesses) - existing;
		for (let i = 0; i < needed; i++) {
			if (this.totalProcesses >= this.maxProcesses) break;
			const proc = this.spawn(cwd);
			if (i < needed - 1) {
				// Wait for this process to be ready before spawning the next one
				await this.waitForReady(proc);
			}
		}
	}

	/**
	 * Send an RPC command to a process and wait for a response.
	 */
	sendRpc(proc: RpcProcess, command: any, timeoutMs?: number): Promise<any> {
		if (!proc.process || proc.process.exitCode !== null) {
			return Promise.reject(new Error("RPC process is dead"));
		}

		const timeout = timeoutMs ?? this.rpcTimeout;
		const id = `req_${++proc.requestId}`;
		const fullCommand = { ...command, id };

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				proc.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for RPC response to ${command.type}`));
			}, timeout);

			proc.pendingRequests.set(id, {
				resolve: (data: any) => {
					clearTimeout(timer);
					resolve(data);
				},
				reject: (err: Error) => {
					clearTimeout(timer);
					reject(err);
				},
			});

			proc.process.stdin!.write(JSON.stringify(fullCommand) + "\n");
		});
	}

	/**
	 * Send an RPC command and throw if it fails.
	 */
	async sendRpcChecked(proc: RpcProcess, command: any): Promise<any> {
		const response = await this.sendRpc(proc, command);
		if (!response?.success) {
			throw new Error(response?.error || `RPC command failed: ${command.type}`);
		}
		return response;
	}

}

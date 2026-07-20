/**
 * CWD-aware, leased process pool for pi RPC processes.
 *
 * The pool is the sole owner of process availability. Callers receive an
 * idempotent lease instead of passing a separate busy set, so a process is
 * reserved atomically before control returns to asynchronous application code.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { existsSync } from "node:fs";

export interface RpcProcess {
	id: number;
	cwd: string;
	process: ChildProcess;
	rl: readline.Interface;
	pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>;
	requestId: number;
	lastResponseTime: number;
	recentStderr: string[];
}

export interface PoolOptions {
	maxProcesses?: number;
	prewarmCount?: number;
	rpcTimeout?: number;
}

export interface SpawnConfig {
	command: string;
	baseArgs: string[] | (() => string[]);
	extraArgs?: string[];
	env?: Record<string, string>;
}

export type RpcProcessEvent = Record<string, any>;
export type RpcProcessEventListener = (proc: RpcProcess, event: RpcProcessEvent) => void;

/** Exclusive ownership of one pooled process. */
export class RpcProcessLease {
	readonly process: RpcProcess;
	private pool: ProcessPool;
	private _released = false;

	constructor(pool: ProcessPool, process: RpcProcess) {
		this.pool = pool;
		this.process = process;
	}

	get released(): boolean { return this._released; }

	release(): void {
		this.pool.releaseLease(this);
	}

	/** @internal */
	markReleased(): void {
		this._released = true;
	}
}

export class ProcessPool {
	private pools = new Map<string, RpcProcess[]>();
	private leases = new Map<RpcProcess, RpcProcessLease>();
	private decommissioning = new Set<RpcProcess>();
	private finalizedProcesses = new WeakSet<RpcProcess>();
	private nextProcId = 0;
	private spawnConfig: SpawnConfig;
	private maxProcesses: number;
	private prewarmCount: number;
	private rpcTimeout: number;
	private onProcessExit?: (proc: RpcProcess) => void;
	private eventListeners = new Set<RpcProcessEventListener>();

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

	get totalProcesses(): number {
		let count = 0;
		for (const procs of this.pools.values()) {
			count += procs.filter((proc) => proc.process.exitCode === null).length;
		}
		return count;
	}

	subscribeEvents(listener: RpcProcessEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	private emitEvent(proc: RpcProcess, event: RpcProcessEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(proc, event);
			} catch (err) {
				console.error(`[pool] pi#${proc.id} event listener failed:`, err);
			}
		}
	}

	getAllProcesses(): RpcProcess[] {
		const all: RpcProcess[] = [];
		for (const procs of this.pools.values()) all.push(...procs);
		return all;
	}

	isLeased(proc: RpcProcess): boolean {
		return this.leases.has(proc);
	}

	isDecommissioning(proc: RpcProcess): boolean {
		return this.decommissioning.has(proc);
	}

	getRecentStderr(proc: RpcProcess, maxLines = 12): string[] {
		if (!proc?.recentStderr?.length) return [];
		return proc.recentStderr.slice(Math.max(0, proc.recentStderr.length - maxLines));
	}

	spawn(cwd: string): RpcProcess {
		if (!existsSync(cwd)) {
			throw new Error(`Cannot spawn pi process: directory does not exist: ${cwd}`);
		}

		const procId = ++this.nextProcId;
		console.log(`[pool] Spawning pi process #${procId} (cwd: ${cwd})...`);
		const { NODE_ENV: _, ...parentEnv } = process.env;
		const baseArgs = typeof this.spawnConfig.baseArgs === "function"
			? this.spawnConfig.baseArgs()
			: this.spawnConfig.baseArgs;
		const child = spawn(this.spawnConfig.command, [
			...baseArgs,
			...(this.spawnConfig.extraArgs ?? []),
		], {
			cwd,
			env: { ...parentEnv, ...(this.spawnConfig.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const recentStderr: string[] = [];
		child.stderr?.on("data", (data: Buffer) => {
			const text = data.toString();
			process.stderr.write(`[pi#${procId}] ${text}`);
			for (const line of text.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				recentStderr.push(trimmed);
				if (recentStderr.length > 60) recentStderr.splice(0, recentStderr.length - 60);
			}
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
			recentStderr,
		};

		rl.on("line", (line: string) => {
			let data: any;
			try {
				data = JSON.parse(line);
			} catch {
				return;
			}
			if (data.type === "response") {
				if (data.id && proc.pendingRequests.has(data.id)) {
					const pending = proc.pendingRequests.get(data.id)!;
					proc.pendingRequests.delete(data.id);
					proc.lastResponseTime = Date.now();
					pending.resolve(data);
				}
				return;
			}
			this.emitEvent(proc, data);
		});

		child.on("error", (err) => {
			console.error(`[pool] pi#${proc.id} spawn error: ${err.message}`);
			this.finalizeProcess(proc, new Error(`pi process #${proc.id} failed to spawn: ${err.message}`));
		});
		child.on("exit", (code) => {
			console.log(`[pool] pi#${proc.id} exited (code ${code})`);
			this.finalizeProcess(proc, new Error(`pi process #${proc.id} exited unexpectedly (code ${code})`));
		});

		let poolForCwd = this.pools.get(cwd);
		if (!poolForCwd) {
			poolForCwd = [];
			this.pools.set(cwd, poolForCwd);
		}
		poolForCwd.push(proc);
		console.log(`[pool] pi#${procId} spawned (total: ${this.totalProcesses})`);
		return proc;
	}

	private finalizeProcess(proc: RpcProcess, error: Error): void {
		if (this.finalizedProcesses.has(proc)) return;
		this.finalizedProcesses.add(proc);

		const poolForCwd = this.pools.get(proc.cwd);
		if (poolForCwd) {
			const index = poolForCwd.indexOf(proc);
			if (index !== -1) poolForCwd.splice(index, 1);
			if (poolForCwd.length === 0) this.pools.delete(proc.cwd);
		}

		const lease = this.leases.get(proc);
		if (lease) lease.markReleased();
		this.leases.delete(proc);
		this.decommissioning.delete(proc);

		for (const pending of proc.pendingRequests.values()) pending.reject(error);
		proc.pendingRequests.clear();
		this.onProcessExit?.(proc);
	}

	async waitForReady(proc: RpcProcess, timeoutMs = 5000): Promise<boolean> {
		try {
			await this.sendRpc(proc, { type: "get_state" }, timeoutMs);
			return true;
		} catch {
			return false;
		}
	}

	/** Atomically reserve a matching process, spawning one when capacity allows. */
	acquire(cwd: string): RpcProcessLease | null {
		const poolForCwd = this.pools.get(cwd);
		const idle = poolForCwd?.find((proc) => this.isAvailable(proc));
		if (idle) return this.reserve(idle);
		if (this.totalProcesses >= this.maxProcesses) return null;
		return this.reserve(this.spawn(cwd));
	}

	/** Reserve any idle live process, regardless of cwd. */
	acquireAny(): RpcProcessLease | null {
		for (const procs of this.pools.values()) {
			const idle = procs.find((proc) => this.isAvailable(proc));
			if (idle) return this.reserve(idle);
		}
		return null;
	}

	private isAvailable(proc: RpcProcess): boolean {
		return proc.process.exitCode === null
			&& !this.leases.has(proc)
			&& !this.decommissioning.has(proc);
	}

	private reserve(proc: RpcProcess): RpcProcessLease {
		if (!this.isAvailable(proc)) throw new Error(`pi process #${proc.id} is not available`);
		const lease = new RpcProcessLease(this, proc);
		this.leases.set(proc, lease);
		return lease;
	}

	/** @internal Called only by RpcProcessLease.release(). */
	releaseLease(lease: RpcProcessLease): void {
		if (lease.released) return;
		const proc = lease.process;
		if (this.leases.get(proc) !== lease) {
			lease.markReleased();
			return;
		}
		this.leases.delete(proc);
		lease.markReleased();
		if (this.decommissioning.has(proc) && proc.process.exitCode === null && !proc.process.killed) {
			// Keep the marker until the exit event removes the process. Otherwise a
			// concurrent acquisition could lease the dying process before SIGTERM lands.
			console.log(`[pool] Decommissioning pi#${proc.id} after completed operation`);
			proc.process.kill("SIGTERM");
		}
	}

	private decommission(proc: RpcProcess): "ignored" | "draining" | "killed" {
		if (proc.process.exitCode !== null || this.decommissioning.has(proc)) return "ignored";
		this.decommissioning.add(proc);
		if (this.leases.has(proc)) return "draining";
		proc.process.kill("SIGTERM");
		return "killed";
	}

	/** Evict an idle process from a different cwd to free capacity. */
	evictIdleDifferentCwd(targetCwd: string): RpcProcess | null {
		for (const [cwd, procs] of this.pools) {
			if (cwd === targetCwd) continue;
			const victim = procs.find((proc) => this.isAvailable(proc));
			if (!victim) continue;
			console.log(`[pool] Evicting idle pi#${victim.id} from cwd ${cwd} to make room for ${targetCwd}`);
			this.decommission(victim);
			return victim;
		}
		return null;
	}

	/** Immediately kill one process while keeping it unavailable until exit. */
	forceKill(proc: RpcProcess): boolean {
		if (proc.process.exitCode !== null) return false;
		this.decommissioning.add(proc);
		return proc.process.kill("SIGKILL");
	}

	/** Kill idle processes now and mark leased processes for kill on release. */
	decommissionAll(): { killed: number; draining: number } {
		let killed = 0;
		let draining = 0;
		for (const proc of this.getAllProcesses()) {
			const result = this.decommission(proc);
			if (result === "killed") killed += 1;
			if (result === "draining") draining += 1;
		}
		return { killed, draining };
	}

	async prewarm(cwd: string): Promise<void> {
		const existing = this.pools.get(cwd)?.filter((proc) => proc.process.exitCode === null).length ?? 0;
		const needed = Math.min(this.prewarmCount, this.maxProcesses) - existing;
		for (let i = 0; i < needed; i++) {
			if (this.totalProcesses >= this.maxProcesses) break;
			const proc = this.spawn(cwd);
			if (i < needed - 1) await this.waitForReady(proc);
		}
	}

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
				// A timed-out RPC may still be executing. Never return that process to
				// the idle pool where a new session command could overlap with it.
				this.decommission(proc);
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

	async sendRpcChecked(proc: RpcProcess, command: any): Promise<any> {
		const response = await this.sendRpc(proc, command);
		if (!response?.success) {
			throw new Error(response?.error || `RPC command failed: ${command.type}`);
		}
		return response;
	}
}

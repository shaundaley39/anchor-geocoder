/**
 * Running the API on every core the process has been given.
 *
 * A geocode is pure CPU — no I/O to yield on — so one Node thread serves them
 * strictly one at a time and the service tops out at 1 / service time however
 * many cores the box has. Threads are the fix, and the reason they can be
 * threads rather than processes is that the index is 4.4 GB of read-only bytes:
 * loaded once into `SharedArrayBuffer`s, every worker is a view of the same
 * memory, and a sixteen-way pool costs what one replica used to.
 *
 * Two ways to put N threads behind one port, chosen by what the kernel allows:
 *
 *   reuseport   Each worker binds its own socket with SO_REUSEPORT and the
 *               kernel hashes connections across them. Linux, FreeBSD.
 *   shared-fd   The first worker binds; the rest accept on its descriptor,
 *               which they can because threads share a descriptor table. The
 *               classic pre-fork model, and what macOS gets, where SO_REUSEPORT
 *               exists but does not balance and Node rejects it outright.
 *
 * Either way a connection belongs to one worker for its lifetime, so a
 * keep-alive client is pinned to a thread and the balance across threads is the
 * balance across connections.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { loadBundle, artifactFromBundle, type Manifest } from './artifact.js';
import { coverageBBox } from './reverse.js';
import type { ListenPlan, WorkerInit, WorkerMessage } from './worker.js';

export interface PoolOptions {
  indexDir: string;
  /** 0 lets the kernel choose; the pool reports what it got. */
  port: number;
  host: string;
  /** Request threads to run. */
  workers: number;
  /** Overrides where the worker code is found; the tests run from source. */
  workerEntry?: URL;
}

export interface Pool {
  manifest: Manifest;
  /** The port actually bound, which differs from the request only for port 0. */
  port: number;
  workers: number;
  strategy: 'reuseport' | 'shared-fd';
  /** Milliseconds spent reading the index into shared memory. */
  loadMs: number;
  /** Milliseconds spent starting the threads, once the index was in memory. */
  spawnMs: number;
  stop(): Promise<void>;
}

/**
 * Threads worth running here.
 *
 * `availableParallelism` is the whole answer, including under a CPU quota:
 * libuv reads the cgroup, so `docker run --cpus=3` reports 3 on a 14-CPU host
 * rather than 14 threads timesharing 3 cores. Verified rather than assumed,
 * since the documented definition is the affinity mask.
 */
export function cpuBudget(): number {
  return Math.max(1, availableParallelism());
}

/**
 * Whether the kernel will share a port across independently bound sockets.
 * Probed on a throwaway socket, because the answer is a property of the
 * platform and getting it wrong is a boot failure on the real port.
 */
async function supportsReusePort(host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => { resolve(false); });
    probe.listen({ port: 0, host, reusePort: true }, () => {
      probe.close(() => { resolve(true); });
    });
  });
}

/**
 * The worker entry, which has to be JavaScript: a Worker thread gets a fresh
 * module loader, so the TypeScript hooks a `tsx` or `vitest` parent registered
 * are not there to read a `.ts` file.
 *
 * Deliberately only the sibling file, never a compiled copy found elsewhere:
 * running the main thread from source against workers from an older `dist` is
 * a mismatch that would be very hard to see. Under `tsx` there is no pool.
 */
export function workerEntry(): URL | null {
  const url = new URL('./worker.js', import.meta.url);
  return existsSync(url) ? url : null;
}

/** Whether a pool can be started at all: false when this module is the
 * TypeScript source and has no compiled worker beside it. */
export function canSpawnWorkers(): boolean {
  return workerEntry() !== null;
}

interface Spawned {
  worker: Worker;
  listening: Promise<{ fd: number | null; port: number | null }>;
}

function spawn(entry: URL, init: WorkerInit): Spawned {
  const worker = new Worker(entry, { workerData: init });
  const listening = new Promise<{ fd: number | null; port: number | null }>((resolve, reject) => {
    worker.once('message', (msg: WorkerMessage) => {
      if (msg.type === 'listening') resolve({ fd: msg.fd, port: msg.port });
      else reject(new Error(msg.message));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      reject(new Error(`worker exited with code ${String(code)} before listening`));
    });
  });
  return { worker, listening };
}

export async function startPool(o: PoolOptions): Promise<Pool> {
  const entry = o.workerEntry ?? workerEntry();
  if (entry === null) {
    throw new Error(
      'no compiled worker to run: build the server ' +
      '(`pnpm --filter @anchor-geocoder/server build`) or set WORKERS=1',
    );
  }

  const t0 = performance.now();
  const bundle = await loadBundle(o.indexDir);
  const loadMs = performance.now() - t0;

  // One scan of 90M points, here rather than in each worker: it is the only
  // part of a worker's boot that is not free, and every thread would compute
  // the same answer.
  const bbox = coverageBBox(artifactFromBundle(bundle));

  const t1 = performance.now();
  const reusePort = await supportsReusePort(o.host);
  const bind: ListenPlan = { kind: 'bind', port: o.port, host: o.host, reusePort };

  // The first worker binds the socket. Under reuseport that is all it is; under
  // shared-fd the others need its descriptor, so it has to be listening before
  // they start.
  const first = spawn(entry, { bundle, bbox, listen: bind });
  const { fd, port } = await first.listening;
  const bound = port ?? o.port;

  let plan: ListenPlan;
  if (reusePort) {
    plan = { ...bind, port: bound };
  } else if (fd !== null) {
    plan = { kind: 'adopt', fd };
  } else {
    await first.worker.terminate();
    throw new Error(
      'cannot share a port: this platform rejects SO_REUSEPORT and Node did not ' +
      'expose the listening descriptor to fall back on. Run with WORKERS=1.',
    );
  }

  const rest = Array.from(
    { length: o.workers - 1 },
    () => spawn(entry, { bundle, bbox, listen: plan }),
  );
  const workers = [first, ...rest];
  try {
    await Promise.all(rest.map((w) => w.listening));
  } catch (err) {
    await Promise.all(workers.map((w) => w.worker.terminate()));
    throw err;
  }
  const spawnMs = performance.now() - t1;

  // A thread that dies takes its share of capacity with it and cannot be
  // replaced without re-running the whole listen dance, so the process fails
  // instead and lets whatever supervises it start a healthy one.
  let stopping = false;
  for (const { worker } of workers) {
    worker.once('exit', (code) => {
      if (stopping) return;
      console.error(`worker thread exited with code ${String(code)}; shutting down`);
      process.exit(1);
    });
  }

  return {
    manifest: bundle.manifest,
    port: bound,
    workers: workers.length,
    strategy: reusePort ? 'reuseport' : 'shared-fd',
    loadMs,
    spawnMs,
    async stop() {
      stopping = true;
      // Terminated rather than drained: under shared-fd the listening socket
      // belongs to all of them at once, so there is no closing it in one thread
      // without pulling it out from under the rest.
      await Promise.all(workers.map((w) => w.worker.terminate()));
    },
  };
}

/** Entry point: load the artifact, attach the spatial indexes, serve. */
import { loadArtifact } from './artifact.js';
import { buildReverseIndex } from './reverse.js';
import { buildServer } from './server.js';
import { cpuBudget, canSpawnWorkers, startPool } from './pool.js';

const INDEX_DIR = process.env['INDEX_DIR'] ?? '../build/index';
const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '127.0.0.1';

/**
 * Request threads. Defaults to the cores the process may actually use, since a
 * geocode is CPU-bound and one thread leaves the rest of the machine idle.
 * WORKERS=1 keeps everything in this thread, with no pool at all.
 */
function workerCount(): number {
  const env = process.env['WORKERS'];
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`WORKERS must be a positive integer, got ${JSON.stringify(env)}`);
    }
    return n;
  }
  return cpuBudget();
}

/** `port` rather than PORT: with PORT=0 the kernel picked it, not the config. */
function endpoints(port: number): void {
  console.log(`  forward: http://${HOST}:${port}/v1/geocode?q=Marszalkowska+12`);
  console.log(`  reverse: http://${HOST}:${port}/v1/geocode?lat=52.2297&lon=21.0122`);
}

const rss = (): string => `${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`;

/** Everything in this thread: what the service was before it had a pool, and
 * still the shape of it under `WORKERS=1`. */
async function single(): Promise<void> {
  const t0 = performance.now();
  console.log(`loading index from ${INDEX_DIR} ...`);
  const artifact = await loadArtifact(INDEX_DIR);
  const t1 = performance.now();
  console.log(
    `  ${artifact.manifest.num_anchors.toLocaleString()} anchors, ` +
    `${artifact.manifest.num_addresses.toLocaleString()} addresses, ` +
    `${artifact.manifest.num_terms.toLocaleString()} terms ` +
    `(${(t1 - t0).toFixed(0)}ms)`,
  );

  // Precomputed in the artifact, so this only scans for the coverage box.
  // Building them here was ~5.4s of startup.
  const reverseIndex = buildReverseIndex(artifact);
  const t2 = performance.now();
  console.log(`  spatial indexes attached (${(t2 - t1).toFixed(0)}ms)`);

  const app = await buildServer({ artifact, reverseIndex });
  await app.listen({ port: PORT, host: HOST });

  console.log(
    `ready on http://${HOST}:${PORT} — 1 thread, ` +
    `boot ${(performance.now() - t0).toFixed(0)}ms, rss ${rss()}`,
  );
  endpoints(PORT);
}

/** The index in shared memory, one Fastify instance per core over it. */
async function pooled(workers: number): Promise<void> {
  const t0 = performance.now();
  console.log(`loading index from ${INDEX_DIR} ...`);
  const pool = await startPool({ indexDir: INDEX_DIR, port: PORT, host: HOST, workers });
  console.log(
    `  ${pool.manifest.num_anchors.toLocaleString()} anchors, ` +
    `${pool.manifest.num_addresses.toLocaleString()} addresses, ` +
    `${pool.manifest.num_terms.toLocaleString()} terms ` +
    `(${pool.loadMs.toFixed(0)}ms, shared across threads)`,
  );
  console.log(
    `  ${String(pool.workers)} request threads listening via ${pool.strategy} ` +
    `(${pool.spawnMs.toFixed(0)}ms)`,
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void pool.stop().then(() => { process.exit(0); });
    });
  }

  console.log(
    `ready on http://${HOST}:${String(pool.port)} — ${String(pool.workers)} threads, ` +
    `boot ${(performance.now() - t0).toFixed(0)}ms, rss ${rss()}`,
  );
  endpoints(pool.port);
}

async function main(): Promise<void> {
  let workers = workerCount();
  if (workers > 1 && !canSpawnWorkers()) {
    console.log(
      `WORKERS=${String(workers)} needs a compiled worker entry ` +
      '(`pnpm --filter @anchor-geocoder/server build`); serving on one thread.',
    );
    workers = 1;
  }
  await (workers > 1 ? pooled(workers) : single());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

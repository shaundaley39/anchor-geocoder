/** Entry point: load the artifact, attach the spatial indexes, serve. */
import { loadArtifact } from './artifact.js';
import { buildReverseIndex } from './reverse.js';
import { buildServer } from './server.js';

const INDEX_DIR = process.env['INDEX_DIR'] ?? '../build/index';
const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '127.0.0.1';

async function main(): Promise<void> {
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

  const rss = process.memoryUsage().rss / 1e6;
  console.log(
    `ready on http://${HOST}:${PORT} — boot ${(performance.now() - t0).toFixed(0)}ms, ` +
    `rss ${rss.toFixed(0)}MB`,
  );
  console.log(`  forward: http://${HOST}:${PORT}/v1/geocode?q=Marszalkowska+12`);
  console.log(`  reverse: http://${HOST}:${PORT}/v1/geocode?lat=52.2297&lon=21.0122`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

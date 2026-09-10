/**
 * The multi-threaded server: that the index really is shared, and that a thread
 * reading it through a view answers exactly what one thread reading it directly
 * does.
 *
 * The sharing is the part worth testing. Nothing in a request path knows it is
 * on a worker, so if the bytes are one copy and the views agree, the pool is
 * only Fastify on more event loops.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import {
  loadBundle, artifactFromBundle, loadArtifact, StringTable, toDeg, type ArtifactBundle,
} from '../src/artifact.js';
import { buildReverseIndex, coverage, coverageBBox } from '../src/reverse.js';
import { forward } from '../src/forward.js';
import { reverse } from '../src/reverse.js';
import { cpuBudget, canSpawnWorkers, workerEntry, startPool, type Pool } from '../src/pool.js';

const demo = fileURLToPath(new URL('../../demo/index', import.meta.url));

describe('the index is loaded once and shared', () => {
  let bundle: ArtifactBundle;
  beforeAll(async () => { bundle = await loadBundle(demo); }, 30_000);

  it('holds every file in memory a thread can share', () => {
    for (const [name, buf] of Object.entries(bundle.files)) {
      expect(buf, name).toBeInstanceOf(SharedArrayBuffer);
      expect(buf.byteLength, name).toBeGreaterThan(0);
    }
    expect(bundle.localityScore).toBeInstanceOf(SharedArrayBuffer);
  });

  /**
   * The whole economy of the pool: sixteen threads must not be sixteen copies
   * of a 4.4 GB artifact. Identity of the backing buffer is what proves it —
   * equal contents would also pass if every view were a copy.
   */
  it('gives two artifacts the same bytes rather than two copies', () => {
    const a = artifactFromBundle(bundle);
    const b = artifactFromBundle(bundle);
    expect(a).not.toBe(b);
    expect(a.post.buffer).toBe(b.post.buffer);
    expect(a.addrLat.buffer).toBe(b.addrLat.buffer);
    expect(a.localityScore.buffer).toBe(b.localityScore.buffer);
  });

  /**
   * Not a sample of the arrays but all of them: a field added later that ends
   * up on a private buffer would be copied into every thread, silently, and
   * only show up as a memory bill.
   */
  it('leaves no part of the artifact unshared', () => {
    const a = artifactFromBundle(bundle) as unknown as Record<string, unknown>;
    const priv: string[] = [];
    const check = (name: string, v: ArrayBufferView): void => {
      if (!(v.buffer instanceof SharedArrayBuffer)) priv.push(name);
    };
    for (const [k, v] of Object.entries(a)) {
      if (ArrayBuffer.isView(v)) check(k, v);
      else if (v instanceof StringTable) {
        const t = v as unknown as { blob: Uint8Array; offsets: Uint32Array };
        check(`${k}.blob`, t.blob);
        check(`${k}.offsets`, t.offsets);
      }
    }
    expect(priv).toEqual([]);
  });

  it('keeps the per-thread caches per thread', () => {
    const a = artifactFromBundle(bundle);
    const b = artifactFromBundle(bundle);
    // The decoded-string caches are the one piece of per-thread state left, and
    // they must be separate objects over the same immutable bytes.
    expect(a.strings).not.toBe(b.strings);
    expect(a.terms).not.toBe(b.terms);
    expect(forward(a, 'Vaduz', { limit: 5 }).results)
      .toEqual(forward(b, 'Vaduz', { limit: 5 }).results);
  });

  it('answers identically from either view', () => {
    const a = artifactFromBundle(bundle);
    const b = artifactFromBundle(bundle);
    const ra = buildReverseIndex(a);
    const rb = buildReverseIndex(b);
    for (const q of ['Vaduz', 'Städtle 17', 'Schaan', 'Landstrasse 1']) {
      expect(forward(b, q, { limit: 5 }).results, q)
        .toEqual(forward(a, q, { limit: 5 }).results);
    }
    expect(reverse(b, rb, 47.141, 9.5209, { limit: 3 }))
      .toEqual(reverse(a, ra, 47.141, 9.5209, { limit: 3 }));
  });

  it('derives the locality projection once, for every thread', () => {
    const a = artifactFromBundle(bundle);
    // Not all zero, or the ranking would have lost its locality prior on the
    // way into shared memory.
    expect(a.localityScore.some((v) => v > 0)).toBe(true);
  });
});

describe('coverage box', () => {
  it('is what the reverse index would have computed for itself', async () => {
    const a = await loadArtifact(demo);
    expect(buildReverseIndex(a).bbox).toEqual(coverageBBox(a));
  });

  it('is honoured when the pool passes it in', async () => {
    const a = await loadArtifact(demo);
    const given = { bbox: { minLat: 1, maxLat: 2, minLon: 3, maxLon: 4 }, byCountry: [] };
    expect(buildReverseIndex(a, given).bbox).toBe(given.bbox);
  });

  /**
   * The per-country boxes gate whether a filtered reverse search runs at all,
   * so one that is too small silently loses results. Checked against every
   * point the search could actually return.
   */
  it('bounds each country around everything that country holds', async () => {
    const a = await loadArtifact(demo);
    const { byCountry } = coverage(a);
    for (let id = 0; id < a.manifest.num_anchors; id++) {
      const box = byCountry[a.anchorCountry[id]!];
      expect(box).not.toBeNull();
      const within = (lat: number, lon: number) =>
        lat >= box!.minLat && lat <= box!.maxLat && lon >= box!.minLon && lon <= box!.maxLon;
      expect(within(toDeg(a.anchorMinLat[id]!), toDeg(a.anchorMinLon[id]!))).toBe(true);
      expect(within(toDeg(a.anchorMaxLat[id]!), toDeg(a.anchorMaxLon[id]!))).toBe(true);
      const from = a.anchorAddrStart[id]!;
      for (let i = from; i < from + a.anchorAddrCount[id]!; i++) {
        expect(within(toDeg(a.addrLat[i]!), toDeg(a.addrLon[i]!))).toBe(true);
      }
    }
  });
});

describe('cpuBudget', () => {
  it('is a positive integer and never more cores than exist', () => {
    const n = cpuBudget();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(availableParallelism());
  });
});

describe('worker entry', () => {
  /** Running from source, so the sibling is `src/worker.ts` and not loadable.
   * The server says so and drops to one thread rather than failing to boot. */
  it('is absent when running from the TypeScript sources', () => {
    expect(workerEntry()).toBeNull();
    expect(canSpawnWorkers()).toBe(false);
  });
});

/**
 * The real thing, over HTTP. The worker entry has to be named explicitly: these
 * tests run from source, where `pool.ts` refuses to go looking for a compiled
 * worker on its own, and a Worker thread cannot load a `.ts` file either way.
 * So it runs where there is a build, and skips where there is not.
 */
const compiledWorker = new URL('../dist/worker.js', import.meta.url);
const withPool = existsSync(compiledWorker) ? describe : describe.skip;

withPool('a running pool', () => {
  let pool: Pool;
  let base: string;
  beforeAll(async () => {
    // Workers inherit the environment, and three Fastify loggers at info level
    // bury the test output in request lines.
    process.env['LOG_LEVEL'] = 'silent';
    pool = await startPool({
      indexDir: demo, port: 0, host: '127.0.0.1', workers: 3,
      workerEntry: compiledWorker,
    });
    base = `http://127.0.0.1:${String(pool.port)}`;
  }, 60_000);
  afterAll(async () => { await pool?.stop(); });

  it('puts every requested thread behind one port', () => {
    expect(pool.workers).toBe(3);
    expect(pool.port).toBeGreaterThan(0);
  });

  it('answers the same as a single-threaded server would', async () => {
    const direct = await loadArtifact(demo);
    for (const q of ['Vaduz', 'Staedtle 17', 'Schaan']) {
      // Enough requests to land on every thread, whichever one each connection
      // happened to be accepted by.
      const bodies = await Promise.all(Array.from({ length: 24 }, async () => {
        const r = await fetch(`${base}/v1/geocode?q=${encodeURIComponent(q)}&limit=3`);
        expect(r.status).toBe(200);
        return r.json() as Promise<{ features: { properties: { name: string } }[] }>;
      }));
      const expected = forward(direct, q, { limit: 3 }).results.map((x) => x.name);
      for (const body of bodies) {
        expect(body.features.map((f) => f.properties.name), q).toEqual(expected);
      }
    }
  }, 60_000);

  it('serves the same index from every thread', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const h = await fetch(`${base}/health`).then((r) => r.json() as Promise<{ built_at: string }>);
      seen.add(h.built_at);
    }
    expect([...seen]).toHaveLength(1);
  }, 30_000);
});

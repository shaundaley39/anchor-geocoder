/**
 * The committed demo index must stay loadable.
 *
 * It is a build artifact in source control, which only works if something
 * notices when the format moves past it. Without this, a version bump ships an
 * index the server refuses to read and `make demo` — the first thing anyone
 * runs — fails.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadArtifact, SUPPORTED_VERSION, type Artifact } from '../src/artifact.js';
import { forward } from '../src/forward.js';
import { buildReverseIndex, reverse, type ReverseIndex } from '../src/reverse.js';

const dir = fileURLToPath(new URL('../../demo/index', import.meta.url));

describe('the committed demo index', () => {
  let a: Artifact;
  let rev: ReverseIndex;
  beforeAll(async () => {
    a = await loadArtifact(dir);
    rev = buildReverseIndex(a);
  }, 30_000);

  it('is the format version this server reads', () => {
    expect(a.manifest.version).toBe(SUPPORTED_VERSION);
  });

  it('holds Liechtenstein', () => {
    expect(a.manifest.countries).toEqual(['li']);
    expect(a.manifest.num_addresses).toBeGreaterThan(10_000);
  });

  it('answers a forward query', () => {
    const r = forward(a, 'Vaduz', { limit: 1 }).results[0];
    expect(r?.name).toBe('Vaduz');
    expect(r?.lat).toBeCloseTo(47.14, 1);
    expect(r?.lon).toBeCloseTo(9.52, 1);
  });

  it('answers a reverse query', () => {
    const rs = reverse(a, rev, 47.1410, 9.5209, { limit: 3 });
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0]!.distance).toBeLessThan(2000);
  });
});

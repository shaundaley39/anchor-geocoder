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

  /**
   * Liechtenstein is the German-speaking corner of the catalogue, so the
   * committed index is also where the umlaut spellings are checked end to end:
   * the digraph terms exist only if the build inserted them.
   *
   * Spelling correction is off, or a one-edit fix would mask a retrieval miss.
   */
  describe('finds a German name however it was spelled', () => {
    const top = (q: string) => forward(a, q, { limit: 1, fuzzy: false }).results[0]?.name;

    it('accepts the umlaut, the digraph and the bare vowel', () => {
      for (const q of ['Städtle', 'Staedtle', 'Stadtle']) {
        expect(top(q), q).toBe('Städtle');
      }
      for (const q of ['Mühleholz', 'Muehleholz', 'Muhleholz']) {
        expect(top(q), q).toBe('Mühleholz');
      }
    });

    it('reaches a name the data itself spells with a digraph', () => {
      // Both spellings are mapped in Liechtenstein, so either query is right;
      // what matters is that neither comes back empty.
      for (const q of ['Äulestrasse', 'Aeulestrasse', 'Aulestrasse']) {
        expect(top(q), q).toMatch(/^(Äulestrasse|Aeulestrasse)$/);
      }
    });

    it('accepts either spelling of ß', () => {
      expect(top('Landstrasse')).toBe('Landstrasse');
      expect(top('Landstraße')).toBe('Landstrasse');
    });

    it('still resolves a house number on a widened name', () => {
      const r = forward(a, 'Staedtle 17', { limit: 1, fuzzy: false }).results[0];
      expect(r?.name).toBe('Städtle');
      expect(r?.houseNumber).toBe('17');
    });
  });
});

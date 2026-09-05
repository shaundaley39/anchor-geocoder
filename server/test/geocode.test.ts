/**
 * End-to-end tests against the real built artifact.
 *
 * These are integration tests on purpose: the things most likely to break in a
 * geocoder are the joins between stages — folding vs index terms, anchor keys
 * vs address binding, sort order vs binary search — and none of those are
 * visible to a unit test with a hand-made fixture.
 *
 * They skip rather than fail when the artifact is absent, so `pnpm test` works
 * on a fresh clone before `make all` has run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadArtifact, type Artifact, toDeg } from '../src/artifact.js';
import { forward, parseQuery, findHouseNumber, haversineMetres } from '../src/forward.js';
import { buildReverseIndex, reverse, type ReverseIndex } from '../src/reverse.js';
import { buildServer } from '../src/server.js';
import { placeName } from '../src/geojson.js';
import type { FastifyInstance } from 'fastify';

const INDEX_DIR = fileURLToPath(new URL('../../build/index', import.meta.url));
const haveIndex = existsSync(`${INDEX_DIR}/manifest.json`);
const maybe = haveIndex ? describe : describe.skip;

describe('parseQuery', () => {
  it('splits a trailing house number off the street name', () => {
    expect(parseQuery('Marszalkowska 12')).toEqual({
      nameTokens: ['marszalkowska'], houseNumber: '12',
    });
  });

  it('recombines a Czech conscription/orientation pair', () => {
    expect(parseQuery('Prazska 248/39')).toEqual({
      nameTokens: ['prazska'], houseNumber: '248/39',
    });
  });

  it('does not treat a leading number as a house number', () => {
    // "3 Maja" (Third of May) is a very common Polish street name.
    const p = parseQuery('3 Maja');
    expect(p.houseNumber).toBeNull();
    expect(p.nameTokens).toEqual(['3', 'maja']);
  });

  it('keeps a bare number as a name token, having nothing to anchor it to', () => {
    expect(parseQuery('299')).toEqual({ nameTokens: ['299'], houseNumber: null });
  });

  it('returns nothing for an empty query', () => {
    expect(parseQuery('   ')).toEqual({ nameTokens: [], houseNumber: null });
  });
});

describe('placeName rendering', () => {
  it('omits a locality identical to the feature name', () => {
    expect(placeName({
      id: 'x', layer: 'address', name: 'Velká Úpa', locality: 'Velká Úpa',
      houseNumber: '299', country: 'cz', lat: 0, lon: 0, score: 1,
    })).toBe('Velká Úpa 299, CZ');
  });

  it('includes a distinct locality', () => {
    expect(placeName({
      id: 'x', layer: 'address', name: 'Pražská', locality: 'Písek',
      houseNumber: '248', country: 'cz', lat: 0, lon: 0, score: 1,
    })).toBe('Pražská 248, Písek, CZ');
  });
});

maybe('against the built index', () => {
  let a: Artifact;
  let rev: ReverseIndex;
  let app: FastifyInstance;

  beforeAll(async () => {
    a = await loadArtifact(INDEX_DIR);
    rev = buildReverseIndex(a);
    app = buildServer({ artifact: a, reverseIndex: rev });
  }, 120_000);

  describe('artifact integrity', () => {
    it('has consistent anchor address ranges', () => {
      // Every anchor's run must lie inside the address arrays, and the runs
      // must not overlap — the binary search in findHouseNumber depends on it.
      const n = a.manifest.num_addresses;
      let checked = 0;
      for (let id = 0; id < a.manifest.num_anchors; id += 97) {
        const start = a.anchorAddrStart[id]!;
        const count = a.anchorAddrCount[id]!;
        expect(start + count).toBeLessThanOrEqual(n);
        for (let i = start; i < start + count; i++) {
          expect(a.addrAnchor[i]).toBe(id);
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(1000);
    });

    it('keeps each address run sorted by house number', () => {
      for (let id = 0; id < a.manifest.num_anchors; id += 397) {
        const start = a.anchorAddrStart[id]!;
        const count = a.anchorAddrCount[id]!;
        for (let i = start + 1; i < start + count; i++) {
          expect(a.addrSortKey[i]!).toBeGreaterThanOrEqual(a.addrSortKey[i - 1]!);
        }
      }
    });

    it('stores terms in sorted order so prefix search is a binary search', () => {
      for (let i = 1; i < a.manifest.num_terms; i += 31) {
        expect(a.terms.get(i) > a.terms.get(i - 1)).toBe(true);
      }
    });
  });

  describe('forward geocoding', () => {
    const top = (q: string, opts = {}) => forward(a, q, { limit: 5, ...opts })[0];

    it('finds a major city by exact name', () => {
      expect(top('Praha')?.name).toBe('Praha');
      expect(top('Warszawa')?.name).toBe('Warszawa');
      expect(top('Brno')?.name).toBe('Brno');
    });

    it('is diacritic-insensitive in both directions', () => {
      expect(top('Lodz')?.name).toBe('Łódź');
      expect(top('Łódź')?.name).toBe('Łódź');
      expect(top('Plzen')?.name).toBe('Plzeň');
      expect(top('Gdansk')?.name).toBe('Gdańsk');
    });

    it('supports prefix autocomplete on the final token', () => {
      expect(top('Warsz')?.name).toBe('Warszawa');
      expect(top('Krak')?.name).toBe('Kraków');
    });

    it('resolves a street address to an address point', () => {
      const r = top('Marszalkowska 12');
      expect(r?.layer).toBe('address');
      expect(r?.houseNumber).toBe('12');
    });

    it('resolves a Czech composed house number', () => {
      const r = top('Prazska 248/39');
      expect(r?.layer).toBe('address');
      // Either the exact composed form or the numeric match is acceptable;
      // both refer to conscription number 248.
      expect(r?.houseNumber?.startsWith('248')).toBe(true);
    });

    it('resolves a place-anchored village address with no street', () => {
      const r = top('Velka Upa 299');
      expect(r?.layer).toBe('address');
      expect(r?.houseNumber).toBe('299');
      expect(r?.name).toBe('Velká Úpa');
    });

    it('honours the country filter', () => {
      const pl = forward(a, 'Nowa Wies', { limit: 5, country: 'pl' });
      expect(pl.length).toBeGreaterThan(0);
      expect(pl.every((r) => r.country === 'pl')).toBe(true);
    });

    it('biases toward the proximity point', () => {
      // Nádražní is one of the commonest Czech street names (575 of them).
      const nearBrno = forward(a, 'Nadrazni', {
        limit: 3, proximity: { lat: 49.1951, lon: 16.6068 },
      })[0]!;
      const d = haversineMetres(49.1951, 16.6068, nearBrno.lat, nearBrno.lon);
      expect(d).toBeLessThan(30_000);
    });

    it('returns nothing rather than nonsense for gibberish', () => {
      expect(forward(a, 'zzzqqqxxvv', { limit: 5 })).toEqual([]);
    });

    it('never returns more than the requested limit', () => {
      expect(forward(a, 'Praha', { limit: 3 }).length).toBeLessThanOrEqual(3);
    });

    it('returns results in non-increasing score order', () => {
      const rs = forward(a, 'Nowa', { limit: 10 });
      for (let i = 1; i < rs.length; i++) {
        expect(rs[i]!.score).toBeLessThanOrEqual(rs[i - 1]!.score);
      }
    });
  });

  describe('findHouseNumber', () => {
    it('finds every number actually present in a run', () => {
      // Pick a well-populated anchor and confirm each of its numbers resolves.
      let anchorID = -1;
      for (let id = 0; id < a.manifest.num_anchors; id++) {
        if (a.anchorAddrCount[id]! > 40) { anchorID = id; break; }
      }
      expect(anchorID).toBeGreaterThanOrEqual(0);
      const start = a.anchorAddrStart[anchorID]!;
      const count = a.anchorAddrCount[anchorID]!;
      for (let i = start; i < start + count; i++) {
        const num = a.strings.get(a.addrNum[i]!);
        const found = findHouseNumber(a, anchorID, num);
        expect(found).not.toBeNull();
        // The match must carry the same leading integer.
        expect(a.addrSortKey[found!]).toBe(a.addrSortKey[i]);
      }
    });

    it('returns null for a number the street does not have', () => {
      let anchorID = -1;
      for (let id = 0; id < a.manifest.num_anchors; id++) {
        if (a.anchorAddrCount[id]! > 5) { anchorID = id; break; }
      }
      expect(findHouseNumber(a, anchorID, '999999')).toBeNull();
    });
  });

  describe('reverse geocoding', () => {
    it('returns the containing address for a known point', () => {
      // A point taken from the index itself must resolve to (almost) itself.
      const i = 5_000_000;
      const lat = toDeg(a.addrLat[i]!);
      const lon = toDeg(a.addrLon[i]!);
      const rs = reverse(a, rev, lat, lon, { limit: 1 });
      expect(rs.length).toBe(1);
      expect(rs[0]!.distance).toBeLessThan(1);
    });

    it('orders results by increasing distance', () => {
      const rs = reverse(a, rev, 50.0813, 14.4262, { limit: 10 });
      expect(rs.length).toBeGreaterThan(1);
      for (let i = 1; i < rs.length; i++) {
        expect(rs[i]!.distance!).toBeGreaterThanOrEqual(rs[i - 1]!.distance!);
      }
    });

    it('agrees with brute force on the nearest point', () => {
      // Brute-forcing 11.6M points is slow but this is the only way to know the
      // k-d tree and the box-widening logic are actually correct.
      const qLat = 50.0813, qLon = 14.4262;
      let bestI = -1, bestD = Infinity;
      const n = a.manifest.num_addresses;
      for (let i = 0; i < n; i++) {
        const dLat = toDeg(a.addrLat[i]!) - qLat;
        const dLon = (toDeg(a.addrLon[i]!) - qLon) * 0.64;
        const d = dLat * dLat + dLon * dLon;
        if (d < bestD) { bestD = d; bestI = i; }
      }
      const exact = haversineMetres(qLat, qLon, toDeg(a.addrLat[bestI]!), toDeg(a.addrLon[bestI]!));
      const got = reverse(a, rev, qLat, qLon, { limit: 1 })[0]!;
      expect(got.distance!).toBeCloseTo(exact, 0);
    }, 60_000);

    it('respects the radius cap', () => {
      const rs = reverse(a, rev, 50.0813, 14.4262, { limit: 10, radius: 50 });
      expect(rs.every((r) => r.distance! <= 50)).toBe(true);
    });

    it('returns an empty list rather than throwing outside coverage', () => {
      // Mid-Atlantic.
      expect(reverse(a, rev, 30, -40, { limit: 5 })).toEqual([]);
    });
  });

  describe('HTTP endpoint', () => {
    const get = (url: string) => app.inject({ method: 'GET', url });

    it('serves forward geocoding as GeoJSON', async () => {
      const res = await get('/v1/geocode?q=Praha&limit=2');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.type).toBe('FeatureCollection');
      expect(body.features.length).toBeGreaterThan(0);
      const f = body.features[0];
      expect(f.geometry.type).toBe('Point');
      expect(f.geometry.coordinates).toHaveLength(2);
      // GeoJSON is [lon, lat] — the classic way to ship a broken map.
      expect(f.geometry.coordinates[0]).toBeCloseTo(14.42, 1);
      expect(f.geometry.coordinates[1]).toBeCloseTo(50.08, 1);
    });

    it('serves reverse geocoding from the same endpoint', async () => {
      const res = await get('/v1/geocode?lat=50.0813&lon=14.4262&limit=2');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.query.type).toBe('reverse');
      expect(body.features[0].properties.distance_m).toBeLessThan(100);
    });

    it('rejects a request with neither q nor lat/lon', async () => {
      const res = await get('/v1/geocode');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_request');
    });

    it('rejects q combined with lat/lon', async () => {
      expect((await get('/v1/geocode?q=Praha&lat=50&lon=14')).statusCode).toBe(400);
    });

    it('rejects out-of-range coordinates', async () => {
      expect((await get('/v1/geocode?lat=999&lon=0')).statusCode).toBe(400);
      expect((await get('/v1/geocode?lat=0&lon=999')).statusCode).toBe(400);
    });

    it('rejects a country outside the index', async () => {
      const res = await get('/v1/geocode?q=Praha&country=de');
      expect(res.statusCode).toBe(400);
      expect(res.json().hint).toContain('cz');
    });

    it('reports health', async () => {
      const body = (await get('/health')).json();
      expect(body.status).toBe('ok');
      expect(body.addresses).toBeGreaterThan(1_000_000);
    });
  });
});

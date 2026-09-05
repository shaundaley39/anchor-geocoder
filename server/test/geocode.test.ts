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
import { loadArtifact, anchorOfAddress, type Artifact, toDeg } from '../src/artifact.js';
import { forward, parseQuery, findHouseNumber, haversineMetres } from '../src/forward.js';
import { buildReverseIndex, reverse, type ReverseIndex } from '../src/reverse.js';
import { buildServer } from '../src/server.js';
import { placeName } from '../src/geojson.js';
import type { FastifyInstance } from 'fastify';

const INDEX_DIR = fileURLToPath(new URL('../../build/index', import.meta.url));
const haveIndex = existsSync(`${INDEX_DIR}/manifest.json`);
const maybe = haveIndex ? describe : describe.skip;

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the window is exhausted', async () => {
    if (!haveIndex) return;
    const a = await loadArtifact(INDEX_DIR);
    // A tiny index slice is enough; the limiter runs before the handler.
    const rev = buildReverseIndex(a);
    const app = await buildServer({
      artifact: a, reverseIndex: rev,
      options: { rateLimitMax: 2, rateLimitWindow: '1 minute', logger: false },
    });
    const get = () => app.inject({ method: 'GET', url: '/v1/geocode?q=Praha' });

    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);

    const blocked = await get();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.json().error).toBe('rate_limited');

    // Health checks must never be throttled, or the container runtime starts
    // reporting the service unhealthy under exactly the load it should survive.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  }, 120_000);
});

describe('parseQuery', () => {
  // parseQuery returns candidate readings, best guess first; forward() takes
  // the first that finds anything.
  const first = (q: string) => parseQuery(q)[0]!;

  it('splits a trailing house number off the street name', () => {
    expect(first('Marszalkowska 12')).toEqual({
      nameTokens: ['marszalkowska'], houseNumber: '12',
    });
  });

  it('recombines a Czech conscription/orientation pair', () => {
    expect(first('Prazska 248/39')).toEqual({
      nameTokens: ['prazska'], houseNumber: '248/39',
    });
  });

  /**
   * Much of the region writes the number between the street and the city, so a
   * trailing-only rule fails "Via Roma 1 Torino" and "Damrak 1 Amsterdam"
   * outright — no results at all, rather than a worse ordering.
   */
  it('extracts a medial house number', () => {
    expect(first('Via Roma 1 Torino')).toEqual({
      nameTokens: ['via', 'roma', 'torino'], houseNumber: '1',
    });
    expect(first('Damrak 1 Amsterdam')).toEqual({
      nameTokens: ['damrak', 'amsterdam'], houseNumber: '1',
    });
  });

  it('does not treat a leading number as a house number', () => {
    // "3 Maja" (Third of May) is a very common Polish street name, and
    // "17 Novembre" and friends are the same idea elsewhere in the region.
    const p = first('3 Maja');
    expect(p.houseNumber).toBeNull();
    expect(p.nameTokens).toEqual(['3', 'maja']);
    expect(first('3 Maja Warszawa').houseNumber).toBeNull();
  });

  it('always offers the whole query as a fallback reading', () => {
    const readings = parseQuery('Via Roma 1 Torino');
    expect(readings.length).toBe(2);
    expect(readings[1]).toEqual({
      nameTokens: ['via', 'roma', '1', 'torino'], houseNumber: null,
    });
  });

  it('keeps a bare number as a name token, having nothing to anchor it to', () => {
    expect(first('299')).toEqual({ nameTokens: ['299'], houseNumber: null });
  });

  it('returns nothing for an empty query', () => {
    expect(first('   ')).toEqual({ nameTokens: [], houseNumber: null });
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
    // Rate limiting off and logging silenced: the suite fires far more than
    // 120 requests a minute, and per-request logs drown the test output.
    app = await buildServer({
      artifact: a, reverseIndex: rev,
      options: { rateLimitMax: 0, logger: false },
    });
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
        // The owning anchor is derived, not stored; verify the derivation
        // agrees with the range it came from.
        for (let i = start; i < start + count; i++) {
          expect(anchorOfAddress(a, i)).toBe(id);
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

    /**
     * Regression: an exact name match must beat a longer term that merely
     * shares its prefix.
     *
     * IDF alone ranks a rare term far above a common one, so "praha" (3,665
     * postings) lost to "prahatice" (1 posting, a real OSM name variant) and
     * the top hit for "Praha" was Prachatice. The bug was invisible on the
     * cz+pl index and only appeared on a cz-only build, so this asserts the
     * invariant rather than one index's happened-to-work ordering.
     */
    it('ranks an exact name above a longer prefix sibling', () => {
      for (const city of ['Praha', 'Plzen', 'Brno', 'Ostrava', 'Liberec', 'Olomouc']) {
        const got = top(city)?.name ?? '';
        const asciiFolded = got.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
        expect(asciiFolded, `query "${city}" returned "${got}"`).toBe(city.toLowerCase());
      }
    });

    /**
     * A place has more names than one. OSM records exonyms under name:<lang>,
     * plus alt_name / short_name / official_name / old_name, and for POIs the
     * brand and operator.
     *
     * Regression: these were indexed as terms all along, but ranking scored
     * only the canonical name — so "prague" looked like it had matched nothing
     * but incidental context, and a POI called "Prague College" outranked the
     * capital. Ranking now scores every name variant and keeps the best.
     */
    it('resolves exonyms to the native-language place', () => {
      expect(top('Prague')?.name).toBe('Praha');
      expect(top('Warsaw')?.name).toBe('Warszawa');
      expect(top('Pilsen')?.name).toBe('Plzeň');
      expect(top('Breslau')?.name).toBe('Wrocław');
      expect(top('Danzig')?.name).toBe('Gdańsk');
    });

    it('ranks the city above POIs that merely mention the exonym', () => {
      // 338 anchors carry the term "prague"; almost all are POIs with it in
      // their name, and one of them is literally "Prague College".
      const r = forward(a, 'Prague', { limit: 3 })[0]!;
      expect(r.layer).toBe('place');
      expect(r.name).toBe('Praha');
    });

    it('matches an exonym on a feature that is not a settlement', () => {
      const r = top('Wenceslas Square');
      expect(r?.name).toBe('Václavské náměstí');
    });

    it('finds a POI by brand or operator, not just its own name', () => {
      expect(top('Zabka', { proximity: { lat: 52.2297, lon: 21.0122 } })?.layer).toBe('poi');
      const post = top('Ceska posta', { proximity: { lat: 50.0755, lon: 14.4378 } });
      expect(post?.category).toBe('amenity=post_office');
    });

    it('does not let a long alias list dilute a short exact match', () => {
      // Kraków carries 26 alternate names. Scoring the union of them as one
      // long name would make it rank worse the better it is documented.
      expect(top('Krakow')?.name).toBe('Kraków');
      expect(top('Krakau')?.name).toBe('Kraków');
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

    it('finds points of interest by name', () => {
      expect(top('Prazsky hrad')?.layer).toBe('poi');
      expect(top('Karluv most')?.name).toBe('Karlův most');
      const station = top('Brno hlavni nadrazi');
      expect(station?.layer).toBe('poi');
      expect(station?.category).toBe('railway=station');
    });

    /**
     * A POI carries its street and city as searchable tokens, so a query naming
     * a street must not be answered by a POI that merely stands on it. A
     * station called "Lednice" at Nádražní 1 once outranked all 651 streets
     * named Nádražní, because relevance was measured against name *length*
     * rather than whether the name matched.
     */
    it('ranks a street above a POI that merely sits on it', () => {
      const r = forward(a, 'Nadrazni', {
        limit: 3, proximity: { lat: 49.1951, lon: 16.6068 },
      })[0]!;
      expect(r.layer).toBe('street');
      expect(r.name).toBe('Nádražní');
      expect(haversineMetres(49.1951, 16.6068, r.lat, r.lon)).toBeLessThan(5_000);
    });

    /**
     * The coarse pass ranks on the importance prior alone, which spans 1.0 for
     * a street to 7.0 for an airport. A single overall cut therefore deletes
     * the lowest-prior layer wholesale, so the cut is per layer.
     */
    it('never lets one layer crowd another out of the candidate set', () => {
      const layers = new Set(forward(a, 'Nadrazni', { limit: 20 }).map((r) => r.layer));
      expect(layers.has('street')).toBe(true);
    });

    it('collapses duplicate mappings of one place', () => {
      // Karlův most is mapped as an attraction more than once along its length.
      const rs = forward(a, 'Karluv most', { limit: 5 })
        .filter((r) => r.layer === 'poi' && r.name === 'Karlův most');
      expect(rs.length).toBe(1);
    });

    it('keeps genuinely distinct branches of a chain', () => {
      const rs = forward(a, 'Biedronka', { limit: 5 }).filter((r) => r.layer === 'poi');
      expect(rs.length).toBeGreaterThan(1);
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
        expect(found!.exact).toBe(true);
        // The match must carry the same leading integer.
        expect(a.addrSortKey[found!.index]).toBe(a.addrSortKey[i]);
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
      // Derived from the manifest rather than hardcoded: the covered set grows.
      const covered = new Set(Object.keys(a.manifest.country_ids));
      const absent = ['fr', 'es', 'pt', 'se', 'no'].find((c) => !covered.has(c));
      expect(absent).toBeDefined();
      const res = await get(`/v1/geocode?q=Praha&country=${absent}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_request');
    });

    it('accepts every country the index actually covers', async () => {
      for (const cc of Object.keys(a.manifest.country_ids)) {
        expect((await get(`/v1/geocode?q=a&country=${cc}`)).statusCode).toBe(200);
      }
    });

    /**
     * The forward response returns `center` as GeoJSON [lon, lat] while the
     * reverse parameters are named lat/lon, so reading one into the other
     * transposes them. For Czechia and Poland that lands off Somalia and
     * returns nothing, with no indication why.
     */
    it('flags transposed coordinates instead of silently returning nothing', async () => {
      const res = await get('/v1/geocode?lat=16.6148&lon=49.2012');
      expect(res.statusCode).toBe(200); // outside coverage is not an error
      const body = res.json();
      expect(body.features).toEqual([]);
      expect(body.query.hint).toMatch(/transposed/);
    });

    it('does not second-guess a genuine query from outside coverage', async () => {
      // Mid-Atlantic: neither orientation is inside the indexed area.
      const body = (await get('/v1/geocode?lat=30&lon=-40')).json();
      expect(body.features).toEqual([]);
      expect(body.query.hint).toBeUndefined();
    });

    it('does not flag a valid in-coverage query that simply found nothing', async () => {
      // Inside the bbox but in open water off the Polish coast, tight radius.
      const body = (await get('/v1/geocode?lat=54.8&lon=18.4&radius=100')).json();
      expect(body.query.hint).toBeUndefined();
    });

    it('sets CORS headers so a browser autocomplete can call it', async () => {
      const res = await app.inject({
        method: 'OPTIONS', url: '/v1/geocode?q=Praha',
        headers: { origin: 'https://example.com', 'access-control-request-method': 'GET' },
      });
      // With origin:true the plugin reflects the caller's origin rather than
      // emitting a literal '*', which is what a browser needs.
      expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
    });

    it('advertises a coverage bbox that contains the indexed data', async () => {
      const b = (await get('/health')).json().bbox;
      expect(b.minLat).toBeLessThan(b.maxLat);
      expect(b.minLon).toBeLessThan(b.maxLon);
      // Somewhere in Europe, not the whole globe.
      expect(b.minLat).toBeGreaterThan(30);
      expect(b.maxLat).toBeLessThan(60);
      expect(b.minLon).toBeGreaterThan(0);
      expect(b.maxLon).toBeLessThan(30);
      // And it must actually contain a place the index returns.
      const praha = forward(a, 'Praha', { limit: 1 })[0]!;
      expect(praha.lat).toBeGreaterThanOrEqual(b.minLat);
      expect(praha.lat).toBeLessThanOrEqual(b.maxLat);
      expect(praha.lon).toBeGreaterThanOrEqual(b.minLon);
      expect(praha.lon).toBeLessThanOrEqual(b.maxLon);
    });

    it('reports health', async () => {
      const body = (await get('/health')).json();
      expect(body.status).toBe('ok');
      expect(body.addresses).toBeGreaterThan(1_000_000);
    });
  });
});

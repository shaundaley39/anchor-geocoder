/**
 * End-to-end tests against the real artifact.
 *
 * Integration on purpose: what breaks in a geocoder is the joins between stages
 * — folding versus index terms, anchor keys versus address binding, sort order
 * versus binary search — and none of that is visible to a hand-made fixture.
 * They skip when the artifact is absent, so a fresh clone can run them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadArtifact, anchorOfAddress, type Artifact, toDeg } from '../src/artifact.js';
import { forward } from '../src/forward.js';
import { parseQuery } from '../src/query.js';
import { candidates } from '../src/terms.js';
import { scoreBound, scoreExact } from '../src/ranking.js';
import { findHouseNumber } from '../src/housenumber.js';
import { correctToken, withinOneEdit } from '../src/fuzzy.js';
import { hasShape, ringAreaM2, containsPoint, haversineMetres } from '../src/geometry.js';
import { buildReverseIndex, reverse, type ReverseIndex } from '../src/reverse.js';
import { buildServer } from '../src/server.js';
import { placeName } from '../src/geojson.js';
import type { FastifyInstance } from 'fastify';

// Overridable so CI can point at an index built somewhere else, and so a
// smaller corpus can be checked without disturbing the local one.
const INDEX_DIR = process.env['INDEX_DIR']
  ?? fileURLToPath(new URL('../../build/index', import.meta.url));
const haveIndex = existsSync(`${INDEX_DIR}/manifest.json`);
const maybe = haveIndex ? describe : describe.skip;

/**
 * Which countries the index contains. Most tests are structural, but some name
 * real places and can only run where that country was built — CI builds Czechia
 * alone. A test that silently requires one dataset is testing the dataset.
 */
const covered: Record<string, number> = haveIndex
  ? (JSON.parse(readFileSync(`${INDEX_DIR}/manifest.json`, 'utf8')) as
      { country_ids: Record<string, number> }).country_ids
  : {};

/** `needs('cz','pl')('...', fn)` runs only where both were built. */
const needs = (...cc: string[]) =>
  (cc.every((c) => c in covered) ? it : it.skip);

describe('rate limiting', () => {
  needs('cz')('returns 429 with Retry-After once the window is exhausted', async () => {
    if (!haveIndex) return;
    const a = await loadArtifact(INDEX_DIR);

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

    // Never throttled, or the runtime kills the service under load.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  }, 120_000);
});

describe('parseQuery', () => {
  // Candidate readings, best guess first.
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
   * Much of the region writes the number between street and city, so a
   * trailing-only rule fails those outright — no results, not a worse ordering.
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
    // "3 Maja" is a common Polish street name; "17 Novembre" is the same idea.
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
    const top = (q: string, opts = {}) => forward(a, q, { limit: 5, ...opts }).results[0];
    const forwardTop = (q: string, opts = {}) => forward(a, q, opts).results;

    needs('cz', 'pl')('finds a major city by exact name', () => {
      expect(top('Praha')?.name).toBe('Praha');
      expect(top('Warszawa')?.name).toBe('Warszawa');
      expect(top('Brno')?.name).toBe('Brno');
    });

    needs('cz', 'pl')('is diacritic-insensitive in both directions', () => {
      expect(top('Lodz')?.name).toBe('Łódź');
      expect(top('Łódź')?.name).toBe('Łódź');
      expect(top('Plzen')?.name).toBe('Plzeň');
      expect(top('Gdansk')?.name).toBe('Gdańsk');
    });

    /**
     * Regression: an exact name must beat a longer term sharing its prefix.
     * IDF alone put "prahatice" (1 posting, a real OSM variant) above "praha"
     * (3,665), so Prachatice was the top hit for Praha. Invisible on cz+pl and
     * only visible on a cz-only build, so this asserts the invariant.
     */
    needs('cz')('ranks an exact name above a longer prefix sibling', () => {
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
    needs('cz', 'pl')('resolves exonyms to the native-language place', () => {
      expect(top('Prague')?.name).toBe('Praha');
      expect(top('Warsaw')?.name).toBe('Warszawa');
      expect(top('Pilsen')?.name).toBe('Plzeň');
      expect(top('Breslau')?.name).toBe('Wrocław');
      expect(top('Danzig')?.name).toBe('Gdańsk');
    });

    needs('cz')('ranks the city above POIs that merely mention the exonym', () => {
      // 338 anchors carry the term "prague"; almost all are POIs with it in
      // their name, and one of them is literally "Prague College".
      const r = forward(a, 'Prague', { limit: 3 }).results[0]!;
      expect(r.layer).toBe('place');
      expect(r.name).toBe('Praha');
    });

    /**
     * Asserted by location, not by name. Prague's Wenceslas Square is mapped
     * twice — once as "Václavské náměstí" carrying the English alias, once
     * canonically in English — so which name comes back is a tie-break between
     * two records for the same square, not the property under test.
     */
    needs('cz')('matches an exonym on a feature that is not a settlement', () => {
      const r = top('Wenceslas Square');
      expect(r).toBeDefined();
      expect(r!.lat).toBeCloseTo(50.081, 1);
      expect(r!.lon).toBeCloseTo(14.428, 1);
    });

    needs('cz', 'pl')('finds a POI by brand or operator, not just its own name', () => {
      expect(top('Zabka', { proximity: { lat: 52.2297, lon: 21.0122 } })?.layer).toBe('poi');
      const post = top('Ceska posta', { proximity: { lat: 50.0755, lon: 14.4378 } });
      expect(post?.category).toBe('amenity=post_office');
    });

    needs('cz', 'pl')('does not let a long alias list dilute a short exact match', () => {
      // Kraków carries 26 alternate names. Scoring the union of them as one
      // long name would make it rank worse the better it is documented.
      expect(top('Krakow')?.name).toBe('Kraków');
      expect(top('Krakau')?.name).toBe('Kraków');
    });

    /**
     * An alias is weaker evidence than the name a feature goes by. A Polish
     * lake carries "Warsz" as an alt_name, so an exact hit on that outranked a
     * prefix hit on Warszawa by 0.14% until aliases were discounted — while
     * exonyms, which are also aliases, still have to work.
     */
    needs('cz', 'pl')('prefers the canonical name to an alias, but still ranks exonyms', () => {
      expect(top('Warsz')?.name).toBe('Warszawa');
      // Praha matches "Prague" only through an alias, and must still win.
      expect(top('Prague')?.name).toBe('Praha');
    });

    needs('cz', 'pl')('supports prefix autocomplete on the final token', () => {
      expect(top('Warsz')?.name).toBe('Warszawa');
      expect(top('Krak')?.name).toBe('Kraków');
    });

    needs('cz', 'pl')('resolves a street address to an address point', () => {
      const r = top('Marszalkowska 12');
      expect(r?.layer).toBe('address');
      expect(r?.houseNumber).toBe('12');
    });

    needs('cz')('resolves a Czech composed house number', () => {
      const r = top('Prazska 248/39');
      expect(r?.layer).toBe('address');
      // Either the exact composed form or the numeric match is acceptable;
      // both refer to conscription number 248.
      expect(r?.houseNumber?.startsWith('248')).toBe(true);
    });

    needs('cz')('resolves a place-anchored village address with no street', () => {
      const r = top('Velka Upa 299');
      expect(r?.layer).toBe('address');
      expect(r?.houseNumber).toBe('299');
      expect(r?.name).toBe('Velká Úpa');
    });

    needs('cz', 'pl')('honours the country filter', () => {
      const pl = forward(a, 'Nowa Wies', { limit: 5, country: 'pl' }).results;
      expect(pl.length).toBeGreaterThan(0);
      expect(pl.every((r) => r.country === 'pl')).toBe(true);
    });

    needs('cz')('biases toward the proximity point', () => {
      // One of the commonest Czech street names: 575 of them.
      const nearBrno = forwardTop('Nadrazni', {
        limit: 3, proximity: { lat: 49.1951, lon: 16.6068 },
      })[0]!;
      const d = haversineMetres(49.1951, 16.6068, nearBrno.lat, nearBrno.lon);
      expect(d).toBeLessThan(30_000);
    });

    needs('cz')('finds points of interest by name', () => {
      expect(top('Prazsky hrad')?.layer).toBe('poi');
      expect(top('Karluv most')?.name).toBe('Karlův most');
      const station = top('Brno hlavni nadrazi');
      expect(station?.layer).toBe('poi');
      expect(station?.category).toBe('railway=station');
    });

    /**
     * A POI carries its street as a token, so a street query must not be
     * answered by a POI standing on it. A station called "Lednice" at Nádražní 1
     * once outranked all 651 streets of that name.
     */
    needs('cz')('ranks a street above a POI that merely sits on it', () => {
      const r = forwardTop('Nadrazni', {
        limit: 3, proximity: { lat: 49.1951, lon: 16.6068 },
      })[0]!;
      expect(r.layer).toBe('street');
      expect(r.name).toBe('Nádražní');
      expect(haversineMetres(49.1951, 16.6068, r.lat, r.lon)).toBeLessThan(5_000);
    });

    /** The coarse cut is per layer, or the lowest-prior layer is deleted whole. */
    needs('cz')('never lets one layer crowd another out of the candidate set', () => {
      const layers = new Set(forward(a, 'Nadrazni', { limit: 20 }).results.map((r) => r.layer));
      expect(layers.has('street')).toBe(true);
    });

    needs('cz')('collapses duplicate mappings of one place', () => {
      // Karlův most is mapped as an attraction more than once along its length.
      const rs = forward(a, 'Karluv most', { limit: 5 }).results
        .filter((r) => r.layer === 'poi' && r.name === 'Karlův most');
      expect(rs.length).toBe(1);
    });

    needs('cz', 'pl')('keeps genuinely distinct branches of a chain', () => {
      const rs = forward(a, 'Biedronka', { limit: 5 }).results.filter((r) => r.layer === 'poi');
      expect(rs.length).toBeGreaterThan(1);
    });

    it('returns nothing rather than nonsense for gibberish', () => {
      expect(forward(a, 'zzzqqqxxvv', { limit: 5 }).results).toEqual([]);
    });

    it('never returns more than the requested limit', () => {
      expect(forward(a, 'Praha', { limit: 3 }).results.length).toBeLessThanOrEqual(3);
    });

    it('returns results in non-increasing score order', () => {
      const rs = forward(a, 'Nowa', { limit: 10 }).results;
      for (let i = 1; i < rs.length; i++) {
        expect(rs[i]!.score).toBeLessThanOrEqual(rs[i - 1]!.score);
      }
    });
  });

  /**
   * The cheap pass cannot compute relevance or resolve a house number, so it
   * scores an upper bound instead and visits candidates in bound order,
   * stopping once the retained set beats the next bound. That is only sound if
   * the bound is never exceeded — so assert it, rather than trusting the
   * arithmetic.
   */
  describe('the score bound is admissible', () => {
    const QUERIES = [
      'Praha', 'Warszawa', 'Nadrazni', 'Nowa Wies', 'Marszalkowska 12',
      'Prazska 248/39', 'Velka Upa 299', 'Zurich', 'Prague', 'Sarajevo',
      'Bahnhofstrasse 1', 'War', 'Pra', 'Bern', 'Matterhorn',
      'Praha Praha', 'Praha Praha Praha', 'Baden Baden',
    ];

    it('is never exceeded by the exact score, for any candidate', () => {
      let checked = 0;
      for (const q of QUERIES) {
        for (const parsed of parseQuery(q)) {
          if (parsed.nameTokens.length === 0) continue;
          const cands = candidates(a, parsed.nameTokens, 10_000);
          for (const [id, text] of cands) {
            const bound = scoreBound(a, id, text, parsed.houseNumber !== null, parsed.nameTokens.length);
            const exact = scoreExact(a, id, text, parsed);
            // Tolerance for floating-point association only.
            expect(exact, `${q} / anchor ${id}`).toBeLessThanOrEqual(bound * (1 + 1e-9));
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(10_000);
    }, 120_000);

    it('holds when proximity is applied, which scales both sides', () => {
      const opts = { proximity: { lat: 50.0755, lon: 14.4378 } };
      for (const parsed of parseQuery('Nadrazni')) {
        if (parsed.nameTokens.length === 0) continue;
        for (const [id, text] of candidates(a, parsed.nameTokens, 10_000)) {
          const bound = scoreBound(a, id, text, parsed.houseNumber !== null, parsed.nameTokens.length, opts);
          const exact = scoreExact(a, id, text, parsed, opts);
          expect(exact).toBeLessThanOrEqual(bound * (1 + 1e-9));
        }
      }
    }, 60_000);

    /**
     * A repeated query token used to match the same name token once per
     * repetition, so relevance climbed instead of falling: "Praha", "Praha
     * Praha" and "Praha Praha Praha" scored 200, 577 and 1881, and the last two
     * returned junk. Matching as multisets makes each extra repeat pure noise,
     * which is what it is — and the bound depends on it, since a name cannot be
     * used more than once over.
     */
    it('treats a repeated token as noise rather than reinforcement', () => {
      let prev = Infinity;
      for (const q of ['Praha', 'Praha Praha', 'Praha Praha Praha']) {
        const top = forward(a, q, { limit: 1 }).results[0]!;
        expect(top.name, q).toBe('Praha');
        expect(top.score, q).toBeLessThan(prev);
        prev = top.score;
      }
    });

    /**
     * The point of the bound is that pruning cannot lose a winner, so the
     * result must not depend on how deep the scan went.
     */
    it('gives the same top result as an exhaustive scan', () => {
      for (const q of QUERIES) {
        const top = forward(a, q, { limit: 1 }).results[0];
        if (!top) continue;

        let bestId = -1, bestScore = -Infinity;
        for (const parsed of parseQuery(q)) {
          if (parsed.nameTokens.length === 0) continue;
          for (const [id, text] of candidates(a, parsed.nameTokens, 10_000)) {
            const sc = scoreExact(a, id, text, parsed);
            if (sc > bestScore) { bestScore = sc; bestId = id; }
          }
          if (bestId >= 0) break; // forward takes the first reading that matches
        }
        expect(top.score, `${q}: pruning changed the winner`)
          .toBeCloseTo(bestScore, 4);
      }
    }, 120_000);

    it('prunes rather than scanning everything', () => {
      const s = forward(a, 'Praha', { limit: 5 }).stats;
      expect(s.candidates).toBeGreaterThan(100);
      expect(s.reranked).toBeLessThan(s.candidates);
      expect(s.cappedByLimit).toBe(false);
    });
  });

  describe('spelling correction on the zero-result path', () => {
    /**
     * The pigeonhole property the whole approach rests on: a term at edit
     * distance 1 must share either the query's first half as a prefix or its
     * second half as a suffix, so a prefix search on the forward and reversed
     * dictionaries between them find every one. Checked against a brute-force
     * scan of all 496,534 terms, which is the only way to know nothing is
     * missed rather than merely that the easy cases work.
     */
    it('finds the same corrections as a full scan of the dictionary', () => {
      const TYPOS = ['prahha', 'warszwa', 'nadrzni', 'krakoww', 'zurick', 'sarajevoo'];
      for (const typo of TYPOS) {
        let bestBrute = '';
        let bestPostings = -1;
        for (let id = 0; id < a.terms.length; id++) {
          const term = a.terms.get(id);
          if (Math.abs(term.length - typo.length) > 1) continue;
          if (!withinOneEdit(typo, term)) continue;
          const n = a.postOff[id + 1]! - a.postOff[id]!;
          if (n > bestPostings) { bestPostings = n; bestBrute = term; }
        }
        expect(correctToken(a, typo), typo).toBe(bestPostings < 0 ? null : bestBrute);
      }
    }, 120_000);

    it('measures edit distance correctly at the boundary', () => {
      for (const [q, t, want] of [
        ['praha', 'praha', true],   // identical
        ['praha', 'praga', true],   // substitution
        ['praha', 'prha', true],    // deletion
        ['praha', 'prahha', true],  // insertion
        ['praha', 'prgaa', false],  // two substitutions
        ['praha', 'prhaa', false],  // transposition is Levenshtein 2
        ['praha', 'pra', false],    // length gap of 2
        ['praha', 'ahrap', false],
      ] as [string, string, boolean][]) {
        expect(withinOneEdit(q, t), `${q} ~ ${t}`).toBe(want);
      }
    });

    needs('cz')('recovers the intended place from a typo', () => {
      const out = forward(a, 'Prahha', { limit: 1 });
      expect(out.results[0]?.name).toBe('Praha');
      expect(out.corrected).toBe('praha');
    });

    needs('cz')('keeps the house number through a correction', () => {
      const out = forward(a, 'Marszalkowsa 12', { limit: 1 });
      expect(out.results[0]?.layer).toBe('address');
      expect(out.corrected).toBe('marszalkowska 12');
    });

    /**
     * The rule that keeps this from doing harm: correction runs only after an
     * exact search found nothing, so a correctly spelled query can never be
     * quietly rewritten into a more popular one.
     */
    it('never rewrites a query that matched as typed', () => {
      for (const q of ['Praha', 'Brno', 'Nadrazni', 'Pra', 'Marszalkowska 12']) {
        const out = forward(a, q, { limit: 3 });
        expect(out.results.length, q).toBeGreaterThan(0);
        expect(out.corrected, q).toBeNull();
      }
    });

    it('leaves short tokens alone, where a correction would be a guess', () => {
      // Four characters have hundreds of neighbours at distance 1.
      expect(correctToken(a, 'brna')).toBeNull();
      expect(correctToken(a, 'prg')).toBeNull();
    });

    it('gives up quickly on a query that is not a typo of anything', () => {
      const t = performance.now();
      const out = forward(a, 'Xyzzyplugh Qwghlm', { limit: 5 });
      expect(out.results).toEqual([]);
      expect(out.corrected).toBeNull();
      expect(performance.now() - t).toBeLessThan(50);
    });

    it('can be switched off', () => {
      const out = forward(a, 'Prahha', { limit: 1, fuzzy: false });
      expect(out.results).toEqual([]);
      expect(out.corrected).toBeNull();
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
      // Derived from the corpus size rather than hardcoded, or it overruns a
      // smaller build.
      const i = Math.floor(a.manifest.num_addresses / 2);
      const lat = toDeg(a.addrLat[i]!);
      const lon = toDeg(a.addrLon[i]!);
      const rs = reverse(a, rev, lat, lon, { limit: 1 });
      expect(rs.length).toBe(1);
      expect(rs[0]!.distance).toBeLessThan(1);
    });

    needs('cz')('orders the proximity tier by increasing distance', () => {
      const rs = reverse(a, rev, 50.0813, 14.4262, { limit: 10 })
        .filter((r) => !r.containing);
      expect(rs.length).toBeGreaterThan(1);
      for (let i = 1; i < rs.length; i++) {
        expect(rs[i]!.distance!).toBeGreaterThanOrEqual(rs[i - 1]!.distance!);
      }
    });

    /**
     * Query points derived from whatever index is built, so these hold for any
     * COUNTRIES setting. Pinned to Munich and Berlin, they broke the moment the
     * default build shrank.
     */
    const someRing = (minAreaM2: number) => {
      for (let id = 0; id < a.manifest.num_anchors; id += 7) {
        if (!hasShape(a, id) || a.geomClosed[id] !== 1) continue;
        if (ringAreaM2(a, id) < minAreaM2) continue;
        // The centroid of a concave ring is not guaranteed to be inside it.
        const start = a.geomOff[id]!;
        const n = a.geomOff[id + 1]! - start;
        let sLat = 0, sLon = 0;
        for (let i = 0; i < n; i++) {
          sLat += a.geom[2 * (start + i)]!;
          sLon += a.geom[2 * (start + i) + 1]!;
        }
        const lat = toDeg(sLat / n);
        const lon = toDeg(sLon / n);
        if (containsPoint(a, id, lat, lon)) return { id, lat, lon };
      }
      return null;
    };

    /**
     * The two-tier contract. Before shapes existed, reverse indexed only address
     * points, so a click inside a park returned the nearest doorway.
     */
    it('puts a containing region above nearby points', () => {
      const spot = someRing(10_000); // at least a hectare
      expect(spot).not.toBeNull();
      const rs = reverse(a, rev, spot!.lat, spot!.lon, { limit: 5 });
      expect(rs[0]!.containing).toBe(true);
      expect(rs[0]!.distance).toBe(0);
    });

    it('orders containing regions smallest first, and all before the rest', () => {
      // A property over real query points, not one hand-picked nesting.
      let checkedWithContainment = 0;
      for (let k = 0; k < 400; k++) {
        const i = (k * 137_777) % a.manifest.num_addresses;
        const rs = reverse(a, rev, toDeg(a.addrLat[i]!), toDeg(a.addrLon[i]!), { limit: 8 });
        const inside = rs.filter((r) => r.containing);
        if (inside.length > 0) checkedWithContainment++;
        for (let j = 1; j < inside.length; j++) {
          expect(inside[j]!.areaM2!).toBeGreaterThanOrEqual(inside[j - 1]!.areaM2!);
        }
        const firstOutside = rs.findIndex((r) => !r.containing);
        if (firstOutside >= 0) {
          expect(rs.slice(firstOutside).every((r) => !r.containing)).toBe(true);
        }
      }
      expect(checkedWithContainment).toBeGreaterThan(0);
    }, 60_000);

    it('caps the containing tier so nearby points are never crowded out', () => {
      const rs = reverse(a, rev, 48.2082, 16.3738, { limit: 8 });
      expect(rs.filter((r) => r.containing).length).toBeLessThanOrEqual(3);
    });

    it('returns anchors, not just addresses', () => {
      // The first version indexed only addresses, so a click could never
      // resolve to a park or a station.
      const layers = new Set<string>();
      for (let k = 0; k < 200 && layers.size < 2; k++) {
        const i = (k * 911_111) % a.manifest.num_addresses;
        for (const r of reverse(a, rev, toDeg(a.addrLat[i]!), toDeg(a.addrLon[i]!), { limit: 12 })) {
          layers.add(r.layer);
        }
      }
      expect(layers.size).toBeGreaterThan(1);
      expect(layers.has('address')).toBe(true);
    });

    it('measures a street to its shape, not to its representative point', () => {
      // Query beside a vertex far from the anchor's point: distance must
      // reflect the shape, not the centroid.
      for (let id = 0; id < a.manifest.num_anchors; id += 13) {
        if (!hasShape(a, id) || a.geomClosed[id] === 1) continue;
        const start = a.geomOff[id]!;
        const n = a.geomOff[id + 1]! - start;
        if (n < 3) continue;
        const vLat = toDeg(a.geom[2 * (start + n - 1)]!);
        const vLon = toDeg(a.geom[2 * (start + n - 1) + 1]!);
        const fromCentroid = haversineMetres(
          vLat, vLon, toDeg(a.anchorLat[id]!), toDeg(a.anchorLon[id]!),
        );
        if (fromCentroid < 300) continue; // need a vertex well away from the centre
        const rs = reverse(a, rev, vLat, vLon, { limit: 30 });
        const self = rs.find((r) => r.id === `anchor:${id}`);
        if (!self) continue;
        expect(self.distance!).toBeLessThan(fromCentroid / 2);
        return;
      }
    }, 30_000);

    /**
     * Slow, but the only way to know the k-d tree and box widening are correct.
     * Compared against the nearest *address*, since a containing region
     * legitimately outranks it at distance zero.
     */
    needs('cz')('agrees with brute force on the nearest address', () => {
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
      const nearestAddress = reverse(a, rev, qLat, qLon, { limit: 20 })
        .find((r) => r.layer === 'address');
      expect(nearestAddress).toBeDefined();
      expect(nearestAddress!.distance!).toBeCloseTo(exact, 0);
    }, 120_000);

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

    /**
     * An area mapped as a way has an extent; a settlement does not, because OSM
     * maps a city as a node and its boundary as a relation. Present where the
     * data supports it, absent otherwise, never faked from a radius.
     */
    it('carries a bbox on results that have extent, for the UI to zoom to', async () => {
      // A feature the index holds a ring for, rather than a named one: which
      // parks exist depends on which countries were built.
      let named = '';
      for (let id = 0; id < a.manifest.num_anchors && !named; id += 3) {
        if (!hasShape(a, id) || a.geomClosed[id] !== 1) continue;
        if (ringAreaM2(a, id) < 50_000) continue;
        const n = a.strings.get(a.anchorName[id]!);
        if (n.length > 4 && !/\d/.test(n)) named = n;
      }
      expect(named).not.toBe('');
      const body = (await get(`/v1/geocode?q=${encodeURIComponent(named)}&limit=5`)).json();
      const f = body.features.find((x: { bbox?: unknown }) => x.bbox);
      expect(f, `no result with a bbox for ${named}`).toBeDefined();
      const [minLon, minLat, maxLon, maxLat] = f.bbox as [number, number, number, number];
      expect(minLon).toBeLessThan(maxLon);
      expect(minLat).toBeLessThan(maxLat);
      // The point must lie inside its own box.
      expect(f.center[0]).toBeGreaterThanOrEqual(minLon);
      expect(f.center[0]).toBeLessThanOrEqual(maxLon);
      expect(f.center[1]).toBeGreaterThanOrEqual(minLat);
      expect(f.center[1]).toBeLessThanOrEqual(maxLat);
    });

    needs('cz')('omits bbox rather than faking one for a feature with no extent', async () => {
      // Berlin is a place=city *node* in OSM; the boundary is a relation.
      const f = (await get('/v1/geocode?q=Berlin&limit=1')).json().features[0];
      expect(f.bbox).toBeUndefined();
    });

    needs('cz')('serves forward geocoding as GeoJSON', async () => {
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

    needs('cz')('serves reverse geocoding from the same endpoint', async () => {
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
      // The catalogue is Europe-only, so a non-European code is absent from any
      // build of it. Naming European countries here broke the moment the index
      // grew to all 41.
      const covered = new Set(Object.keys(a.manifest.country_ids));
      const absent = ['jp', 'br', 'au', 'za'].find((c) => !covered.has(c));
      expect(absent, 'no absent country to test with').toBeDefined();
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
     * `center` is [lon, lat] while the parameters are lat/lon, so reading one
     * into the other lands this region off Somalia with no indication why.
     */
    needs('cz')('flags transposed coordinates instead of silently returning nothing', async () => {
      const res = await get('/v1/geocode?lat=16.6148&lon=49.2012');
      expect(res.statusCode).toBe(200); // outside coverage is not an error
      const body = res.json();
      expect(body.features).toEqual([]);
      expect(body.query.hint).toMatch(/transposed/);
    });

    needs('cz')('does not second-guess a genuine query from outside coverage', async () => {
      // Mid-Atlantic: neither orientation is inside the indexed area.
      const body = (await get('/v1/geocode?lat=30&lon=-40')).json();
      expect(body.features).toEqual([]);
      expect(body.query.hint).toBeUndefined();
    });

    needs('cz')('does not flag a valid in-coverage query that simply found nothing', async () => {
      // Inside the bbox but in open water off the Polish coast, tight radius.
      const body = (await get('/v1/geocode?lat=54.8&lon=18.4&radius=100')).json();
      expect(body.query.hint).toBeUndefined();
    });

    needs('cz')('sets CORS headers so a browser autocomplete can call it', async () => {
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
      // Tight around the data rather than the whole globe, checked against the
      // artifact's own extent. Hardcoding European bounds broke when the index
      // grew to include Iceland and northern Norway.
      let loLat = 90, hiLat = -90, loLon = 180, hiLon = -180;
      for (let k = 0; k < 5_000; k++) {
        const i = (k * 104_729) % a.manifest.num_addresses;
        const lat = toDeg(a.addrLat[i]!), lon = toDeg(a.addrLon[i]!);
        loLat = Math.min(loLat, lat); hiLat = Math.max(hiLat, lat);
        loLon = Math.min(loLon, lon); hiLon = Math.max(hiLon, lon);
      }
      expect(b.minLat).toBeLessThanOrEqual(loLat);
      expect(b.maxLat).toBeGreaterThanOrEqual(hiLat);
      expect(b.minLon).toBeLessThanOrEqual(loLon);
      expect(b.maxLon).toBeGreaterThanOrEqual(hiLon);
      // Not the whole globe: a coverage box is only useful if it excludes things.
      expect(b.maxLat - b.minLat).toBeLessThan(120);
      expect(b.maxLon - b.minLon).toBeLessThan(180);
    });

    it('reports health', async () => {
      const body = (await get('/health')).json();
      expect(body.status).toBe('ok');
      expect(body.addresses).toBeGreaterThan(1_000_000);
    });
  });
});

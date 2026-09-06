/**
 * Forward geocoding: text to ranked points.
 *
 * Searches anchors, not addresses. That is 17x fewer documents, because a house
 * number is a lookup within a street rather than a searchable name of its own.
 *
 * `query.ts` parses, `terms.ts` retrieves, `ranking.ts` scores,
 * `housenumber.ts` resolves the number, `fuzzy.ts` handles the zero-result
 * path. What is left here is the search loop and the bound that stops it early.
 */
import { type Artifact } from './artifact.js';
import { type GeocodeResult, anchorResult, addressResult } from './result.js';
import { haversineMetres } from './geometry.js';
import { type ParsedQuery, parseQuery } from './query.js';
import { candidates } from './terms.js';
import { type RankingOptions, cheapScore, relevance, maxRelevance } from './ranking.js';
import { resolveHouseNumber, HOUSE_EXACT } from './housenumber.js';
import { correctTokens } from './fuzzy.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';

export type { GeocodeResult } from './result.js';
export { anchorBBox } from './result.js';

export interface ForwardOptions extends RankingOptions {
  limit?: number;
  country?: string;
  /** Set false to suppress the spelling-correction retry on a zero-result query. */
  fuzzy?: boolean;
}

/**
 * Hard ceiling, so a pathological query cannot run unbounded. The bound normally
 * stops the scan long before it: this binds only where thousands of candidates
 * share a short name, and "Warszawa" needs 8,639 of its 16,253 because no sound
 * bound tells it from "Warszawska" without folding the name.
 */
const MAX_RERANK = 10_000;

/**
 * Fixed rather than proportional to the limit: the cutoff is the keep-th best
 * score, so every extra slot lowers it and prunes less. limit*4 to limit+4 took
 * "Praha" from 3,635 full scorings to 971. Dedup dropped at most 3 over a
 * 96-query sweep, and `SearchStats.dropped` reports the live figure.
 */
const DEDUP_HEADROOM = 4;

/** How hard the search worked, for tests and metrics. */
export interface SearchStats {
  candidates: number;
  reranked: number;
  /** MAX_RERANK stopped the scan before the bound did, so the guarantee lapsed. */
  cappedByLimit: boolean;
  dropped: number;
}

const EMPTY_STATS: SearchStats = {
  candidates: 0, reranked: 0, cappedByLimit: false, dropped: 0,
};

interface SearchOutcome {
  results: GeocodeResult[];
  stats: SearchStats;
}

/**
 * Returned rather than stashed in module state: reading diagnostics from a
 * shared variable stays correct only until somebody puts an `await` between the
 * search and the read.
 */
export interface ForwardResult extends SearchOutcome {
  /** The spelling actually searched, for "showing results for ...". Null when
   * the query was used as given. */
  corrected: string | null;
}

export function forward(
  a: Artifact, query: string, opts: ForwardOptions = {},
): ForwardResult {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  // A query can parse more than one way — "Plac 3 Maja" reads as a street with
  // no number, "Via Roma 1" as a street with one. Try each reading and take the
  // first that finds anything, rather than guessing from the shape alone.
  const readings = parseQuery(query).filter((p) => p.nameTokens.length > 0);
  let last: SearchOutcome = { results: [], stats: EMPTY_STATS };
  for (const parsed of readings) {
    last = search(a, parsed, limit, opts);
    if (last.results.length > 0) return { ...last, corrected: null };
  }

  // Nothing matched as typed, so retry against the nearest real spelling.
  // After the exact attempt, never instead of it: a correctly spelled query
  // must never be second-guessed.
  if (opts.fuzzy === false) return { ...last, corrected: null };
  for (const parsed of readings) {
    const fixed = correctTokens(a, parsed.nameTokens);
    if (fixed === null) continue;
    const out = search(a, { ...parsed, nameTokens: fixed }, limit, opts);
    if (out.results.length > 0) {
      const corrected = [...fixed, ...(parsed.houseNumber !== null ? [parsed.houseNumber] : [])]
        .join(' ');
      return { ...out, corrected };
    }
  }
  return { ...last, corrected: null };
}

/**
 * Ranks candidates without ever discarding one that could have won.
 *
 * Two stages, forced by cost: `relevance` folds an anchor's name and every
 * alias, far too expensive to run on every posting of a common term. Which
 * survivors to refine is the hard part. Cutting at a fixed depth is unsound —
 * the omitted factors multiply by up to 45, so a candidate ranked 400th on
 * cheap score can finish first, and the Nádražní in Brno came 427th of 1,136
 * and was dropped from every query.
 *
 * So the cheap score becomes an upper bound and candidates are visited in bound
 * order. Once the k-th best final score exceeds the next candidate's bound,
 * nothing further can enter the result. This is A*'s admissibility argument,
 * and it prunes harder than a fixed depth on selective queries, because a
 * strong first result raises the cutoff at once.
 */
function search(
  a: Artifact, parsed: ParsedQuery, limit: number, opts: ForwardOptions,
): SearchOutcome {
  const wantCountry = opts.country
    ? a.manifest.country_ids[opts.country.toLowerCase()]
    : undefined;

  const scored = candidates(a, parsed.nameTokens, MAX_RERANK);
  if (scored.size === 0) {
    return { results: [], stats: EMPTY_STATS };
  }

  const houseCeiling = parsed.houseNumber !== null ? HOUSE_EXACT : 1;
  const qLen = parsed.nameTokens.length;

  // Parallel arrays rather than objects, and a heap rather than a sort. The scan
  // usually stops after a few hundred, so fully ordering 23,251 candidates to
  // consume 79 is waste: a 3-character prefix went from 3.91ms to 1.38ms.
  let n = 0;
  const ids = new Int32Array(scored.size);
  const cheaps = new Float64Array(scored.size);
  const bounds = new Float64Array(scored.size);
  for (const [id, text] of scored) {
    if (wantCountry !== undefined && a.anchorCountry[id] !== wantCountry) continue;
    const cheap = cheapScore(a, id, text, opts);
    ids[n] = id;
    cheaps[n] = cheap;
    bounds[n] = cheap * maxRelevance(a, id, qLen) * houseCeiling;
    n++;
  }

  const heap = new Int32Array(n);
  for (let i = 0; i < n; i++) heap[i] = i;
  let size = n;
  const siftDown = (root: number): void => {
    for (;;) {
      let best = root;
      const l = 2 * root + 1;
      const r = l + 1;
      if (l < size && bounds[heap[l]!]! > bounds[heap[best]!]!) best = l;
      if (r < size && bounds[heap[r]!]! > bounds[heap[best]!]!) best = r;
      if (best === root) return;
      const t = heap[root]!;
      heap[root] = heap[best]!;
      heap[best] = t;
      root = best;
    }
  };
  for (let i = (n >> 1) - 1; i >= 0; i--) siftDown(i);

  const keep = limit + DEDUP_HEADROOM;
  const ranked: { id: number; score: number; addrIdx: number | null }[] = [];
  let reranked = 0;
  let cappedByLimit = false;

  while (size > 0) {
    const slot = heap[0]!;
    const id = ids[slot]!;
    // The highest bound left, so if it cannot reach the cutoff nothing can.
    if (ranked.length >= keep && bounds[slot]! <= ranked[keep - 1]!.score) break;
    if (reranked >= MAX_RERANK) { cappedByLimit = true; break; }
    heap[0] = heap[--size]!;
    siftDown(0);
    reranked++;

    let score = cheaps[slot]! * relevance(a, id, parsed.nameTokens);

    let addrIdx: number | null = null;
    if (parsed.houseNumber !== null) {
      const h = resolveHouseNumber(a, id, parsed.houseNumber);
      score *= h.factor;
      addrIdx = h.addrIdx;
    }

    // Insertion sort keeps the cutoff current, so the bound prunes as early as
    // possible. Ties break on anchor id rather than heap order: Wenceslas Square
    // is mapped as two ways with identical scores, and the API must not vary run
    // to run.
    let i = ranked.length;
    while (i > 0 && (ranked[i - 1]!.score < score
      || (ranked[i - 1]!.score === score && ranked[i - 1]!.id > id))) i--;
    ranked.splice(i, 0, { id, score, addrIdx });
    if (ranked.length > keep) ranked.pop();
  }

  const stats: SearchStats = { candidates: n, reranked, cappedByLimit, dropped: 0 };

  const out: GeocodeResult[] = [];
  for (const { id, score, addrIdx } of ranked) {
    if (out.length >= limit) break;
    const r = addrIdx !== null
      ? addressResult(a, addrIdx, id, score)
      : anchorResult(a, id, score);
    if (isDuplicateOf(out, r)) { stats.dropped++; continue; }
    out.push(r);
  }
  return { results: out, stats };
}

const DUPLICATE_RADIUS_M = 600;

/**
 * Karlův most is mapped as an attraction several times along its length, a tram
 * stop once per direction. Not fixable at build time: those features are
 * hundreds of metres apart, and a merge radius that wide would fold together
 * distinct branches of a chain.
 */
function isDuplicateOf(accepted: GeocodeResult[], r: GeocodeResult): boolean {
  for (const prev of accepted) {
    if (prev.layer !== r.layer) continue;
    if (prev.houseNumber !== r.houseNumber) continue;
    if (foldTokens(prev.name).join(' ') !== foldTokens(r.name).join(' ')) continue;
    if (haversineMetres(prev.lat, prev.lon, r.lat, r.lon) <= DUPLICATE_RADIUS_M) {
      return true;
    }
  }
  return false;
}

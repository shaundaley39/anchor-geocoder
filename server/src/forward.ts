/**
 * Forward geocoding: text to ranked candidate points.
 *
 * Searches anchors (streets and places), not addresses — 17x fewer documents,
 * because a house number is a lookup within a street, not a searchable name.
 * Split off the number, match the rest against the inverted index, rank, then
 * resolve the number inside the winning anchor's address run.
 *
 * The pieces live next door: `query.ts` parses, `terms.ts` retrieves,
 * `ranking.ts` scores, `housenumber.ts` resolves the number, `fuzzy.ts` handles
 * the zero-result path. What is left here is the search loop that combines
 * them, and the bound that lets it stop early.
 */
import { type Artifact, layerOf } from './artifact.js';
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
 * Hard ceiling on full scorings per query. The bound normally terminates the
 * scan long before this; it binds only where thousands of candidates share a
 * short name the query matches, and "Warszawa" is the honest example — 8,633 of
 * its 16,253 candidates have a bound above the cutoff, because a sound bound
 * cannot tell "Warszawa" from "Warszawska" without folding the name. When this
 * does bind, `SearchStats.cappedByLimit` records that the guarantee lapsed.
 */
const MAX_RERANK = 10_000;

/**
 * Extra results retained beyond `limit` to absorb the deduplication below.
 * Fixed, not proportional to the limit: the cutoff is the keep-th best score,
 * so every extra slot lowers the cutoff and prunes less. Over a 96-query sweep
 * dedup dropped at most 3, so 4 covers it — and going from limit*4 to limit+4
 * took "Praha" from 3,635 full scorings to 971. `SearchStats.dropped` reports
 * the real figure, so the margin can be rechecked against a live index.
 */
const DEDUP_HEADROOM = 4;

/** How hard the search worked, for tests and metrics. */
export interface SearchStats {
  candidates: number;
  reranked: number;
  /** True when MAX_RERANK stopped the scan before the bound did. */
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
 * A forward search and what it took.
 *
 * Returned rather than stashed in module state: the diagnostics belong to one
 * call, and a caller reading them from a shared variable is correct only for as
 * long as nobody puts an `await` between the search and the read.
 */
export interface ForwardResult extends SearchOutcome {
  /**
   * The spelling actually searched, when it differed from what was typed, so
   * the response can say "showing results for ..." rather than silently
   * answering a question nobody asked. Null whenever the query was used as
   * given.
   */
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

  // Nothing matched as typed. A misspelling is the most visible way a search
  // box feels broken, so retry once against the nearest real spelling — after
  // the exact attempt, never instead of it, so a correctly spelled query can
  // never be second-guessed.
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
 * The two-stage shape is forced by cost: `relevance` has to fold an anchor's
 * name and every alias, which is far too expensive to run on every posting of a
 * common term. So a cheap pass scores what array reads allow, and an expensive
 * pass refines the survivors.
 *
 * The question is which survivors. Cutting at a fixed depth is unsound, and
 * measurably so: the factors the cheap pass omits multiply by up to
 * MAX_RELEVANCE * MAX_HOUSE_BONUS = 45, so a candidate ranked 400th by the
 * cheap score can legitimately finish first. That is not hypothetical — the
 * Nádražní in Brno came 427th of 1,136 and was dropped from every query.
 *
 * So the cheap score is turned into an *upper bound* on the final score by
 * multiplying in the maximum each remaining factor can contribute, and
 * candidates are visited in bound order. Once the k-th best final score exceeds
 * the next candidate's bound, nothing further can enter the result — the scan
 * stops, and what it skipped provably could not have won.
 *
 * This is A*'s admissibility argument: an optimistic estimate makes pruning
 * safe. It also prunes far harder than a fixed depth on selective queries,
 * because a strong first result raises the cutoff immediately.
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

  // A house number can only multiply the score where the query supplies one.
  const houseCeiling = parsed.houseNumber !== null ? HOUSE_EXACT : 1;
  const qLen = parsed.nameTokens.length;

  // Parallel arrays rather than objects, and a heap rather than a sort: the
  // scan usually stops after a few hundred candidates, so paying O(n log n) to
  // order all of them is waste. Heapify is O(n) and each pop O(log n), which
  // took a 3-character prefix over 23,251 candidates from 3.91 ms to 1.38 ms.
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

  // Max-heap of slot indices, ordered by bound.
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
    // Provably safe: this is the highest bound left, so if it cannot reach the
    // cutoff, nothing still in the heap can displace the retained set.
    if (ranked.length >= keep && bounds[slot]! <= ranked[keep - 1]!.score) break;
    if (reranked >= MAX_RERANK) { cappedByLimit = true; break; }
    heap[0] = heap[--size]!;
    siftDown(0);
    reranked++;

    let score = cheaps[slot]! * relevance(a, id, parsed.nameTokens);

    // Exact beats numeric: "248/39" matches dozens of streets numerically but
    // usually only one exactly.
    let addrIdx: number | null = null;
    if (parsed.houseNumber !== null) {
      const h = resolveHouseNumber(a, id, parsed.houseNumber);
      score *= h.factor;
      addrIdx = h.addrIdx;
    }

    // Insertion sort into the retained set: `keep` is small, and this keeps the
    // cutoff current so the bound can prune as early as possible. Ties break on
    // anchor id, so the order does not depend on the heap's internal one —
    // Prague's Wenceslas Square is mapped as two ways with the same score, and
    // without this the API returns a different one run to run.
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

/** Two results this close with the same name describe the same place. */
const DUPLICATE_RADIUS_M = 600;

/**
 * Collapses results naming the same real place — Karlův most is mapped as an
 * attraction several times along its length, a tram stop once per direction.
 *
 * Not fixable at build time: the features are hundreds of metres apart, and a
 * merge radius that wide would fold together distinct branches of a chain.
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

/**
 * Forward geocoding: text to ranked candidate points.
 *
 * Searches anchors (streets and places), not addresses — 17x fewer documents,
 * because a house number is a lookup within a street, not a searchable name.
 * Split off the number, match the rest against the inverted index, rank, then
 * resolve the number inside the winning anchor's address run.
 */
import { type Artifact, layerOf, toDeg, LAYER_PLACE, ALT_SEP } from './artifact.js';
import { type GeocodeResult, anchorResult, addressResult } from './result.js';
import { correctTokens } from './fuzzy.js';

export type { GeocodeResult } from './result.js';
export { anchorBBox } from './result.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';

export interface ForwardOptions {
  limit?: number;
  country?: string;
  /** Bias results toward this point. */
  proximity?: { lat: number; lon: number };
  /** Set false to suppress the spelling-correction retry on a zero-result query. */
  fuzzy?: boolean;
}

/** A query split into the parts that search differently. */
export interface ParsedQuery {
  /** Tokens matched against the anchor index. */
  nameTokens: string[];
  /** The trailing house number, if the query looks like it has one. */
  houseNumber: string | null;
}

/**
 * Candidate readings of a query, best guess first; the caller takes the first
 * that finds anything.
 *
 * A trailing or medial digit-leading token is a house number. Never a leading
 * one: "3 Maja" is a common Polish street name.
 */
export function parseQuery(raw: string): ParsedQuery[] {
  const all = foldTokens(raw);
  if (all.length <= 1) return [{ nameTokens: all, houseNumber: null }];

  const whole: ParsedQuery = { nameTokens: all, houseNumber: null };
  const last = all[all.length - 1]!;

  if (/^\d/.test(last)) {
    const head = all.slice(0, -1);
    // Czech numbers fold to two tokens ("248/39" -> ["248","39"]); pull both.
    const prev = head[head.length - 1];
    if (head.length > 1 && prev !== undefined && /^\d+$/.test(prev)) {
      return [{ nameTokens: head.slice(0, -1), houseNumber: `${prev}/${last}` }, whole];
    }
    return [{ nameTokens: head, houseNumber: last }, whole];
  }

  // Medial: "Via Roma 1 Torino". Much of the region writes the number between
  // street and city, so a trailing-only rule fails those outright.
  for (let i = 1; i < all.length - 1; i++) {
    const tok = all[i]!;
    if (!/^\d/.test(tok)) continue;
    const next = all[i + 1]!;
    // Czech composed numbers again, now in the middle of the query.
    if (/^\d+$/.test(tok) && /^\d/.test(next) && i + 1 < all.length - 1) {
      return [{
        nameTokens: [...all.slice(0, i), ...all.slice(i + 2)],
        houseNumber: `${tok}/${next}`,
      }, whole];
    }
    return [{
      nameTokens: [...all.slice(0, i), ...all.slice(i + 1)],
      houseNumber: tok,
    }, whole];
  }
  return [whole];
}

/**
 * Smoothing floor on document frequency.
 *
 * Unfloored IDF swings 2.4x between a one-posting term and a 16,000-posting
 * one, which swamps a 7x difference in importance: "Warsz" surfaced a shop
 * branded "Warsz" above Warszawa. Below a few hundred postings, rarity says
 * nothing more about intent, so the curve saturates there.
 */
const DF_FLOOR = 500;

function idf(nAnchors: number, postings: number): number {
  return Math.log(1 + nAnchors / (DF_FLOOR + postings));
}

/** Posting list for a term id. */
function postings(a: Artifact, termID: number): Uint32Array {
  return a.post.subarray(a.postOff[termID]!, a.postOff[termID + 1]!);
}

/**
 * Candidate anchors for the name tokens. All tokens but the last match exactly;
 * the last is a prefix, which is what makes autocomplete work.
 */
function candidates(a: Artifact, nameTokens: string[], maxCandidates: number): Map<number, number> {
  const scores = new Map<number, number>();
  if (nameTokens.length === 0) return scores;

  const nAnchors = a.manifest.num_anchors;
  // Distinct, because the weights below are summed per term: "Praha Praha"
  // would otherwise collect the same posting's IDF twice and outrank "Praha".
  const complete = [...new Set(nameTokens.slice(0, -1))];
  const last = nameTokens[nameTokens.length - 1]!;

  // Exact terms first: the smallest posting list bounds the intersection.
  const lists: Uint32Array[] = [];
  const weights: number[] = [];
  for (const t of complete) {
    const id = a.terms.find(t);
    if (id < 0) return scores; // a required token matches nothing
    const p = postings(a, id);
    lists.push(p);
    weights.push(idf(nAnchors, p.length));
  }

  // The final token as a prefix: union every term sharing it.
  const [lo, hi] = a.terms.prefixRange(last);
  if (lo >= hi) return scores;

  // What matters is the rarity of the *prefix the user typed*, not of whichever
  // expansion an anchor happens to carry. Weighting per expansion made a
  // one-posting term the most valuable thing in the index — "Warsz" put a shop
  // branded "Warsz" above Warszawa. Summing the range is a walk over offsets.
  let prefixTotal = 0;
  for (let t = lo; t < hi; t++) prefixTotal += a.postOff[t + 1]! - a.postOff[t]!;
  const prefixIdf = idf(nAnchors, prefixTotal);

  const prefixHits = new Map<number, number>();
  let scanned = 0;
  for (let t = lo; t < hi; t++) {
    const term = a.terms.get(t);
    const p = postings(a, t);

    // Completeness: how much of the matched term the user actually typed.
    // Prefix expansion is a fallback, not an equal-weight alternative, so it is
    // discounted — squared, so a term twice as long keeps a quarter of its
    // weight. Without it "Prahatice" outscored "Praha".
    //
    // No separate exact-term bonus: completeness is already 1 when the term
    // equals the query, and double-counting it penalised legitimate prefixes.
    const completeness = last.length / term.length;
    const w = prefixIdf * completeness * completeness;

    for (const anchor of p) {
      prefixHits.set(anchor, Math.max(prefixHits.get(anchor) ?? 0, w));
    }
    scanned += p.length;
    // A one-letter prefix can span a large slice of the index. Cap the work;
    // the exact-term list (scanned first, ordered by selectivity) still anchors
    // the result set.
    if (scanned > maxCandidates * 20) break;
  }

  if (lists.length === 0) {
    return prefixHits;
  }

  // Intersect: an anchor must appear in every exact list and in the prefix set.
  const smallest = lists.reduce((m, l) => (l.length < m.length ? l : m), lists[0]!);
  const membership = lists.map((l) => new Set(l));
  for (const anchor of smallest) {
    const pw = prefixHits.get(anchor);
    if (pw === undefined) continue;
    let total = pw;
    let ok = true;
    for (let i = 0; i < membership.length; i++) {
      if (!membership[i]!.has(anchor)) { ok = false; break; }
      total += weights[i]!;
    }
    if (ok) scores.set(anchor, total);
  }
  return scores;
}

const EARTH_RADIUS_M = 6371008.8;

export function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

/** Where a house number was found, and how good the match was. */
export interface HouseNumberMatch {
  index: number;
  /** True when the stored number folds identically to what the user typed. */
  exact: boolean;
}

/**
 * Finds a house number in an anchor's address run by binary search; the run is
 * sorted by the number's leading integer.
 *
 * An exact string match wins, but a numeric one is accepted: Czech addresses
 * carry two numbers ("248/39") and users type either. The caller needs to know
 * which it got — the exact match deserves to outrank the dozens that merely
 * share a 248.
 */
export function findHouseNumber(
  a: Artifact, anchorID: number, wanted: string,
): HouseNumberMatch | null {
  const start = a.anchorAddrStart[anchorID]!;
  const count = a.anchorAddrCount[anchorID]!;
  if (count === 0) return null;

  const wantedFold = foldTokens(wanted).join(' ');
  const numeric = parseInt(wanted, 10);
  if (Number.isNaN(numeric)) return null;

  // First index whose sort key >= numeric.
  let lo = start;
  let hi = start + count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a.addrSortKey[mid]! < numeric) lo = mid + 1;
    else hi = mid;
  }

  let numericMatch: number | null = null;
  for (let i = lo; i < start + count && a.addrSortKey[i] === numeric; i++) {
    const s = a.strings.get(a.addrNum[i]!);
    if (foldTokens(s).join(' ') === wantedFold) return { index: i, exact: true };
    if (numericMatch === null) numericMatch = i;
  }
  return numericMatch === null ? null : { index: numericMatch, exact: false };
}

/**
 * An anchor's name and locality as tokens. Computed lazily and memoized: only
 * the few hundred reranked candidates need it, so storing it would cost several
 * MB of index for nothing.
 */
interface AnchorTokens {
  /** The canonical name first, then each alternate name, each folded separately. */
  names: string[][];
  locality: string[];
}
const anchorTokenCache = new Map<number, AnchorTokens>();

function anchorTokens(a: Artifact, id: number): AnchorTokens {
  const hit = anchorTokenCache.get(id);
  if (hit !== undefined) return hit;

  const names = [foldTokens(a.strings.get(a.anchorName[id]!))];
  const altID = a.anchorAlt[id]!;
  if (altID !== 0) {
    for (const alt of a.strings.get(altID).split(ALT_SEP)) {
      const toks = foldTokens(alt);
      if (toks.length > 0) names.push(toks);
    }
  }
  const t: AnchorTokens = { names, locality: foldTokens(a.strings.get(a.anchorLocal[id]!)) };
  if (anchorTokenCache.size < 200_000) anchorTokenCache.set(id, t);
  return t;
}

/** Exact for every token but the last, which is a prefix (autocomplete). */
/**
 * Index of the first token matching `q` that `used` has not already claimed, or
 * -1. Claiming matters: without it a query token matches the same name token
 * once per repetition, so "Praha Praha Praha" reported three matches against
 * the one-token name "Praha" and scored above "Praha" itself. Matching as
 * multisets keeps a genuinely doubled name working — "Baden Baden" still finds
 * both tokens of "Baden-Baden".
 */
function claim(tokens: string[], used: boolean[], q: string, isLast: boolean): number {
  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    if (isLast ? tokens[i]!.startsWith(q) : tokens[i] === q) return i;
  }
  return -1;
}

/**
 * How well an anchor's name and locality explain the query.
 *
 * Anchors are indexed on more than their name — a POI carries its street and
 * city too — so scoring on name *length* credits matches that never touched the
 * name: a station called "Lednice" at Nádražní 1 once beat every street named
 * Nádražní. Two quantities instead: how much of the query the name explains
 * (locality at partial credit, so adding a city helps rather than dilutes), and
 * how much of the name the query used.
 */
function relevance(a: Artifact, id: number, queryTokens: string[]): number {
  const { names, locality } = anchorTokens(a, id);
  if (names.length === 0) return 0.05;

  // Score every name the feature is known by and keep the best. Scoring the
  // canonical name alone made exonyms unrankable: "Prague" is indexed as a term
  // pointing at Praha, but "prague" is not a token of "Praha", so the query
  // looked like it had matched nothing but incidental context and a POI called
  // "Prague College" won. Merging the variants into one bag is also wrong — it
  // would make every well-documented place appear to have a very long name and
  // score worse the better it is described.
  let best = 0;
  for (const name of names) {
    if (name.length === 0) continue;

    let inName = 0;
    let inLocality = 0;
    const nameUsedTokens: boolean[] = new Array(name.length).fill(false);
    const locUsedTokens: boolean[] = new Array(locality.length).fill(false);
    for (let i = 0; i < queryTokens.length; i++) {
      const q = queryTokens[i]!;
      const isLast = i === queryTokens.length - 1;
      const inN = claim(name, nameUsedTokens, q, isLast);
      if (inN >= 0) {
        nameUsedTokens[inN] = true;
        inName++;
        continue;
      }
      const inL = claim(locality, locUsedTokens, q, isLast);
      if (inL >= 0) {
        locUsedTokens[inL] = true;
        inLocality++;
      }
    }

    // Never zero: a POI genuinely standing on the queried street is a weak but
    // legitimate answer, and should rank last rather than vanish.
    const explained = Math.max(
      (inName + 0.6 * inLocality) / queryTokens.length, 0.05,
    );
    // At most 1 by construction, since `claim` consumes each name token once,
    // but stated explicitly because the bound below depends on it.
    const nameUsed = Math.min(inName / name.length, 1);
    const base = explained * (0.1 + 0.9 * nameUsed);

    // Squared, because a partial name match is a much weaker signal than the
    // raw token overlap suggests, and the importance priors it competes against
    // span an order of magnitude.
    let score = base * base;

    // An exact full-name match — every query token in this name, every token of
    // this name used — is the strongest signal available. Without it a
    // perfectly matched street ("Nádražní", prior 1.0) loses to a partial match
    // on a higher-prior feature: a school "ZŠ Nádražní" (1.8) or a suburb
    // "Nádražní Předměstí" (2.5).
    if (inName === name.length && inName === queryTokens.length) score *= 2.5;

    if (score > best) best = score;
  }
  return best || 0.05;
}

/**
 * The most `relevance` can return for an anchor, without folding its name.
 *
 * `relevance` is `explained * (0.1 + 0.9 * nameUsed)`, squared, times 2.5 for an
 * exact full-name match. `explained` is at most 1, because each query token
 * counts toward either the name or the locality and never both. `nameUsed` is
 * `min(inName / nameLength, 1)`.
 *
 * So a query of q tokens can use at most `min(q, n) / n` of an n-token name,
 * and only a name of exactly q tokens can take the exact-match bonus. The
 * artifact stores n for the shortest variant, which is the one that maximises
 * both terms — so this is a true ceiling, and a far tighter one than the
 * blanket 2.5 it replaces.
 *
 * It matters: for a single-token query like "Praha", most candidates are
 * three-word POIs merely *located* in Praha. The blanket ceiling claimed each
 * might be an exact match and pruning never fired; this puts them at 0.16.
 */
function maxRelevance(a: Artifact, id: number, queryLen: number): number {
  const n = a.anchorNameTokens[id]! || 1;
  const nameUsed = Math.min(queryLen / n, 1);
  const base = 0.1 + 0.9 * nameUsed;
  // Only an equal-length name can match exactly; n is the shortest variant, so
  // a longer one could still equal queryLen — hence >= rather than ===.
  return base * base * (queryLen >= n ? 2.5 : 1);
}

/** The ceiling when the anchor's name length is unknown. */
const MAX_RELEVANCE = 2.5;

/** An exact house-number match is the largest single multiplier in the score. */
const MAX_HOUSE_BONUS = 18;

/**
 * Hard ceiling on reranking, so a pathological query cannot run unbounded.
 *
 * Reaching it means the bound stopped being useful, not that the answer is
 * wrong, so it is counted rather than silent — see `lastSearchStats`.
 */
/**
 * Hard ceiling on full scorings per query. The bound normally terminates the
 * scan long before this; it binds only where thousands of candidates share a
 * short name the query matches, and "Warszawa" is the honest example — 8,633 of
 * its 16,253 candidates have a bound above the cutoff, because a sound bound
 * cannot tell "Warszawa" from "Warszawska" without folding the name. When this
 * does bind, `lastSearchStats.cappedByLimit` records that the guarantee lapsed.
 */
const MAX_RERANK = 10_000;

/**
 * Extra results retained beyond `limit` to absorb the deduplication below.
 * Fixed, not proportional to the limit: the cutoff is the keep-th best score,
 * so every extra slot lowers the cutoff and prunes less. Over a 96-query sweep
 * dedup dropped at most 3, so 4 covers it — and going from limit*4 to limit+4
 * took "Praha" from 3,635 full scorings to 971. `lastSearchStats.dropped`
 * reports the real figure, so the margin can be rechecked against a live index.
 */
const DEDUP_HEADROOM = 4;

/** Diagnostics from the most recent search, for tests and metrics. */
export interface SearchStats {
  candidates: number;
  reranked: number;
  /** True when MAX_RERANK stopped the scan before the bound did. */
  cappedByLimit: boolean;
  dropped: number;
}
export let lastSearchStats: SearchStats = {
  candidates: 0, reranked: 0, cappedByLimit: false, dropped: 0,
};

/**
 * Distance decay for the `proximity` bias: ~2x at the query point, ~1.5x at
 * 50km, asymptotically 1x. Never zero, so proximity reorders results rather
 * than filtering them — a far-away exact match still beats a nearby poor one.
 */
function proximityBoost(
  p: { lat: number; lon: number }, a: Artifact, id: number,
): number {
  const d = haversineMetres(p.lat, p.lon, toDeg(a.anchorLat[id]!), toDeg(a.anchorLon[id]!));
  return 1 + 1 / (1 + d / 50_000);
}

/**
 * The spelling actually searched, when it differed from what was typed, so the
 * response can say "showing results for ..." rather than silently answering a
 * question nobody asked. Null whenever the query was used as given.
 */
export let lastCorrection: string | null = null;

export function forward(
  a: Artifact, query: string, opts: ForwardOptions = {},
): GeocodeResult[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  lastCorrection = null;

  // A query can parse more than one way — "Plac 3 Maja" reads as a street with
  // no number, "Via Roma 1" as a street with one. Try each reading and take the
  // first that finds anything, rather than guessing from the shape alone.
  const readings = parseQuery(query).filter((p) => p.nameTokens.length > 0);
  for (const parsed of readings) {
    const out = search(a, parsed, limit, opts);
    if (out.length > 0) return out;
  }

  // Nothing matched as typed. A misspelling is the most visible way a search
  // box feels broken, so retry once against the nearest real spelling — after
  // the exact attempt, never instead of it, so a correctly spelled query can
  // never be second-guessed.
  if (opts.fuzzy === false) return [];
  for (const parsed of readings) {
    const fixed = correctTokens(a, parsed.nameTokens);
    if (fixed === null) continue;
    const out = search(a, { ...parsed, nameTokens: fixed }, limit, opts);
    if (out.length > 0) {
      lastCorrection = [...fixed, ...(parsed.houseNumber !== null ? [parsed.houseNumber] : [])]
        .join(' ');
      return out;
    }
  }
  return [];
}

/**
 * Everything the cheap pass can compute without decoding a single string.
 *
 * These are all array reads, so they cost the same for every candidate and can
 * be applied to all of them.
 */
function cheapScore(
  a: Artifact, id: number, text: number, opts: ForwardOptions,
): number {
  let s = text * a.anchorScore[id]!;
  if (layerOf(a.anchorFlags[id]!) === LAYER_PLACE) {
    // A bare settlement name is more often the intent than a POI sharing it.
    s *= 1.25;
  } else {
    // Everything else inherits the standing of the place it is in. Streets and
    // POIs share one flat prior, so without this "Unter den Linden" resolved to
    // an Austrian hamlet. Damped hard: it breaks ties, it does not override a
    // better match.
    s *= 1 + a.localityScore[a.anchorLocal[id]!]! / 10;
  }
  if (opts.proximity) s *= proximityBoost(opts.proximity, a, id);
  return s;
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
): GeocodeResult[] {
  const wantCountry = opts.country
    ? a.manifest.country_ids[opts.country.toLowerCase()]
    : undefined;

  const scored = candidates(a, parsed.nameTokens, MAX_RERANK);
  if (scored.size === 0) {
    lastSearchStats = { candidates: 0, reranked: 0, cappedByLimit: false, dropped: 0 };
    return [];
  }

  // A house number can only multiply the score where the query supplies one.
  const houseCeiling = parsed.houseNumber !== null ? MAX_HOUSE_BONUS : 1;
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

    let addrIdx: number | null = null;
    if (parsed.houseNumber !== null) {
      const hit = findHouseNumber(a, id, parsed.houseNumber);
      if (hit === null) {
        score *= 0.4; // the street exists, the number does not
      } else {
        addrIdx = hit.index;
        // Exact beats numeric: "248/39" matches dozens of streets numerically
        // but usually only one exactly.
        score *= hit.exact ? MAX_HOUSE_BONUS : 6;
      }
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

  lastSearchStats = { candidates: n, reranked, cappedByLimit, dropped: 0 };

  const out: GeocodeResult[] = [];
  for (const { id, score, addrIdx } of ranked) {
    if (out.length >= limit) break;
    const r = addrIdx !== null
      ? addressResult(a, addrIdx, id, score)
      : anchorResult(a, id, score);
    if (isDuplicateOf(out, r)) { lastSearchStats.dropped++; continue; }
    out.push(r);
  }
  return out;
}

/**
 * The upper bound a candidate would be given, exposed so tests can assert
 * admissibility: no candidate's final score may exceed it.
 */
export function scoreBound(
  a: Artifact, id: number, text: number, hasHouseNumber: boolean,
  queryLen: number, opts: ForwardOptions = {},
): number {
  return cheapScore(a, id, text, opts) *
    maxRelevance(a, id, queryLen) * (hasHouseNumber ? MAX_HOUSE_BONUS : 1);
}

/** The exact final score, for the same test. */
export function scoreExact(
  a: Artifact, id: number, text: number, parsed: ParsedQuery,
  opts: ForwardOptions = {},
): number {
  let score = cheapScore(a, id, text, opts) * relevance(a, id, parsed.nameTokens);
  if (parsed.houseNumber !== null) {
    const hit = findHouseNumber(a, id, parsed.houseNumber);
    if (hit === null) score *= 0.4;
    else score *= hit.exact ? MAX_HOUSE_BONUS : 6;
  }
  return score;
}

/** Candidate anchors and their term weights, exposed for the same test. */
export function candidatesFor(a: Artifact, nameTokens: string[]): Map<number, number> {
  return candidates(a, nameTokens, MAX_RERANK);
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

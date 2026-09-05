/**
 * Forward geocoding: text to ranked candidate points.
 *
 * The search runs over anchors (streets and places), not address points. There
 * are 677,786 anchors against 11.6M addresses — a 17x smaller index — because a
 * house number is not a searchable name, it is a lookup within a street. So the
 * pipeline is:
 *
 *   1. split the query into a house-number part and a name part
 *   2. match the name part against the anchor inverted index
 *   3. rank anchors
 *   4. if a house number was given, resolve it inside the best anchors' runs
 */
import {
  type Artifact, layerOf, countryOf, toDeg, LAYER_PLACE,
} from './artifact.js';
import { tokens as foldTokens } from './normalize.js';

export interface GeocodeResult {
  id: string;
  layer: 'address' | 'street' | 'place';
  name: string;
  locality: string;
  houseNumber?: string;
  country: string;
  lat: number;
  lon: number;
  score: number;
  /** Metres from the query point; reverse geocoding only. */
  distance?: number;
}

export interface ForwardOptions {
  limit?: number;
  country?: string;
  /** Bias results toward this point. */
  proximity?: { lat: number; lon: number };
}

/** A query split into the parts that search differently. */
export interface ParsedQuery {
  /** Tokens matched against the anchor index. */
  nameTokens: string[];
  /** The trailing house number, if the query looks like it has one. */
  houseNumber: string | null;
}

/**
 * Splits a house number off the query.
 *
 * Both countries write the number after the street ("Marszałkowska 12",
 * "Pražská 248/39"), so a trailing token that starts with a digit is treated as
 * one. A leading numeric token is *not*: "3 Maja" is a common Polish street
 * name (Third of May), and treating the 3 as a house number would break it.
 *
 * A query that is only a number has no name part to search, so the number is
 * kept as a name token instead — that way "Velká Úpa 299" still works when the
 * user types just the village.
 */
export function parseQuery(raw: string): ParsedQuery {
  const all = foldTokens(raw);
  if (all.length <= 1) return { nameTokens: all, houseNumber: null };

  const last = all[all.length - 1]!;
  if (/^\d/.test(last)) {
    const head = all.slice(0, -1);
    // Czech numbers fold to two tokens ("248/39" -> ["248","39"]); pull both.
    const prev = head[head.length - 1];
    if (head.length > 1 && prev !== undefined && /^\d+$/.test(prev) && /^\d/.test(last)) {
      return { nameTokens: head.slice(0, -1), houseNumber: `${prev}/${last}` };
    }
    return { nameTokens: head, houseNumber: last };
  }
  return { nameTokens: all, houseNumber: null };
}

/** Posting list for a term id. */
function postings(a: Artifact, termID: number): Uint32Array {
  return a.post.subarray(a.postOff[termID]!, a.postOff[termID + 1]!);
}

/**
 * Candidate anchors for the name tokens.
 *
 * Every token but the last must match a term exactly; the last is treated as a
 * prefix, which is what makes the endpoint usable for autocomplete. Scores
 * accumulate an IDF-ish weight so a rare token ("Świętokrzyska") counts for far
 * more than a common one ("Nowa").
 */
function candidates(a: Artifact, nameTokens: string[], maxCandidates: number): Map<number, number> {
  const scores = new Map<number, number>();
  if (nameTokens.length === 0) return scores;

  const nAnchors = a.manifest.num_anchors;
  const complete = nameTokens.slice(0, -1);
  const last = nameTokens[nameTokens.length - 1]!;

  // Exact terms first: they are the most selective, and the smallest posting
  // list bounds the whole intersection.
  const lists: Uint32Array[] = [];
  const weights: number[] = [];
  for (const t of complete) {
    const id = a.terms.find(t);
    if (id < 0) return scores; // a required token matches nothing
    const p = postings(a, id);
    lists.push(p);
    weights.push(Math.log(1 + nAnchors / (1 + p.length)));
  }

  // The final token as a prefix: union the posting lists of every term sharing
  // it, weighted by that term's own selectivity.
  const [lo, hi] = a.terms.prefixRange(last);
  if (lo >= hi) return scores;

  const prefixHits = new Map<number, number>();
  let scanned = 0;
  for (let t = lo; t < hi; t++) {
    const p = postings(a, t);
    const w = Math.log(1 + nAnchors / (1 + p.length));
    // An exact hit on the final token is worth more than a mere prefix hit,
    // so "Praha" outranks "Prahaville" when the user typed "Praha".
    const exact = a.terms.get(t) === last ? 1.6 : 1;
    for (const anchor of p) {
      prefixHits.set(anchor, Math.max(prefixHits.get(anchor) ?? 0, w * exact));
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

/**
 * Finds a house number inside an anchor's address run.
 *
 * The run is sorted by the number's leading integer, so this is a binary search
 * rather than a scan of what can be thousands of addresses on one street. An
 * exact string match wins; failing that the numeric match is accepted, so
 * "Pražská 248" finds the address written "248/39" — Czech addresses carry two
 * numbers and users type either.
 */
export function findHouseNumber(
  a: Artifact, anchorID: number, wanted: string,
): number | null {
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
    if (foldTokens(s).join(' ') === wantedFold) return i; // exact
    if (numericMatch === null) numericMatch = i;
  }
  return numericMatch;
}

function anchorResult(a: Artifact, id: number, score: number): GeocodeResult {
  const flags = a.anchorFlags[id]!;
  const layer = layerOf(flags) === LAYER_PLACE ? 'place' : 'street';
  return {
    id: `anchor:${id}`,
    layer,
    name: a.strings.get(a.anchorName[id]!),
    locality: a.strings.get(a.anchorLocal[id]!),
    country: a.countryByID[countryOf(flags)] ?? '',
    lat: toDeg(a.anchorLat[id]!),
    lon: toDeg(a.anchorLon[id]!),
    score,
  };
}

function addressResult(
  a: Artifact, addrIdx: number, anchorID: number, score: number,
): GeocodeResult {
  const flags = a.anchorFlags[anchorID]!;
  return {
    id: `addr:${addrIdx}`,
    layer: 'address',
    name: a.strings.get(a.anchorName[anchorID]!),
    locality: a.strings.get(a.anchorLocal[anchorID]!),
    houseNumber: a.strings.get(a.addrNum[addrIdx]!),
    country: a.countryByID[countryOf(flags)] ?? '',
    lat: toDeg(a.addrLat[addrIdx]!),
    lon: toDeg(a.addrLon[addrIdx]!),
    score,
  };
}

/**
 * Number of folded tokens in an anchor's own name.
 *
 * Not stored in the artifact: it is only needed for the few hundred candidates
 * that survive to reranking, so computing it lazily is cheaper than 2.7MB of
 * index and a rebuild. Memoized because popular anchors recur across queries.
 */
const nameTokenCount = new Map<number, number>();
function anchorNameTokens(a: Artifact, id: number): number {
  const hit = nameTokenCount.get(id);
  if (hit !== undefined) return hit;
  const n = foldTokens(a.strings.get(a.anchorName[id]!)).length || 1;
  if (nameTokenCount.size < 200_000) nameTokenCount.set(id, n);
  return n;
}

/** How many candidates survive coarse scoring to be reranked properly. */
const RERANK_DEPTH = 400;

export function forward(
  a: Artifact, query: string, opts: ForwardOptions = {},
): GeocodeResult[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const parsed = parseQuery(query);
  if (parsed.nameTokens.length === 0) return [];

  const wantCountry = opts.country
    ? a.manifest.country_ids[opts.country.toLowerCase()]
    : undefined;

  const scored = candidates(a, parsed.nameTokens, RERANK_DEPTH);
  if (scored.size === 0) return [];

  // Stage 1: coarse ranking, to cut the candidate set down to something worth
  // doing real work on. A query like "Prazska" matches hundreds of streets
  // nationwide; scoring all of them precisely would be wasted effort.
  //
  // The importance prior has to be applied HERE, not only in the rerank. The
  // term "praha" has 3,665 postings that all share one text weight — every
  // street whose locality is Praha — so ranking on text alone leaves the top
  // 400 an arbitrary slice of a 3,665-way tie, and Praha itself falls out of
  // it. Multiplying by the prior first is one array read and costs nothing.
  const coarse: { id: number; text: number; score: number }[] = [];
  for (const [id, text] of scored) {
    if (wantCountry !== undefined && countryOf(a.anchorFlags[id]!) !== wantCountry) continue;
    coarse.push({ id, text, score: text * a.anchorScore[id]! });
  }
  coarse.sort((x, y) => y.score - x.score);
  coarse.length = Math.min(coarse.length, RERANK_DEPTH);

  // Stage 2: rerank precisely.
  const qTokens = parsed.nameTokens.length;
  const ranked: { id: number; score: number; addrIdx: number | null }[] = [];

  for (const { id, text } of coarse) {
    const flags = a.anchorFlags[id]!;
    let score = text * a.anchorScore[id]!;

    // Coverage: how much of the anchor's own name the query accounted for.
    // Without this "Prazska" scores the same on "Prazska" as on "Nova Prazska"
    // and "Prazska brana", and the street the user actually meant is lost among
    // its longer namesakes. Squared, because partial name matches are much
    // weaker signals than the raw token overlap suggests.
    const nameLen = anchorNameTokens(a, id);
    const coverage = Math.min(qTokens, nameLen) / nameLen;
    score *= coverage * coverage;

    if (layerOf(flags) === LAYER_PLACE) score *= 1.25;

    // Resolve the house number now, not after truncating to `limit`: an anchor
    // that actually has the requested number is far more relevant than one that
    // merely shares a name, and it may sit well down the coarse ranking.
    let addrIdx: number | null = null;
    if (parsed.houseNumber !== null) {
      addrIdx = findHouseNumber(a, id, parsed.houseNumber);
      if (addrIdx !== null) score *= 6;
      else score *= 0.4; // the street exists, the number does not
    }

    if (opts.proximity) {
      const d = haversineMetres(
        opts.proximity.lat, opts.proximity.lon,
        toDeg(a.anchorLat[id]!), toDeg(a.anchorLon[id]!),
      );
      // Decays smoothly: ~2x at the query point, ~1.5x at 50km, never zero, so
      // proximity reorders results rather than filtering them.
      score *= 1 + 1 / (1 + d / 50_000);
    }
    ranked.push({ id, score, addrIdx });
  }

  ranked.sort((x, y) => y.score - x.score);

  const out: GeocodeResult[] = [];
  for (const { id, score, addrIdx } of ranked) {
    if (out.length >= limit) break;
    out.push(addrIdx !== null
      ? addressResult(a, addrIdx, id, score)
      : anchorResult(a, id, score));
  }
  return out;
}

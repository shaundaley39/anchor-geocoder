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

export type { GeocodeResult } from './result.js';
export { anchorBBox } from './result.js';
import { tokens as foldTokens } from './normalize.js';

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
  const complete = nameTokens.slice(0, -1);
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
function hits(tokens: string[], q: string, isLast: boolean): boolean {
  return isLast ? tokens.some((t) => t.startsWith(q)) : tokens.includes(q);
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
    for (let i = 0; i < queryTokens.length; i++) {
      const q = queryTokens[i]!;
      const isLast = i === queryTokens.length - 1;
      if (hits(name, q, isLast)) inName++;
      else if (hits(locality, q, isLast)) inLocality++;
    }

    // Never zero: a POI genuinely standing on the queried street is a weak but
    // legitimate answer, and should rank last rather than vanish.
    const explained = Math.max(
      (inName + 0.6 * inLocality) / queryTokens.length, 0.05,
    );
    const nameUsed = inName / name.length;
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
 * How many candidates survive coarse scoring — per layer, not overall.
 *
 * The coarse pass ranks only on the importance prior, which spans 1.0 for a
 * street to 7.0 for an airport, so one overall cut deletes the lowest-prior
 * layer wholesale. Measured: Nádražní/Brno came 427th of 1,136 postings behind
 * 424 stations and museums, and was discarded on every query.
 */
const RERANK_DEPTH_PER_LAYER = 200;

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

export function forward(
  a: Artifact, query: string, opts: ForwardOptions = {},
): GeocodeResult[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  // A query can parse more than one way — "Plac 3 Maja" reads as a street with
  // no number, "Via Roma 1" as a street with one. Try each reading and take the
  // first that finds anything, rather than guessing from the shape alone.
  for (const parsed of parseQuery(query)) {
    if (parsed.nameTokens.length === 0) continue;
    const out = search(a, parsed, limit, opts);
    if (out.length > 0) return out;
  }
  return [];
}

function search(
  a: Artifact, parsed: ParsedQuery, limit: number, opts: ForwardOptions,
): GeocodeResult[] {

  const wantCountry = opts.country
    ? a.manifest.country_ids[opts.country.toLowerCase()]
    : undefined;

  const scored = candidates(a, parsed.nameTokens, RERANK_DEPTH_PER_LAYER * 3);
  if (scored.size === 0) return [];

  // Stage 1: coarse ranking, to cut the candidate set to something worth real
  // work on. The prior must apply HERE, not only in the rerank: "praha" has
  // 3,665 postings sharing one text weight, so ranking on text alone leaves an
  // arbitrary slice of a 3,665-way tie — and Praha itself falls out of it.
  const byLayer: { id: number; text: number; score: number }[][] = [[], [], []];
  for (const [id, text] of scored) {
    const flags = a.anchorFlags[id]!;
    if (wantCountry !== undefined && a.anchorCountry[id] !== wantCountry) continue;
    let s = text * a.anchorScore[id]!;
    // Proximity biases the coarse pass for the same reason: 651 streets named
    // "Nádražní" share one weight and one prior, so the surviving slice of that
    // tie is otherwise arbitrary.
    if (opts.proximity) s *= proximityBoost(opts.proximity, a, id);
    (byLayer[layerOf(flags)] ?? byLayer[0]!).push({ id, text, score: s });
  }

  const coarse: { id: number; text: number; score: number }[] = [];
  for (const bucket of byLayer) {
    bucket.sort((x, y) => y.score - x.score);
    for (const c of bucket.slice(0, RERANK_DEPTH_PER_LAYER)) coarse.push(c);
  }

  // Stage 2: rerank precisely.
  const ranked: { id: number; score: number; addrIdx: number | null }[] = [];

  for (const { id, text } of coarse) {
    const flags = a.anchorFlags[id]!;
    let score = text * a.anchorScore[id]!;

    score *= relevance(a, id, parsed.nameTokens);

    if (layerOf(flags) === LAYER_PLACE) {
      // A bare settlement name is more often the intent than a POI sharing it.
      score *= 1.25;
    } else {
      // Everything else inherits the standing of the place it is in. Streets
      // and POIs share one flat prior, so without this "Unter den Linden"
      // resolved to an Austrian hamlet. Damped hard: it breaks ties between
      // equally good matches, it does not override a better one.
      score *= 1 + a.localityScore[a.anchorLocal[id]!]! / 10;
    }

    // Resolved before truncating to `limit`: an anchor that actually has the
    // number may sit well down the coarse ranking.
    let addrIdx: number | null = null;
    if (parsed.houseNumber !== null) {
      const hit = findHouseNumber(a, id, parsed.houseNumber);
      if (hit === null) {
        score *= 0.4; // the street exists, the number does not
      } else {
        addrIdx = hit.index;
        // Exact beats numeric: "248/39" matches dozens of streets numerically
        // but usually only one exactly.
        score *= hit.exact ? 18 : 6;
      }
    }

    if (opts.proximity) score *= proximityBoost(opts.proximity, a, id);
    ranked.push({ id, score, addrIdx });
  }

  ranked.sort((x, y) => y.score - x.score);

  const out: GeocodeResult[] = [];
  for (const { id, score, addrIdx } of ranked) {
    if (out.length >= limit) break;
    const r = addrIdx !== null
      ? addressResult(a, addrIdx, id, score)
      : anchorResult(a, id, score);
    if (isDuplicateOf(out, r)) continue;
    out.push(r);
  }
  return out;
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

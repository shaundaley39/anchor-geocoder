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
  type Artifact, layerOf, toDeg, LAYER_PLACE, LAYER_POI, ALT_SEP,
} from './artifact.js';
import { tokens as foldTokens } from './normalize.js';

export interface GeocodeResult {
  id: string;
  layer: 'address' | 'street' | 'place' | 'poi';
  name: string;
  locality: string;
  houseNumber?: string;
  country: string;
  /** OSM classification for POIs, e.g. "amenity=restaurant". */
  category?: string;
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

  // A medial number: "Via Roma 1 Torino", "Damrak 1 Amsterdam". Much of the
  // region writes the number between street and city, so a trailing-only rule
  // silently fails those queries entirely.
  //
  // Never the first token: "3 Maja" (Third of May) is a very common Polish
  // street name, and "3 Maggio" and "17 Novembre" are the same idea elsewhere.
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
 * Smoothing floor on document frequency when weighting a term.
 *
 * Plain IDF over 10.2M anchors spans log(1+10.2M/2)=15.4 for a term appearing
 * once to 6.4 for one appearing 16,000 times — a 2.4x swing that overwhelms a
 * 7x difference in importance. Typing "Warsz" surfaced a shop whose brand is
 * literally "Warsz" (one posting) above Warszawa (16,262), because the shop's
 * term was rarer and matched to its full length.
 *
 * Rarity stops being informative below a point: a term in fewer than a few
 * hundred of ten million anchors is simply rare, and how rare says nothing more
 * about what the user meant. Adding a floor to the denominator saturates the
 * curve there instead of letting it run away.
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
    weights.push(idf(nAnchors, p.length));
  }

  // The final token as a prefix: union the posting lists of every term sharing
  // it, weighted by that term's own selectivity.
  const [lo, hi] = a.terms.prefixRange(last);
  if (lo >= hi) return scores;

  // The rarity that matters for the final token is the rarity of the *prefix*
  // the user typed, not of whichever expansion a given anchor happens to carry.
  // Weighting per expansion made a one-posting term the most valuable thing in
  // the index: typing "Warsz" put a shop branded "Warsz" above Warszawa,
  // because that expansion had one posting against the city's 16,262 — even
  // though the prefix as typed matches 16,300 anchors and discriminates no
  // better than the city's own term does. Summing the range first costs only a
  // walk over the offset array, which is already resident.
  let prefixTotal = 0;
  for (let t = lo; t < hi; t++) prefixTotal += a.postOff[t + 1]! - a.postOff[t]!;
  const prefixIdf = idf(nAnchors, prefixTotal);

  const prefixHits = new Map<number, number>();
  let scanned = 0;
  for (let t = lo; t < hi; t++) {
    const term = a.terms.get(t);
    const p = postings(a, t);

    // Completeness: how much of the matched term the user actually typed.
    //
    // This is load-bearing, not a tweak. Prefix expansion is a fallback for
    // autocomplete, not an equal-weight alternative to matching what was typed,
    // so evidence is discounted by how much of the term is the user's own
    // input. Squared, so a term twice as long as the query keeps a quarter of
    // its weight. Without it "Prahatice" — a real OSM name variant — outscored
    // "Praha" and Prachatice came back as the top hit for the capital.
    //
    // There is deliberately no separate exact-term bonus on top: completeness
    // is already exactly 1 when the term equals the query, so a bonus would
    // double-count it, and the extra factor is paid for by the *legitimate*
    // prefix match. That is what put a shop branded "Warsz" above Warszawa.
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
 * Finds a house number inside an anchor's address run.
 *
 * The run is sorted by the number's leading integer, so this is a binary search
 * rather than a scan of what can be thousands of addresses on one street. An
 * exact string match wins; failing that the numeric match is accepted, so
 * "Pražská 248" finds the address written "248/39" — Czech addresses carry two
 * numbers and users type either.
 *
 * The caller needs to know which kind of match it got. Typing the full Czech
 * "248/39" should surface the one street that actually has that composed
 * number, not the dozens that merely have a 248.
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

function anchorResult(a: Artifact, id: number, score: number): GeocodeResult {
  const flags = a.anchorFlags[id]!;
  const code = layerOf(flags);
  const layer = code === LAYER_PLACE ? 'place' : code === LAYER_POI ? 'poi' : 'street';
  const category = code === LAYER_POI ? a.strings.get(a.anchorCat[id]!) : undefined;
  return {
    id: `anchor:${id}`,
    layer,
    name: a.strings.get(a.anchorName[id]!),
    locality: a.strings.get(a.anchorLocal[id]!),
    country: a.countryByID[a.anchorCountry[id]!] ?? '',
    ...(category ? { category } : {}),
    lat: toDeg(a.anchorLat[id]!),
    lon: toDeg(a.anchorLon[id]!),
    score,
  };
}

function addressResult(
  a: Artifact, addrIdx: number, anchorID: number, score: number,
): GeocodeResult {
  return {
    id: `addr:${addrIdx}`,
    layer: 'address',
    name: a.strings.get(a.anchorName[anchorID]!),
    locality: a.strings.get(a.anchorLocal[anchorID]!),
    houseNumber: a.strings.get(a.addrNum[addrIdx]!),
    country: a.countryByID[a.anchorCountry[anchorID]!] ?? '',
    lat: toDeg(a.addrLat[addrIdx]!),
    lon: toDeg(a.addrLon[addrIdx]!),
    score,
  };
}

/**
 * An anchor's own name and locality, folded into tokens.
 *
 * Not stored in the artifact: only the few hundred candidates that survive
 * coarse ranking need it, so computing it lazily is cheaper than several MB of
 * index. Memoized because popular anchors recur across queries.
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
 * How well an anchor's own name and locality explain the query.
 *
 * An anchor is indexed on more than its name: a POI carries its street, city
 * and postcode as searchable tokens too. Scoring on name *length* alone
 * therefore credits matches that never touched the name — a railway station
 * named "Lednice" standing at Nádražní 1 scored full marks for the query
 * "Nadrazni" and, with a station's importance prior, outranked every actual
 * street of that name in the country.
 *
 * So two things are measured:
 *
 *   explained  — the share of query tokens found in the name (full credit) or
 *                the locality (partial). Adding a city to a query should help,
 *                not dilute, so locality counts; matching neither barely counts
 *                at all.
 *   nameUsed   — the share of the anchor's own name the query accounted for,
 *                which is what keeps "Prazska" from tying with "Nova Prazska".
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
 * How many candidates survive coarse scoring, per layer.
 *
 * Per layer, not overall, and that matters. The coarse pass can only rank on
 * the importance prior, which spans 1.0 for a street to 7.0 for an airport —
 * so a single overall cut deletes the lowest-prior layer wholesale whenever a
 * term has more high-prior postings than the budget. Measured: the term
 * "nadrazni" has 1,136 postings, 424 of them POIs, and the Nádražní in Brno
 * came 427th and was discarded on every query, proximity included, because 424
 * stations and museums outranked all 710 streets before anything looked at
 * whether the query matched a name.
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

  // Stage 1: coarse ranking, to cut the candidate set down to something worth
  // doing real work on. A query like "Prazska" matches hundreds of streets
  // nationwide; scoring all of them precisely would be wasted effort.
  //
  // The importance prior has to be applied HERE, not only in the rerank. The
  // term "praha" has 3,665 postings that all share one text weight — every
  // street whose locality is Praha — so ranking on text alone leaves the top
  // 400 an arbitrary slice of a 3,665-way tie, and Praha itself falls out of
  // it. Multiplying by the prior first is one array read and costs nothing.
  const byLayer: { id: number; text: number; score: number }[][] = [[], [], []];
  for (const [id, text] of scored) {
    const flags = a.anchorFlags[id]!;
    if (wantCountry !== undefined && a.anchorCountry[id] !== wantCountry) continue;
    let s = text * a.anchorScore[id]!;
    // Proximity biases the coarse pass too, for the same reason the prior
    // does: "nadrazni" names 651 Czech streets sharing one text weight and one
    // prior, so without it the surviving slice of that tie is arbitrary and
    // the one next to the query point may not be in it.
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
      // and POIs share one flat prior, so without this the hundreds of streets
      // called "Unter den Linden" are indistinguishable and the winner is
      // whichever the sort happened to leave on top — an Austrian hamlet, as it
      // turned out, rather than Berlin. Damped hard: it breaks ties between
      // equally good name matches, it does not override a better one.
      score *= 1 + a.localityScore[a.anchorLocal[id]!]! / 10;
    }

    // Resolve the house number now, not after truncating to `limit`: an anchor
    // that actually has the requested number is far more relevant than one that
    // merely shares a name, and it may sit well down the coarse ranking.
    let addrIdx: number | null = null;
    if (parsed.houseNumber !== null) {
      const hit = findHouseNumber(a, id, parsed.houseNumber);
      if (hit === null) {
        score *= 0.4; // the street exists, the number does not
      } else {
        addrIdx = hit.index;
        // An exact match on the written number is a much stronger signal than
        // a numeric one. Czech addresses carry two numbers, so "248/39" matches
        // dozens of streets numerically but usually only one exactly; the one
        // the user actually described should come first.
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
 * Collapses results that name the same real-world thing.
 *
 * One place is routinely several OSM features: Karlův most is mapped as an
 * attraction more than once along its length, and a tram stop is a node per
 * direction. Returning all of them spends the caller's result slots on one
 * answer. Build-time deduplication cannot fix this — the features are hundreds
 * of metres apart, and widening the merge radius that far would fold together
 * genuinely distinct shops of the same chain — so it is a presentation concern
 * and belongs here.
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

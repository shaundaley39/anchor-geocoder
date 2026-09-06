/**
 * Scoring a candidate anchor against a query, and bounding what it could score.
 *
 * The split that matters here is cheap versus exact. `cheapScore` is array
 * reads only, so it can be applied to every candidate; `relevance` decodes and
 * folds an anchor's names, so it cannot. `maxRelevance` bridges them: a ceiling
 * on the exact score computable from the cheap data, which is what lets the
 * search stop early without ever discarding a candidate that could have won.
 */
import { type Artifact, layerOf, toDeg, LAYER_PLACE, ALT_SEP } from './artifact.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';
import { haversineMetres } from './geometry.js';
import type { ParsedQuery } from './query.js';
import { resolveHouseNumber, HOUSE_EXACT } from './housenumber.js';

/** The part of a request that changes a score rather than filtering results. */
export interface RankingOptions {
  /** Bias results toward this point. */
  proximity?: { lat: number; lon: number };
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
export function relevance(a: Artifact, id: number, queryTokens: string[]): number {
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
export function maxRelevance(a: Artifact, id: number, queryLen: number): number {
  const n = a.anchorNameTokens[id]! || 1;
  const nameUsed = Math.min(queryLen / n, 1);
  const base = 0.1 + 0.9 * nameUsed;
  // Only an equal-length name can match exactly; n is the shortest variant, so
  // a longer one could still equal queryLen — hence >= rather than ===.
  return base * base * (queryLen >= n ? 2.5 : 1);
}

/** The ceiling when the anchor's name length is unknown. */
const MAX_RELEVANCE = 2.5;

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
 * Everything the cheap pass can compute without decoding a single string.
 *
 * These are all array reads, so they cost the same for every candidate and can
 * be applied to all of them.
 */
export function cheapScore(
  a: Artifact, id: number, text: number, opts: RankingOptions,
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
 * The ceiling a candidate is given in the search, exposed so tests can assert
 * admissibility: no candidate's final score may exceed its bound.
 */
export function scoreBound(
  a: Artifact, id: number, text: number, hasHouseNumber: boolean,
  queryLen: number, opts: RankingOptions = {},
): number {
  return cheapScore(a, id, text, opts) *
    maxRelevance(a, id, queryLen) * (hasHouseNumber ? HOUSE_EXACT : 1);
}

/** The exact final score, as the search would compute it. */
export function scoreExact(
  a: Artifact, id: number, text: number, parsed: ParsedQuery,
  opts: RankingOptions = {},
): number {
  const score = cheapScore(a, id, text, opts) * relevance(a, id, parsed.nameTokens);
  if (parsed.houseNumber === null) return score;
  return score * resolveHouseNumber(a, id, parsed.houseNumber).factor;
}

/**
 * Scoring an anchor against a query.
 *
 * `cheapScore` is array reads, so every candidate can afford it. `relevance`
 * decodes and folds the anchor's names, so only a few hundred can.
 * `maxRelevance` is the ceiling on `relevance` computable from cheap data
 * alone, so the search can stop early without losing a winner.
 */
import { type Artifact, layerOf, toDeg, LAYER_PLACE, ALT_SEP } from './artifact.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';
import { haversineMetres } from './geometry.js';
import type { ParsedQuery } from './query.js';
import { resolveHouseNumber, HOUSE_EXACT } from './housenumber.js';

/** The request fields that change a score rather than filter results. */
export interface RankingOptions {
  /** Bias results toward this point. */
  proximity?: { lat: number; lon: number };
}

/**
 * An anchor's name and locality as tokens. Memoized rather than stored in the
 * artifact: only reranked candidates need it, so shipping it would cost several
 * MB for nothing.
 */
interface AnchorTokens {
  /** Canonical name first, then each alternate, folded separately. */
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
 * First token matching `q` that `used` has not already claimed, or -1.
 *
 * Claiming makes this a multiset match. Without it "Praha Praha Praha" counted
 * three matches against the one-token name "Praha" and outscored "Praha"
 * itself. "Baden Baden" still finds both tokens of "Baden-Baden".
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
 * Anchors are indexed on more than their name: a POI carries its street and
 * city too. Scoring on name length alone therefore credits matches that never
 * touched the name, and a station called "Lednice" at Nádražní 1 beat every
 * street named Nádražní. Two quantities instead: how much of the query the
 * name explains (locality at partial credit, so adding a city helps rather
 * than dilutes), and how much of the name the query used.
 */
export function relevance(a: Artifact, id: number, queryTokens: string[]): number {
  const { names, locality } = anchorTokens(a, id);
  if (names.length === 0) return 0.05;

  // Best variant wins. Scoring only the canonical name made exonyms unrankable:
  // "prague" is not a token of "Praha", so the query looked like it had matched
  // nothing but context and "Prague College" won. Merging the variants into one
  // bag is also wrong: Kraków's 26 alternate names would read as one very long
  // name, so the better documented a place is the worse it scores.
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

    // Never zero: a POI standing on the queried street is a weak but legitimate
    // answer, and should rank last rather than vanish.
    const explained = Math.max(
      (inName + 0.6 * inLocality) / queryTokens.length, 0.05,
    );
    // At most 1 already, since `claim` consumes each name token once. Clamped
    // anyway because maxRelevance depends on it.
    const nameUsed = Math.min(inName / name.length, 1);
    const base = explained * (0.1 + 0.9 * nameUsed);

    // Squared: a partial name match is a weaker signal than raw token overlap
    // suggests, and the priors it competes against span an order of magnitude.
    let score = base * base;

    // Every query token in the name, every name token used. Without this bonus
    // an exactly matched street ("Nádražní", prior 1.0) loses to a partial match
    // on a school "ZŠ Nádražní" (1.8) or a suburb "Nádražní Předměstí" (2.5).
    if (inName === name.length && inName === queryTokens.length) score *= 2.5;

    if (score > best) best = score;
  }
  return best || 0.05;
}

/**
 * The most `relevance` could return, without folding the name to find out.
 *
 * `relevance` is `explained * (0.1 + 0.9 * nameUsed)`, squared, times 2.5 when
 * the name matches exactly. `explained` is at most 1, since a query token
 * counts toward the name or the locality but never both. So a q-token query
 * uses at most `min(q, n) / n` of an n-token name, and only n = q can match
 * exactly. The artifact stores n for the shortest variant, which maximises both
 * terms, so this is a true ceiling.
 *
 * Tightness matters more than soundness here. Bounding by the global 2.5 is
 * sound and useless: for "Praha" it claims each of 9,496 candidates might be an
 * exact match, when most are three-word POIs merely located in Praha. This puts
 * them at 0.16, and pruning starts working.
 */
export function maxRelevance(a: Artifact, id: number, queryLen: number): number {
  const n = a.anchorNameTokens[id]! || 1;
  const nameUsed = Math.min(queryLen / n, 1);
  const base = 0.1 + 0.9 * nameUsed;
  // >= not ===: n is the shortest variant, so a longer one could still be an
  // exact-length match.
  return base * base * (queryLen >= n ? 2.5 : 1);
}

/**
 * Distance decay for `proximity`: ~2x at the point, ~1.5x at 50km, tending to
 * 1x. Never zero, so proximity reorders rather than filters, and a distant
 * exact match still beats a nearby poor one.
 */
function proximityBoost(
  p: { lat: number; lon: number }, a: Artifact, id: number,
): number {
  const d = haversineMetres(p.lat, p.lon, toDeg(a.anchorLat[id]!), toDeg(a.anchorLon[id]!));
  return 1 + 1 / (1 + d / 50_000);
}

/** Everything scorable without decoding a string, so affordable on every candidate. */
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
    // an Austrian hamlet. Damped hard: it breaks ties, nothing more.
    s *= 1 + a.localityScore[a.anchorLocal[id]!]! / 10;
  }
  if (opts.proximity) s *= proximityBoost(opts.proximity, a, id);
  return s;
}

/** The ceiling the search gives a candidate. Exported so tests can assert
 * that no candidate's real score exceeds it. */
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

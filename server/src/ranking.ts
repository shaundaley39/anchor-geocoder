/**
 * Scoring an anchor against a query.
 *
 * `cheapScore` is array reads, so every candidate can afford it. `relevance`
 * folds the anchor's names, so only a few hundred can. `maxRelevance` is the
 * ceiling on `relevance` computable from cheap data alone, which is how the
 * search stops early without losing a winner.
 */
import { type Artifact, layerOf, toDeg, LAYER_PLACE, LAYER_STREET, ALT_SEP } from './artifact.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';
import { haversineMetres } from './geometry.js';
import type { ParsedQuery } from './query.js';
import { resolveHouseNumber, HOUSE_EXACT } from './housenumber.js';

/** How much a match on an alias is worth against a match on the canonical name. */
const ALIAS_DISCOUNT = 0.9;

/** The request fields that change a score rather than filter results. */
export interface RankingOptions {
  proximity?: { lat: number; lon: number };
}

/** Memoized on the artifact rather than stored in it: only reranked candidates
 * need it, so shipping it would cost several MB for nothing. */
interface AnchorTokens {
  /** Canonical name first, then each alternate, folded separately. */
  names: string[][];
  locality: string[];
}

function anchorTokens(a: Artifact, id: number): AnchorTokens {
  const hit = a.tokenCache.get(id) as AnchorTokens | undefined;
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
  if (a.tokenCache.size < 200_000) a.tokenCache.set(id, t);
  return t;
}

/**
 * Claiming makes this a multiset match. Without it "Praha Praha Praha" counted
 * three matches against the one-token name "Praha" and outscored "Praha"
 * itself. "Baden Baden" still finds both tokens of "Baden-Baden".
 *
 * `forms` is one query token's spellings. Retrieval already treats them as one
 * token, and so must scoring: an anchor found through the digraph spelling of
 * its own name would otherwise explain none of the query and score as if the
 * match were an accident.
 */
function claim(tokens: string[], used: boolean[], forms: string[], isLast: boolean): number {
  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    const t = tokens[i]!;
    for (const q of forms) {
      if (isLast ? t.startsWith(q) : t === q) return i;
    }
  }
  return -1;
}

/**
 * How well an anchor's name and locality explain the query.
 *
 * Anchors are indexed on more than their name — a POI carries its street and
 * city too — so scoring on name length alone credits matches that never touched
 * the name, and a station called "Lednice" at Nádražní 1 beat every street
 * named Nádražní. Two quantities instead: how much of the query the name
 * explains, locality at partial credit so adding a city helps rather than
 * dilutes; and how much of the name the query used.
 */
export function relevance(a: Artifact, id: number, queryVariants: string[][]): number {
  const { names, locality } = anchorTokens(a, id);
  if (names.length === 0) return 0.05;

  // Best variant, not the canonical one and not all of them merged. Canonical
  // alone makes exonyms unrankable, since "prague" is not a token of "Praha" and
  // "Prague College" won. Merged, Kraków's 26 alternate names read as one very
  // long name, so the better documented a place is the worse it scores.
  let best = 0;
  for (let v = 0; v < names.length; v++) {
    const name = names[v]!;
    if (name.length === 0) continue;

    let inName = 0;
    let inLocality = 0;
    const nameUsedTokens: boolean[] = new Array(name.length).fill(false);
    const locUsedTokens: boolean[] = new Array(locality.length).fill(false);
    for (let i = 0; i < queryVariants.length; i++) {
      const q = queryVariants[i]!;
      const isLast = i === queryVariants.length - 1;
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
      (inName + 0.6 * inLocality) / queryVariants.length, 0.05,
    );
    // Already at most 1, since `claim` consumes each name token once. Clamped
    // anyway, because maxRelevance is only sound if it is.
    const nameUsed = Math.min(inName / name.length, 1);
    const base = explained * (0.1 + 0.9 * nameUsed);

    // Squared: a partial name match is a weaker signal than raw token overlap
    // suggests, and the priors it competes against span an order of magnitude.
    let score = base * base;

    // Without this bonus an exactly matched street ("Nádražní", prior 1.0) loses
    // to a partial match on a school "ZŠ Nádražní" (1.8) or a suburb "Nádražní
    // Předměstí" (2.5).
    if (inName === name.length && inName === queryVariants.length) score *= 2.5;

    // An alias is weaker evidence than the name a feature actually goes by, so
    // matching one is discounted. Small on purpose: exonyms are aliases, and
    // scoring them low is what made "Prague" unrankable. But without any
    // discount an exact hit on a third alt_name beats a prefix hit on something
    // far more important — a Polish lake carrying "Warsz" as an alias outranked
    // Warszawa on a 0.14% margin.
    if (v > 0) score *= ALIAS_DISCOUNT;

    if (score > best) best = score;
  }
  return best || 0.05;
}

/**
 * The most `relevance` could return, without folding the name to find out.
 *
 * `explained` is at most 1, since a query token counts toward the name or the
 * locality but never both. So a q-token query uses at most `min(q, n) / n` of an
 * n-token name, and only n = q can match exactly. The artifact stores n for the
 * shortest variant, which maximises both terms, so this is a true ceiling.
 *
 * A sound bound is easy; a tight one is the work. The global 2.5 is sound and
 * useless: for "Praha" it claims each of 9,496 candidates might be an exact
 * match, when most are three-word POIs merely located there. This puts them at
 * 0.16, and pruning starts working.
 */
export function maxRelevance(a: Artifact, id: number, queryLen: number): number {
  const n = a.anchorNameTokens[id]! || 1;
  const nameUsed = Math.min(queryLen / n, 1);
  const base = 0.1 + 0.9 * nameUsed;
  // >= not ===: n is the shortest variant, so a longer one could still be
  // exactly queryLen tokens.
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

/** Scorable without decoding a string, so affordable on every candidate. */
export function cheapScore(
  a: Artifact, id: number, text: number, opts: RankingOptions,
): number {
  let s = text * a.anchorScore[id]!;
  const layer = layerOf(a.anchorFlags[id]!);
  if (layer === LAYER_PLACE) {
    // A bare settlement name is more often the intent than a POI sharing it.
    s *= 1.25;
  } else if (layer === LAYER_STREET) {
    // A street inherits the standing of the place it runs through. Streets all
    // share one flat prior, so without this "Unter den Linden" resolved to an
    // Austrian hamlet.
    //
    // Not applied to POIs, and that is a judgement rather than an oversight.
    // "Is in an important settlement" is a fair proxy for a street's importance
    // and a bad one for a landmark's, because landmarks are frequently in no
    // settlement at all. Once POI localities were assigned spatially the proxy
    // began to dominate and three Czech rocks named Matterhorn beat the Swiss
    // one 194 to 132 — identical category priors, so the boost was the only
    // discriminator, and the real mountain has no village.
    //
    // Treating an absent locality as middling rather than zero was the obvious
    // middle and is wrong in both directions: it breaks Barcelona's Sagrada
    // Família again, and it promotes a shop chain over the village sharing its
    // name — which is backwards, since a village is the better answer to a bare
    // "Zabka" with no locality context. Distinguishing landmarks from namesakes
    // wants per-feature importance, a Wikidata or pagerank join; distinguishing
    // a nearby branch from a distant village wants the caller's viewport.
    s *= 1 + a.localityScore[a.anchorLocal[id]!]! / 10;
  }
  if (opts.proximity) s *= proximityBoost(opts.proximity, a, id);
  return s;
}

/** Exported so tests can assert no candidate's real score exceeds its ceiling. */
export function scoreBound(
  a: Artifact, id: number, text: number, hasHouseNumber: boolean,
  queryLen: number, opts: RankingOptions = {},
): number {
  return cheapScore(a, id, text, opts) *
    maxRelevance(a, id, queryLen) * (hasHouseNumber ? HOUSE_EXACT : 1);
}

/** The final score, as the search would compute it. The bound's test oracle. */
export function scoreExact(
  a: Artifact, id: number, text: number, parsed: ParsedQuery,
  opts: RankingOptions = {},
): number {
  const score = cheapScore(a, id, text, opts) * relevance(a, id, parsed.nameVariants);
  if (parsed.houseNumber === null) return score;
  return score * resolveHouseNumber(a, id, parsed.houseNumber).factor;
}

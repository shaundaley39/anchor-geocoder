/** Finding a house number in an anchor's address run, and what the match is worth. */
import type { Artifact } from './artifact.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';

/** Where a house number was found, and how good the match was. */
export interface HouseNumberMatch {
  index: number;
  /** True when the stored number folds identically to what the user typed. */
  exact: boolean;
}

/**
 * Binary search over an address run, which is sorted by the number's leading
 * integer.
 *
 * An exact string match wins, but a numeric one is accepted: Czech addresses
 * carry two numbers ("248/39") and users type either. The caller needs to know
 * which it got, since an exact match should outrank the dozens sharing a 248.
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
 * Score multipliers by grade of match. HOUSE_EXACT is the largest single
 * multiplier in the whole score, so it is the ceiling the search bound allows for.
 */
export const HOUSE_EXACT = 18;
export const HOUSE_NUMERIC = 6;
/** The street exists, the number does not. Demoted, not discarded. */
export const HOUSE_MISSING = 0.4;

/** Where the number landed, and the factor its grade of match earns. */
export interface HouseResolution {
  addrIdx: number | null;
  factor: number;
}

/** The one place a house number becomes a score factor, so the search loop and
 * the bound's test oracle cannot drift apart. */
export function resolveHouseNumber(
  a: Artifact, anchorID: number, wanted: string,
): HouseResolution {
  const hit = findHouseNumber(a, anchorID, wanted);
  if (hit === null) return { addrIdx: null, factor: HOUSE_MISSING };
  return { addrIdx: hit.index, factor: hit.exact ? HOUSE_EXACT : HOUSE_NUMERIC };
}

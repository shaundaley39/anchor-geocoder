/** Finding a house number in an anchor's address run, and what it is worth. */
import type { Artifact } from './artifact.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';

export interface HouseNumberMatch {
  index: number;
  /** The stored number folds identically to what was typed, not merely to the
   * same integer. */
  exact: boolean;
}

/**
 * A numeric match is accepted as well as an exact one, because Czech addresses
 * carry two numbers ("248/39") and users type either. The caller is told which
 * it got: an exact match should outrank the dozens merely sharing a 248.
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

/** The largest single multiplier in the whole score, so also the ceiling the
 * search bound has to allow for. */
export const HOUSE_EXACT = 18;
export const HOUSE_NUMERIC = 6;
/** The street exists, the number does not. Demoted rather than discarded. */
export const HOUSE_MISSING = 0.4;

export interface HouseResolution {
  addrIdx: number | null;
  factor: number;
}

/** The only place a house number becomes a score factor, so the search loop and
 * the bound's test oracle cannot drift apart. */
export function resolveHouseNumber(
  a: Artifact, anchorID: number, wanted: string,
): HouseResolution {
  const hit = findHouseNumber(a, anchorID, wanted);
  if (hit === null) return { addrIdx: null, factor: HOUSE_MISSING };
  return { addrIdx: hit.index, factor: hit.exact ? HOUSE_EXACT : HOUSE_NUMERIC };
}

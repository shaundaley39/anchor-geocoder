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
 * The number after the last slash in `blob[from, to)`, or -1 when there is not
 * one.
 *
 * Read off the bytes in place rather than from a decoded string, and without
 * slicing one either: this runs over every address on a street, the answer is
 * no for all but one of them, and an allocation per address costs more than the
 * comparison does.
 */
function orientationOf(blob: Uint8Array, from: number, to: number): number {
  let slash = -1;
  for (let i = to - 1; i >= from; i--) {
    if (blob[i] === 0x2f) { slash = i; break; }
  }
  if (slash < 0) return -1;
  let n = 0;
  let digits = 0;
  for (let i = slash + 1; i < to; i++) {
    const c = blob[i]!;
    if (c < 0x30 || c > 0x39) break;
    n = n * 10 + (c - 0x30);
    if (++digits > 9) return -1; // not a house number, whatever it is
  }
  return digits === 0 ? -1 : n;
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
  if (numericMatch !== null) return { index: numericMatch, exact: false };

  // Nothing on this street leads with the number, so try it as the second half
  // of a composed one. "334/36" is a conscription number and an orientation
  // number: 334 identifies the building within the municipality, 36 is what is
  // on the door plate and on the envelope, and either is a valid way to ask.
  // The run is sorted on the first, so the second is reachable only by looking.
  //
  // A scan, but a cheap one and a last resort: runs average seventeen
  // addresses, the comparison never decodes a string, and it happens only where
  // the binary search above came back with nothing.
  const blob = a.strings.bytes;
  const bounds = a.strings.bounds;
  for (let i = start; i < start + count; i++) {
    const id = a.addrNum[i]!;
    if (orientationOf(blob, bounds[id]!, bounds[id + 1]!) === numeric) {
      // Not exact: "36" is a partial reference to "334/36", the way "334" is.
      return { index: i, exact: false };
    }
  }
  return null;
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

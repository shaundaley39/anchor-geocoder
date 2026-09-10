/** Finding a house number in an anchor's address run, and what it is worth. */
import type { Artifact } from './artifact.js';
import { tokens as foldTokens } from '@anchor-geocoder/core';

/**
 * How the typed number reached the address it reached.
 *
 * Czechia and Slovakia number a building twice. "334/36" is conscription
 * number 334, which identifies the building within the municipality, and
 * orientation number 36, which is what is on the door plate and on the
 * envelope. Two of the three ways of writing that are addresses: the whole
 * thing, and the orientation number alone - "Milady Horákové 36" is complete
 * and unambiguous, and is how the address is usually written. The conscription
 * number alone is not an address. It still identifies the building, so it is
 * answered rather than refused, but it ranks below the two forms that are.
 *
 * The exception, and it is a common one: a building with no orientation number
 * has only a conscription number, which is then the whole address. Those are
 * stored as a bare number and match exactly, so they never reach the
 * conscription case.
 *
 * Elsewhere a slash separates something else - Polish "5/7" is building 5, flat
 * 7 - so the orientation reading is scoped to the two countries whose addresses
 * are built this way.
 */
export type HouseMatch =
  /** What was typed is what is stored, once folded. */
  | 'exact'
  /** The orientation number, which is a complete address on its own. */
  | 'orientation'
  /** Same leading integer, different string: "36" against a stored "36a". */
  | 'numeric'
  /** The conscription number alone: the right building, not an address. */
  | 'conscription';

export interface HouseNumberMatch {
  index: number;
  how: HouseMatch;
}

const COMPOSED_COUNTRIES = new Set(['cz', 'sk']);

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

/** Whether the stored number has two halves at all. */
function composed(blob: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (blob[i] === 0x2f) return true;
  return false;
}

/**
 * The first run of digits anywhere in the string, or -1.
 *
 * Mirrors `LeadingInt` in the Go build, which is what `addr_sortkey` holds, so
 * a number whose digits do not start the string is still reachable: "ev.223"
 * is a Czech evidenční number and sorts under 223. `parseInt` returns NaN for
 * those and used to make them unfindable.
 */
function leadingInt(s: string): number {
  const m = /\d+/.exec(s);
  return m === null ? -1 : Number(m[0]);
}

/** First index in the run whose leading integer is `n`, or the run's end. */
function lowerBound(a: Artifact, start: number, end: number, n: number): number {
  let lo = start;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a.addrSortKey[mid]! < n) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The address on this street that the typed number refers to, and how well.
 *
 * The run is sorted on the leading integer of each stored number, so the
 * conscription half is a binary search and the orientation half is not. The
 * orientation half is looked for first all the same, on a Czech or Slovak
 * street: it is the half people write, and preferring the sorted one would
 * answer "Bratislavská 6" with whichever building happens to be conscription
 * number 6.
 */
export function findHouseNumber(
  a: Artifact, anchorID: number, wanted: string,
): HouseNumberMatch | null {
  const start = a.anchorAddrStart[anchorID]!;
  const count = a.anchorAddrCount[anchorID]!;
  if (count === 0) return null;
  const end = start + count;

  const leading = leadingInt(wanted);
  if (leading < 0) return null;

  const blob = a.strings.bytes;
  const bounds = a.strings.bounds;
  const wantedFold = foldTokens(wanted).join(' ');

  // Exactly what was typed, if the street has it.
  let numeric = -1;
  let numericComposed = false;
  for (let i = lowerBound(a, start, end, leading); i < end && a.addrSortKey[i] === leading; i++) {
    const id = a.addrNum[i]!;
    if (foldTokens(a.strings.get(id)).join(' ') === wantedFold) {
      return { index: i, how: 'exact' };
    }
    if (numeric < 0) {
      numeric = i;
      numericComposed = composed(blob, bounds[id]!, bounds[id + 1]!);
    }
  }

  // The orientation number being asked for: the half after the slash where the
  // query wrote both, and the number itself where it wrote one.
  const slash = wanted.indexOf('/');
  const asked = slash < 0 ? leading : leadingInt(wanted.slice(slash + 1));
  const czsk = COMPOSED_COUNTRIES.has(a.countryByID[a.anchorCountry[anchorID]!] ?? '');

  if (czsk && asked >= 0) {
    // Both halves were typed and the building is stored under the orientation
    // number alone, which is what OSM has wherever the conscription number was
    // never tagged. Same building, so still a whole address.
    if (slash >= 0) {
      for (let i = lowerBound(a, start, end, asked); i < end && a.addrSortKey[i] === asked; i++) {
        const id = a.addrNum[i]!;
        if (!composed(blob, bounds[id]!, bounds[id + 1]!)) {
          return { index: i, how: 'orientation' };
        }
      }
    }
    // A scan, because the run is not sorted on this half. Cheap: runs average
    // seventeen addresses and the comparison never decodes a string.
    //
    // A bare number is the orientation number and names the building outright.
    // Where both halves were typed and only this one matches, the query named
    // some other building's conscription number, so it is a partial match and
    // must not outrank an exact one on another street.
    for (let i = start; i < end; i++) {
      const id = a.addrNum[i]!;
      if (orientationOf(blob, bounds[id]!, bounds[id + 1]!) === asked) {
        return { index: i, how: slash < 0 ? 'orientation' : 'numeric' };
      }
    }
  }

  if (numeric >= 0) {
    return { index: numeric, how: czsk && numericComposed ? 'conscription' : 'numeric' };
  }

  // Outside those two countries the second half of a composed number is not
  // the building - Polish "12/5" is flat 5 in building 12 - so there is no
  // fallback to it. Tried and measured: matching it changed the round trip
  // over the whole index by nothing at all (869 of 885 either way) and
  // answered "Marszałkowska 12/5" with "Marszałkowska 3/5", which is a
  // different building. The street on its own is the more honest answer.
  return null;
}

/** The largest single multiplier in the whole score, so also the ceiling the
 * search bound has to allow for. */
export const HOUSE_EXACT = 18;
export const HOUSE_NUMERIC = 6;
/** The right building, written a way the country's addressing does not use. */
export const HOUSE_CONSCRIPTION = 3;
/** The street exists, the number does not. Demoted rather than discarded. */
export const HOUSE_MISSING = 0.4;

const FACTOR: Record<HouseMatch, number> = {
  exact: HOUSE_EXACT,
  orientation: HOUSE_EXACT,
  numeric: HOUSE_NUMERIC,
  conscription: HOUSE_CONSCRIPTION,
};

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
  return { addrIdx: hit.index, factor: FACTOR[hit.how] };
}

/**
 * Splitting a raw query string into the parts that search differently: a name
 * to match against the index, and a house number to resolve inside whatever
 * that name turns out to be.
 */
import { tokens as foldTokens } from '@anchor-geocoder/core';

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

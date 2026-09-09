/** Splitting a query into a name to search on and a house number to resolve
 * inside whatever that name turns out to be. */
import { tokens as foldTokens, queryVariants } from '@anchor-geocoder/core';

export interface ParsedQuery {
  nameTokens: string[];
  /**
   * Per name token, the spellings worth looking up, the token itself first.
   * German writes an umlaut two ways and ß two more, so a token can name more
   * than one term; retrieval ORs within a position and still ANDs across them.
   */
  nameVariants: string[][];
  houseNumber: string | null;
}

interface Token { tok: string; forms: string[] }

function reading(toks: Token[], houseNumber: string | null): ParsedQuery {
  return {
    nameTokens: toks.map((t) => t.tok),
    nameVariants: toks.map((t) => t.forms),
    houseNumber,
  };
}

/**
 * Candidate readings, best guess first; the caller takes the first that finds
 * anything. A trailing or medial digit-leading token is a house number, never a
 * leading one — "3 Maja" is a common Polish street name.
 */
export function parseQuery(raw: string): ParsedQuery[] {
  const toks = foldTokens(raw);
  // Variant expansion never moves a token boundary; the guard is for safety,
  // not because the lists are expected to disagree.
  const forms = queryVariants(raw);
  const all: Token[] = toks.map((tok, i) => ({
    tok, forms: forms.length === toks.length ? forms[i]! : [tok],
  }));
  if (all.length <= 1) return [reading(all, null)];

  const whole = reading(all, null);
  const last = all[all.length - 1]!.tok;

  if (/^\d/.test(last)) {
    const head = all.slice(0, -1);
    // Czech numbers fold to two tokens ("248/39" -> ["248","39"]).
    const prev = head[head.length - 1]?.tok;
    if (head.length > 1 && prev !== undefined && /^\d+$/.test(prev)) {
      return [reading(head.slice(0, -1), `${prev}/${last}`), whole];
    }
    return [reading(head, last), whole];
  }

  // "Via Roma 1 Torino": much of the region writes the number between street
  // and city, which a trailing-only rule misses entirely.
  for (let i = 1; i < all.length - 1; i++) {
    const tok = all[i]!.tok;
    if (!/^\d/.test(tok)) continue;
    const next = all[i + 1]!.tok;
    if (/^\d+$/.test(tok) && /^\d/.test(next) && i + 1 < all.length - 1) {
      return [
        reading([...all.slice(0, i), ...all.slice(i + 2)], `${tok}/${next}`),
        whole,
      ];
    }
    return [reading([...all.slice(0, i), ...all.slice(i + 1)], tok), whole];
  }
  return [whole];
}

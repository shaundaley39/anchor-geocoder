import type { Artifact } from './artifact.js';

/**
 * Tokens shorter than this are left alone. A 4-character token has hundreds of
 * neighbours at edit distance 1 and correcting it is guesswork: "brno" would
 * happily become "brna", "brod" or "bruno".
 */
const MIN_LENGTH = 5;

/**
 * Ceiling on candidates examined per token. The prefix half of a short token is
 * only two characters, which can span a large slice of the dictionary; the
 * length filter rejects most of them for the price of a subtraction, but the
 * cap keeps the worst case bounded.
 */
const MAX_CANDIDATES = 40_000;

/** Levenshtein distance <= 1, without building a matrix for a bound of one. */
export function withinOneEdit(q: string, t: string): boolean {
  const lq = q.length;
  const lt = t.length;
  if (Math.abs(lq - lt) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < lq && j < lt) {
    if (q[i] === t[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    // Substitution advances both; an insertion or deletion advances only the
    // longer side, which is what realigns the rest of the comparison.
    if (lq === lt) { i++; j++; } else if (lq > lt) { i++; } else { j++; }
  }
  return edits + (lq - i) + (lt - j) <= 1;
}

function reverse(s: string): string {
  return [...s].reverse().join('');
}

/**
 * Term ids within one edit of `token`, found without scanning the dictionary.
 *
 * Pigeonhole: a single edit lies wholly in one half of the token, so a term at
 * distance 1 either starts with the token's first half or ends with its second.
 * Both are prefix searches — the second on the reversed dictionary — and both
 * are binary searches the term dictionary already supports.
 */
function neighbours(a: Artifact, token: string): number[] {
  const chars = [...token];
  const half = Math.ceil(chars.length / 2);
  const head = chars.slice(0, half).join('');
  const tail = chars.slice(half).join('');

  const out: number[] = [];
  const seen = new Set<number>();
  let examined = 0;

  const consider = (id: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const term = a.terms.get(id);
    if (Math.abs(term.length - token.length) > 1) return;
    if (withinOneEdit(token, term)) out.push(id);
  };

  const [plo, phi] = a.terms.prefixRange(head);
  for (let t = plo; t < phi && examined < MAX_CANDIDATES; t++, examined++) {
    consider(t);
  }

  const [slo, shi] = a.termsRev.prefixRange(reverse(tail));
  for (let t = slo; t < shi && examined < MAX_CANDIDATES; t++, examined++) {
    consider(a.termRevId[t]!);
  }
  return out;
}

/**
 * The likeliest correction for one token, or null to leave it as typed.
 *
 * Among terms within one edit the most frequent wins, which is the standard
 * spelling-correction prior and the right one here: a typo is far more likely
 * to be a mangled Praha (3,665 postings) than an exact hit on some hamlet
 * spelled almost the same.
 */
export function correctToken(a: Artifact, token: string): string | null {
  if (token.length < MIN_LENGTH) return null;
  if (a.terms.find(token) >= 0) return null; // spelled correctly

  let best = -1;
  let bestPostings = 0;
  for (const id of neighbours(a, token)) {
    const n = a.postOff[id + 1]! - a.postOff[id]!;
    // Ties break on the term itself, so a correction never depends on the
    // dictionary's internal ordering.
    if (n > bestPostings || (n === bestPostings && best >= 0 && a.terms.get(id) < a.terms.get(best))) {
      best = id;
      bestPostings = n;
    }
  }
  return best >= 0 ? a.terms.get(best) : null;
}

/**
 * Corrects each token independently, returning null when nothing changed.
 *
 * Independently, because the alternative is a search over the product of every
 * token's candidates for a path that is almost always the obvious one. A query
 * where two typos only resolve together is beyond what a fallback should cost.
 */
export function correctTokens(a: Artifact, tokens: string[]): string[] | null {
  let changed = false;
  const out = tokens.map((t) => {
    const fixed = correctToken(a, t);
    if (fixed === null) return t;
    changed = true;
    return fixed;
  });
  return changed ? out : null;
}

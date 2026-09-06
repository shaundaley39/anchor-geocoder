import type { Artifact } from './artifact.js';

/**
 * Tokens shorter than this are left alone. A 4-character token has hundreds of
 * neighbours at distance 1, so correcting it is guesswork: "brno" would happily
 * become "brna", "brod" or "bruno".
 */
const MIN_LENGTH = 5;

/**
 * Ceiling on candidates examined per token. The prefix half of a short token is
 * two characters and can span a large slice of the dictionary. The length
 * filter rejects most of those for the price of a subtraction; this bounds the
 * rest.
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
    // Substitution advances both. An insertion or deletion advances only the
    // longer side, which realigns the rest of the comparison.
    if (lq === lt) { i++; j++; } else if (lq > lt) { i++; } else { j++; }
  }
  return edits + (lq - i) + (lt - j) <= 1;
}

function reverse(s: string): string {
  return [...s].reverse().join('');
}

/**
 * Term ids within one edit of `token`, without scanning the dictionary.
 *
 * Pigeonhole: a single edit lies wholly in one half of the token, so a term at
 * distance 1 either starts with the token's first half or ends with its second.
 * Both are prefix searches, the second on the reversed dictionary, and both are
 * binary searches the term dictionary already supports.
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
 * Most frequent wins, the standard spelling prior. A typo is far likelier to be
 * a mangled Praha (3,665 postings) than an exact hit on a hamlet spelled almost
 * the same.
 */
export function correctToken(a: Artifact, token: string): string | null {
  if (token.length < MIN_LENGTH) return null;
  if (a.terms.find(token) >= 0) return null; // spelled correctly

  let best = -1;
  let bestPostings = 0;
  for (const id of neighbours(a, token)) {
    const n = a.postOff[id + 1]! - a.postOff[id]!;
    // Ties break on the term, not on dictionary order.
    if (n > bestPostings || (n === bestPostings && best >= 0 && a.terms.get(id) < a.terms.get(best))) {
      best = id;
      bestPostings = n;
    }
  }
  return best >= 0 ? a.terms.get(best) : null;
}

/**
 * Corrects each token independently, or null when nothing changed.
 *
 * Independently, because the alternative is searching the product of every
 * token's candidates for a combination that is almost always the obvious one.
 * Two typos that only resolve together cost more than a fallback should.
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

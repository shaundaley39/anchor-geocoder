/** The inverted index: name tokens to candidate anchors and their term weights. */
import type { Artifact } from './artifact.js';

/**
 * Unfloored IDF swings 2.4x between a one-posting term and a 16,000-posting one,
 * swamping a 7x difference in importance: "Warsz" surfaced a shop branded
 * "Warsz" above Warszawa. Below a few hundred postings rarity says nothing more
 * about intent, so the curve saturates.
 */
const DF_FLOOR = 500;

function idf(nAnchors: number, postings: number): number {
  return Math.log(1 + nAnchors / (DF_FLOOR + postings));
}

function postings(a: Artifact, termID: number): Uint32Array {
  return a.post.subarray(a.postOff[termID]!, a.postOff[termID + 1]!);
}

/** All tokens but the last match exactly; the last is a prefix, so a half-typed
 * word still matches. */
export function candidates(a: Artifact, nameTokens: string[], maxCandidates: number): Map<number, number> {
  const scores = new Map<number, number>();
  if (nameTokens.length === 0) return scores;

  const nAnchors = a.manifest.num_anchors;
  // Distinct: weights are summed per term, so "Praha Praha" would otherwise
  // collect the same posting's IDF twice and outrank "Praha".
  const complete = [...new Set(nameTokens.slice(0, -1))];
  const last = nameTokens[nameTokens.length - 1]!;

  const lists: Uint32Array[] = [];
  const weights: number[] = [];
  for (const t of complete) {
    const id = a.terms.find(t);
    if (id < 0) return scores; // a required token matches nothing
    const p = postings(a, id);
    lists.push(p);
    weights.push(idf(nAnchors, p.length));
  }

  const [lo, hi] = a.terms.prefixRange(last);
  if (lo >= hi) return scores;

  // Rarity of the prefix as typed, not of whichever expansion an anchor carries.
  // Weighting per expansion made a one-posting term the most valuable thing in
  // the index, and "Warsz" put a shop branded "Warsz" above Warszawa.
  let prefixTotal = 0;
  for (let t = lo; t < hi; t++) prefixTotal += a.postOff[t + 1]! - a.postOff[t]!;
  const prefixIdf = idf(nAnchors, prefixTotal);

  const prefixHits = new Map<number, number>();
  let scanned = 0;
  for (let t = lo; t < hi; t++) {
    const term = a.terms.get(t);
    const p = postings(a, t);

    // How much of the matched term the user typed. Prefix expansion is a
    // fallback, not an equal alternative, so it is discounted squared: without
    // this "Prahatice" outscored "Praha". No separate exact-term bonus, since
    // completeness is already 1 when the term equals the query.
    const completeness = last.length / term.length;
    const w = prefixIdf * completeness * completeness;

    for (const anchor of p) {
      prefixHits.set(anchor, Math.max(prefixHits.get(anchor) ?? 0, w));
    }
    scanned += p.length;
    // A one-letter prefix can span a large slice of the index. The exact-term
    // lists still anchor the result set, so capping here only loses long tail.
    if (scanned > maxCandidates * 20) break;
  }

  if (lists.length === 0) {
    return prefixHits;
  }

  const smallest = lists.reduce((m, l) => (l.length < m.length ? l : m), lists[0]!);
  const membership = lists.map((l) => new Set(l));
  for (const anchor of smallest) {
    const pw = prefixHits.get(anchor);
    if (pw === undefined) continue;
    let total = pw;
    let ok = true;
    for (let i = 0; i < membership.length; i++) {
      if (!membership[i]!.has(anchor)) { ok = false; break; }
      total += weights[i]!;
    }
    if (ok) scores.set(anchor, total);
  }
  return scores;
}

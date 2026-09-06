/**
 * The inverted index: name tokens to candidate anchors and their term weights.
 *
 * This is the coarse half of ranking. It decides *which* anchors are worth
 * looking at and how strong the textual evidence is, without decoding a single
 * string — everything here is posting lists and array arithmetic.
 */
import type { Artifact } from './artifact.js';

/**
 * Smoothing floor on document frequency.
 *
 * Unfloored IDF swings 2.4x between a one-posting term and a 16,000-posting
 * one, which swamps a 7x difference in importance: "Warsz" surfaced a shop
 * branded "Warsz" above Warszawa. Below a few hundred postings, rarity says
 * nothing more about intent, so the curve saturates there.
 */
const DF_FLOOR = 500;

function idf(nAnchors: number, postings: number): number {
  return Math.log(1 + nAnchors / (DF_FLOOR + postings));
}

/** Posting list for a term id. */
function postings(a: Artifact, termID: number): Uint32Array {
  return a.post.subarray(a.postOff[termID]!, a.postOff[termID + 1]!);
}

/**
 * Candidate anchors for the name tokens. All tokens but the last match exactly;
 * the last is a prefix, which is what makes autocomplete work.
 */
export function candidates(a: Artifact, nameTokens: string[], maxCandidates: number): Map<number, number> {
  const scores = new Map<number, number>();
  if (nameTokens.length === 0) return scores;

  const nAnchors = a.manifest.num_anchors;
  // Distinct, because the weights below are summed per term: "Praha Praha"
  // would otherwise collect the same posting's IDF twice and outrank "Praha".
  const complete = [...new Set(nameTokens.slice(0, -1))];
  const last = nameTokens[nameTokens.length - 1]!;

  // Exact terms first: the smallest posting list bounds the intersection.
  const lists: Uint32Array[] = [];
  const weights: number[] = [];
  for (const t of complete) {
    const id = a.terms.find(t);
    if (id < 0) return scores; // a required token matches nothing
    const p = postings(a, id);
    lists.push(p);
    weights.push(idf(nAnchors, p.length));
  }

  // The final token as a prefix: union every term sharing it.
  const [lo, hi] = a.terms.prefixRange(last);
  if (lo >= hi) return scores;

  // What matters is the rarity of the *prefix the user typed*, not of whichever
  // expansion an anchor happens to carry. Weighting per expansion made a
  // one-posting term the most valuable thing in the index — "Warsz" put a shop
  // branded "Warsz" above Warszawa. Summing the range is a walk over offsets.
  let prefixTotal = 0;
  for (let t = lo; t < hi; t++) prefixTotal += a.postOff[t + 1]! - a.postOff[t]!;
  const prefixIdf = idf(nAnchors, prefixTotal);

  const prefixHits = new Map<number, number>();
  let scanned = 0;
  for (let t = lo; t < hi; t++) {
    const term = a.terms.get(t);
    const p = postings(a, t);

    // Completeness: how much of the matched term the user actually typed.
    // Prefix expansion is a fallback, not an equal-weight alternative, so it is
    // discounted — squared, so a term twice as long keeps a quarter of its
    // weight. Without it "Prahatice" outscored "Praha".
    //
    // No separate exact-term bonus: completeness is already 1 when the term
    // equals the query, and double-counting it penalised legitimate prefixes.
    const completeness = last.length / term.length;
    const w = prefixIdf * completeness * completeness;

    for (const anchor of p) {
      prefixHits.set(anchor, Math.max(prefixHits.get(anchor) ?? 0, w));
    }
    scanned += p.length;
    // A one-letter prefix can span a large slice of the index. Cap the work;
    // the exact-term list (scanned first, ordered by selectivity) still anchors
    // the result set.
    if (scanned > maxCandidates * 20) break;
  }

  if (lists.length === 0) {
    return prefixHits;
  }

  // Intersect: an anchor must appear in every exact list and in the prefix set.
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

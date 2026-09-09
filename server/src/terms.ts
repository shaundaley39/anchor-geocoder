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

/**
 * Whether any of a token's posting lists holds `anchor`, by binary search.
 *
 * The lists are written in ascending anchor order, so this needs nothing built
 * first — which is the point. Testing membership by building a `Set` costs the
 * length of the list rather than its logarithm, and the list can be enormous
 * while the answer is tiny: "Rue de la Paix" has three tokens with 1.1M, 2.3M
 * and 1.2M postings and 1,764 results, so it was doing 4.6M insertions to
 * discard 4.6M of them. That query spent 242ms of its 249ms here.
 */
function holds(lists: Uint32Array[], anchor: number): boolean {
  for (const p of lists) {
    let lo = 0;
    let hi = p.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = p[mid]!;
      if (v === anchor) return true;
      if (v < anchor) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  return false;
}

/**
 * All tokens but the last match exactly; the last is a prefix, so a half-typed
 * word still matches.
 *
 * A token arrives as the spellings worth looking up rather than as one string
 * — "Muenchen" must also try `munchen`. The forms of one token are ORed, the
 * tokens themselves still ANDed, and the term weight comes from their combined
 * posting count, so splitting a name across two spellings does not make it look
 * rarer than it is.
 */
export function candidates(a: Artifact, nameVariants: string[][], maxCandidates: number): Map<number, number> {
  const scores = new Map<number, number>();
  if (nameVariants.length === 0) return scores;

  const nAnchors = a.manifest.num_anchors;
  // Distinct: weights are summed per term, so "Praha Praha" would otherwise
  // collect the same posting's IDF twice and outrank "Praha". Keyed on the
  // token as typed, which is the first form, so a word repeated in two
  // spellings still counts once.
  const seenToken = new Set<string>();
  const complete: string[][] = [];
  for (const forms of nameVariants.slice(0, -1)) {
    const typed = forms[0]!;
    if (seenToken.has(typed)) continue;
    seenToken.add(typed);
    complete.push(forms);
  }
  const last = nameVariants[nameVariants.length - 1]!;

  const lists: Uint32Array[][] = [];
  const sizes: number[] = [];
  const weights: number[] = [];
  for (const forms of complete) {
    const ls: Uint32Array[] = [];
    let total = 0;
    for (const f of forms) {
      const id = a.terms.find(f);
      if (id < 0) continue;
      const p = postings(a, id);
      ls.push(p);
      total += p.length;
    }
    if (ls.length === 0) return scores; // a required token matches nothing
    lists.push(ls);
    sizes.push(total);
    weights.push(idf(nAnchors, total));
  }

  // Rarity of the prefix as typed, not of whichever expansion an anchor carries.
  // Weighting per expansion made a one-posting term the most valuable thing in
  // the index, and "Warsz" put a shop branded "Warsz" above Warszawa.
  const ranges: { lo: number; hi: number; typed: string }[] = [];
  let prefixTotal = 0;
  for (const f of last) {
    const [lo, hi] = a.terms.prefixRange(f);
    if (lo >= hi) continue;
    ranges.push({ lo, hi, typed: f });
    for (let t = lo; t < hi; t++) prefixTotal += a.postOff[t + 1]! - a.postOff[t]!;
  }
  if (ranges.length === 0) return scores;
  const prefixIdf = idf(nAnchors, prefixTotal);

  const prefixHits = new Map<number, number>();
  let scanned = 0;
  scan: for (const { lo, hi, typed } of ranges) {
    for (let t = lo; t < hi; t++) {
      const term = a.terms.get(t);
      const p = postings(a, t);

      // How much of the matched term the user typed. Prefix expansion is a
      // fallback, not an equal alternative, so it is discounted squared: without
      // this "Prahatice" outscored "Praha". No separate exact-term bonus, since
      // completeness is already 1 when the term equals the query.
      const completeness = typed.length / term.length;
      const w = prefixIdf * completeness * completeness;

      for (const anchor of p) {
        prefixHits.set(anchor, Math.max(prefixHits.get(anchor) ?? 0, w));
      }
      scanned += p.length;
      // A one-letter prefix can span a large slice of the index. The exact-term
      // lists still anchor the result set, so capping here only loses long tail.
      if (scanned > maxCandidates * 20) break scan;
    }
  }

  if (lists.length === 0) {
    return prefixHits;
  }

  // Every complete token has to match, so the work is bounded by the smallest
  // candidate set among them and the prefix hits: walk that one and test the
  // rest. Which is smallest is a property of the query, not of the query shape
  // — "Rue de la Paix" is carried by its last token, "Nowa Wies 12" by its
  // first — so it is chosen per request rather than assumed.
  let smallest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i]! < sizes[smallest]!) smallest = i;
  const weightSum = weights.reduce((t, w) => t + w, 0);

  if (prefixHits.size <= sizes[smallest]!) {
    for (const [anchor, pw] of prefixHits) {
      let ok = true;
      for (const token of lists) {
        if (!holds(token, anchor)) { ok = false; break; }
      }
      if (ok) scores.set(anchor, pw + weightSum);
    }
    return scores;
  }

  for (const list of lists[smallest]!) for (const anchor of list) {
    const pw = prefixHits.get(anchor);
    if (pw === undefined) continue;
    let ok = true;
    for (let i = 0; i < lists.length; i++) {
      // Already known to hold it: this is the list being walked.
      if (i !== smallest && !holds(lists[i]!, anchor)) { ok = false; break; }
    }
    if (ok) scores.set(anchor, pw + weightSum);
  }
  return scores;
}

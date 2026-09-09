/**
 * A port of `ingest/internal/norm` that must stay byte-for-byte identical to it:
 * index terms were folded by the Go code, so any drift makes queries silently
 * return nothing. `normalize.contract.test.ts` asserts that against fixtures Go
 * emits from several thousand real corpus names.
 */

/**
 * Characters NFD cannot decompose. Stroked and ligatured letters have their own
 * codepoints, so stripping diacritics leaves them untouched: without this
 * `Łódź` folds to `łodz` and never matches a typed `Lodz`.
 */
const SINGLETONS = new Map<string, string>([
  ['ł', 'l'], ['Ł', 'l'],
  ['đ', 'd'], ['Đ', 'd'],
  ['ø', 'o'], ['Ø', 'o'],
  ['ß', 'ss'],
  ['æ', 'ae'], ['Æ', 'ae'],
  ['œ', 'oe'], ['Œ', 'oe'],
  ['ð', 'd'], ['Ð', 'd'],
  ['þ', 'th'], ['Þ', 'th'],
  ['ı', 'i'], ['İ', 'i'],
  // Greek final sigma: JavaScript's toLowerCase applies the contextual rule and
  // gives ς at the end of a word where Go always gives σ. Folding ς onto σ
  // settles it identically on both sides.
  ['ς', 'σ'],
]);

/**
 * Cyrillic to Latin. Written for Serbo-Croatian, where the same language is
 * written in both scripts and the mapping is a bijection apart from three
 * digraphs, so "Београд" and "Beograd" must converge.
 *
 * It has to be *total* over the Cyrillic the corpus contains, which it was not:
 * letters outside the Serbian alphabet passed through raw and produced tokens
 * half in each script. "София" folded to "sofiя", "Мінск" to "mіnsk". Bulgarian,
 * Ukrainian and Belarusian are all in the catalogue.
 *
 * The additions collapse hard, matching the Serbian entries. English
 * romanisations (sh, ch, zh) will not match; those arrive as name:en aliases and
 * are scored as separate name variants, which is how exonyms already work.
 *
 * Keep in step with `ingest/internal/norm`.
 */
const CYRILLIC = new Map<string, string>([
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['ђ', 'dj'],
  ['е', 'e'], ['ж', 'z'], ['з', 'z'], ['и', 'i'], ['ј', 'j'], ['к', 'k'],
  ['л', 'l'], ['љ', 'lj'], ['м', 'm'], ['н', 'n'], ['њ', 'nj'], ['о', 'o'],
  ['п', 'p'], ['р', 'r'], ['с', 's'], ['т', 't'], ['ћ', 'c'], ['у', 'u'],
  ['ф', 'f'], ['х', 'h'], ['ц', 'c'], ['ч', 'c'], ['џ', 'dz'], ['ш', 's'],

  // Macedonian
  ['ѓ', 'gj'], ['ќ', 'kj'], ['ѕ', 'dz'], ['ѐ', 'e'], ['ѝ', 'i'],

  // Bulgarian, Ukrainian, Belarusian, Russian
  ['ё', 'e'], ['є', 'e'], ['і', 'i'], ['ї', 'i'], ['й', 'j'], ['ґ', 'g'],
  ['ў', 'u'], ['щ', 's'], ['ы', 'y'], ['э', 'e'], ['ю', 'u'], ['я', 'a'],
  // The soft sign modifies the preceding consonant and has no letter of its
  // own; the hard sign is silent in Russian but a full vowel in Bulgarian,
  // where dropping it would leave "Бургас" without its u.
  ['ь', ''], ['ъ', 'a'],
]);

/** Street-type abbreviations, expanded before stopword removal. */
const ABBREV = new Map<string, string>([
  // Czech
  ['nam', 'namesti'], ['nám', 'namesti'], ['namesti', 'namesti'],
  ['ul', 'ulice'], ['tr', 'trida'], ['tř', 'trida'],
  ['nabr', 'nabrezi'], ['nábř', 'nabrezi'],
  ['sv', 'svaty'], ['gen', 'generala'], ['kpt', 'kapitana'],
  ['arm', 'armady'], ['prof', 'profesora'],
  // Polish
  ['al', 'aleja'], ['aleje', 'aleja'], ['alei', 'aleja'],
  ['pl', 'plac'], ['os', 'osiedle'],
  ['św', 'swiety'], ['sw', 'swiety'],
  ['ks', 'ksiedza'], ['mjr', 'majora'], ['plk', 'pulkownika'],
  // generic
  ['st', 'street'], ['str', 'street'], ['rd', 'road'], ['ave', 'avenue'],
]);

/** Street-type words dropped from the token list; they discriminate nothing. */
const GENERIC = new Set([
  'ulice', 'ulica', 'street', 'road', 'avenue',
  'namesti', 'plac', 'aleja', 'trida',
  'osiedle', 'nabrezi', 'rynek',
]);

const COMBINING_MARKS = /\p{Mn}/gu;
const ALNUM = /[\p{L}\p{N}]/u;

/** ゙ dakuten and ゚ handakuten. */
const VOICED = '\u3099';
const SEMI_VOICED = '\u309A';

/**
 * Scripts written without spaces between words, where a token boundary has to
 * be invented. Hard-coded ranges rather than \p{Script=Han} and
 * unicode.Is(unicode.Han, r), because those are Unicode-version dependent on
 * each side and the two sides have to agree exactly, forever.
 *
 * Hangul is deliberately absent: Korean is written with spaces between words,
 * so folding already finds its boundaries.
 */
const UNSPACED_RANGES: [number, number][] = [
  [0x3040, 0x309F],   // Hiragana
  [0x30A0, 0x30FF],   // Katakana
  [0x31F0, 0x31FF],   // Katakana phonetic extensions
  [0x3400, 0x4DBF],   // CJK Unified Ideographs Extension A
  [0x4E00, 0x9FFF],   // CJK Unified Ideographs
  [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
  [0x20000, 0x3FFFF], // CJK Unified Ideographs Extensions B and beyond
];

function unspaced(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  for (const [lo, hi] of UNSPACED_RANGES) if (c >= lo && c <= hi) return true;
  return false;
}

/**
 * Breaks a folded token on script boundaries and turns each run of an unspaced
 * script into overlapping bigrams. Null when there is nothing of the kind,
 * which is every token in a European corpus.
 *
 * "東京都千代田区" is one word to this folder and one token to the whitespace
 * split, so a query for "千代田区" would have to reproduce the whole string to
 * match. Bigrams give both sides the same two-character pieces — 千代, 代田,
 * 田区 — and the ordinary AND across query tokens does the rest.
 */
function segment(token: string): string[] | null {
  const cs = [...token];
  if (!cs.some(unspaced)) return null;

  const out: string[] = [];
  for (let i = 0; i < cs.length;) {
    let j = i;
    if (unspaced(cs[i]!)) {
      while (j < cs.length && unspaced(cs[j]!)) j++;
      const run = cs.slice(i, j);
      if (run.length === 1) out.push(run[0]!);
      for (let k = 0; k + 1 < run.length; k++) out.push(run[k]! + run[k + 1]!);
    } else {
      while (j < cs.length && !unspaced(cs[j]!)) j++;
      out.push(cs.slice(i, j).join(''));
    }
    i = j;
  }
  return out;
}

/** Lowercase ASCII letters and digits, space-separated. */
export function fold(s: string): string {
  // Expand what NFD cannot handle, and transliterate.
  let out = '';
  for (const ch of s.toLowerCase()) {
    const single = SINGLETONS.get(ch);
    if (single !== undefined) { out += single; continue; }
    const cyr = CYRILLIC.get(ch);
    if (cyr !== undefined) { out += cyr; continue; }
    out += ch;
  }

  // Drop combining marks: háčky, čárky, ogonki. Compatibility decomposition,
  // not canonical: NFKD is what makes the full-width digits of a Japanese
  // address the same as ASCII ones, half-width katakana the same as full-width,
  // and Ⅱ, ﬁ, ², № into letters a keyboard can produce.
  //
  // The two Japanese voicing marks are spared. They are combining marks by
  // category but they are not accents: dropping U+3099 folds ば onto は, a
  // different word, where dropping a háček is the whole point.
  const folded = out.normalize('NFKD')
    .replace(COMBINING_MARKS, (m) => (m === VOICED || m === SEMI_VOICED ? m : ''))
    .normalize('NFC');

  // Lowercase again — NFKD produces capitals the first pass never saw, № giving
  // "No" and ℡ "TEL" — and anything that is not a letter or number becomes a
  // separator. Per character, so that the contextual rule for a word-final Σ
  // cannot apply on this side and not on Go's.
  let result = '';
  let prevSep = true;
  for (const ch of folded) {
    if (ALNUM.test(ch)) {
      result += ch.toLowerCase();
      prevSep = false;
    } else if (!prevSep) {
      result += ' ';
      prevSep = true;
    }
  }
  return result.trim();
}

export function tokens(s: string): string[] {
  const folded = fold(s);
  if (folded === '') return [];

  const expanded = folded.split(/\s+/).map((t) => ABBREV.get(t) ?? t);
  let kept = expanded.filter((t) => !GENERIC.has(t));

  // Never erase a feature entirely: a street named "Rynek" must stay findable.
  if (kept.length === 0) kept = expanded;

  // Last, so that abbreviation expansion and stopword removal see whole words.
  return kept.flatMap((t) => segment(t) ?? [t]);
}

/* ------------------------------------------------------------------ German ---
 *
 * Stripping the diacritic is only half of German. "München" and "Muenchen" are
 * both correct spellings — the trailing-e digraph is the standard substitute
 * wherever the umlaut cannot be typed, and it is what a large share of users
 * type anyway — but they fold to `munchen` and `muenchen`, which share no term.
 * Likewise ß: "Schloßstraße", "Schlossstraße" and "Schlosstraße" are the old
 * spelling, the reformed one and the everyday shortening of the same street,
 * and the ß -> ss expansion alone leaves the first two on `schlossstrasse` and
 * the third on `schlosstrasse`.
 *
 * Neither is fixable by folding harder, because folding is many-to-one and
 * these are genuinely different strings. So the index carries the alternatives
 * as extra tokens beside the canonical one, and the query widens to the
 * alternatives it can infer from what was typed. The exact spelling still wins
 * on score: a variant is an additional way in, not a replacement.
 *
 * Keep in step with `ingest/internal/norm`.
 */

const UMLAUTS = new Map<string, string>([
  ['ä', 'ae'], ['Ä', 'ae'],
  ['ö', 'oe'], ['Ö', 'oe'],
  ['ü', 'ue'], ['Ü', 'ue'],
]);

const HAS_UMLAUT = /[äöüÄÖÜ̈]/;

/**
 * Rewrites ä/ö/ü to their digraph spellings in *raw* text, before `fold` strips
 * the diaeresis and the two spellings become indistinguishable. NFC first: OSM
 * carries both the precomposed letter and a base plus U+0308.
 */
function expandUmlauts(s: string): string | null {
  if (!HAS_UMLAUT.test(s)) return null;
  let out = '';
  let changed = false;
  for (const ch of s.normalize('NFC')) {
    const rep = UMLAUTS.get(ch);
    if (rep !== undefined) { out += rep; changed = true; continue; }
    out += ch;
  }
  return changed ? out : null;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/**
 * The reverse reading: ae/oe/ue back to a/o/u, for an already-folded token.
 * Only at the start of a token or after a consonant, which is what tells a
 * written-out umlaut from the vowel pairs it collides with — "Muenchen" and
 * "Koeln" collapse, "Neue", "Aue" and "Steuer" do not.
 *
 * Query-side only. It is a guess about what the typist meant, and a guess is
 * worth making about a query, where the alternative is no result at all, but
 * not worth baking into 200M index terms.
 */
function collapseDigraphs(token: string): string {
  const cs = [...token];
  let out = '';
  let prev = '';
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    if ((c === 'a' || c === 'o' || c === 'u') && cs[i + 1] === 'e'
      && (out === '' || !VOWELS.has(prev))) {
      out += c;
      prev = c;
      i++; // swallow the e
      continue;
    }
    out += c;
    prev = c;
  }
  return out;
}

/**
 * Reduces a run of three or more s to two: the ß -> ss expansion meeting a
 * compound boundary, as in Schloß|straße. Two is left alone, so "Strasse" is
 * not confused with "Strase".
 */
function collapseSibilants(token: string): string {
  if (!token.includes('sss')) return token;
  return token.replace(/s{3,}/g, 'ss');
}

/** Appends v to out when it is neither empty nor already there. */
function push(out: string[], seen: Set<string>, v: string): void {
  if (v === '' || seen.has(v)) return;
  seen.add(v);
  out.push(v);
}

/**
 * What the inverted index stores for s: `tokens(s)` first, then the alternative
 * spellings of those tokens, each appearing once — a posting list holds an
 * anchor at most once anyway, so a repeated word ("rue de la ...") is dropped
 * here rather than downstream.
 *
 * Not used for anchor identity or for the name length that bounds relevance:
 * both count real tokens, and a variant is not one.
 */
export function indexTokens(s: string): string[] {
  const base = tokens(s);
  if (base.length === 0) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of base) push(out, seen, t);

  const expanded = expandUmlauts(s);
  if (expanded !== null) for (const t of tokens(expanded)) push(out, seen, t);

  // Over a snapshot: collapsing is idempotent, so the appended forms would add
  // nothing but a longer loop.
  for (const t of [...out]) push(out, seen, collapseSibilants(t));
  return out;
}

/**
 * The query-side mirror: for each token of s, the forms worth looking up, the
 * token itself first. A term matches when any form does, so a multi-token query
 * still ANDs across positions and ORs only within one.
 *
 * Wider than `indexTokens` by `collapseDigraphs`, and no wider than that: the
 * index already carries the digraph spelling of every umlaut it holds, so the
 * query only has to bridge the other direction.
 */
export function queryVariants(s: string): string[][] {
  const base = tokens(s);
  if (base.length === 0) return [];

  // Expansion never moves a token boundary, so the two lists line up; the
  // length check is a guard, not an expectation.
  const expanded = expandUmlauts(s);
  const altAll = expanded === null ? null : tokens(expanded);
  const alt = altAll !== null && altAll.length === base.length ? altAll : null;

  return base.map((t, i) => {
    const seen = new Set<string>();
    const forms: string[] = [];
    push(forms, seen, t);
    if (alt !== null) push(forms, seen, alt[i]!);
    for (const f of [...forms]) {
      const d = collapseDigraphs(f);
      push(forms, seen, d);
      push(forms, seen, collapseSibilants(f));
      push(forms, seen, collapseSibilants(d));
    }
    return forms;
  });
}

/** The forms to look up for an already-folded token, the token itself first. */
export function tokenVariants(token: string): string[] {
  const seen = new Set<string>();
  const forms: string[] = [];
  push(forms, seen, token);
  const d = collapseDigraphs(token);
  push(forms, seen, d);
  push(forms, seen, collapseSibilants(token));
  push(forms, seen, collapseSibilants(d));
  return forms;
}

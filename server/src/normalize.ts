/**
 * Query-time text folding.
 *
 * This is a deliberate port of `ingest/internal/norm` and MUST stay byte-for-byte
 * identical to it. Index terms were folded by the Go code; if this drifts even
 * slightly, queries stop matching the index and the failure is silent — you get
 * zero results rather than an error.
 *
 * `test/normalize.contract.test.ts` guards against exactly that: the Go
 * implementation emits fixtures for several thousand real names drawn from the
 * built index, and the test asserts this code reproduces them exactly.
 */

/**
 * Characters Unicode NFD does not decompose into a base letter plus a combining
 * mark. Stroked and ligatured letters have their own codepoints, so stripping
 * diacritics alone leaves them untouched — without this, `Łódź` folds to `łodz`
 * and never matches a typed `Lodz`, and Łódź is one of Poland's largest cities.
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
]);

/** Serbian Cyrillic to Latin. A clean bijection apart from three digraphs. */
const CYRILLIC = new Map<string, string>([
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['ђ', 'dj'],
  ['е', 'e'], ['ж', 'z'], ['з', 'z'], ['и', 'i'], ['ј', 'j'], ['к', 'k'],
  ['л', 'l'], ['љ', 'lj'], ['м', 'm'], ['н', 'n'], ['њ', 'nj'], ['о', 'o'],
  ['п', 'p'], ['р', 'r'], ['с', 's'], ['т', 't'], ['ћ', 'c'], ['у', 'u'],
  ['ф', 'f'], ['х', 'h'], ['ц', 'c'], ['ч', 'c'], ['џ', 'dz'], ['ш', 's'],
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

/** Street-type words dropped from the token list; they carry no discriminating power. */
const GENERIC = new Set([
  'ulice', 'ulica', 'street', 'road', 'avenue',
  'namesti', 'plac', 'aleja', 'trida',
  'osiedle', 'nabrezi', 'rynek',
]);

const COMBINING_MARKS = /\p{Mn}/gu;
const ALNUM = /[\p{L}\p{N}]/u;

/**
 * Reduces a string to lowercase ASCII-ish letters and digits separated by single
 * spaces: the canonical form for both index terms and query terms.
 */
export function fold(s: string): string {
  // Pass 1: expand what NFD cannot handle, and transliterate.
  let out = '';
  for (const ch of s.toLowerCase()) {
    const single = SINGLETONS.get(ch);
    if (single !== undefined) { out += single; continue; }
    const cyr = CYRILLIC.get(ch);
    if (cyr !== undefined) { out += cyr; continue; }
    out += ch;
  }

  // Pass 2: decompose and drop combining marks (háčky, čárky, ogonki).
  const folded = out.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');

  // Pass 3: anything that is not a letter or digit becomes a separator.
  let result = '';
  let prevSep = true;
  for (const ch of folded) {
    if (ALNUM.test(ch)) {
      result += ch;
      prevSep = false;
    } else if (!prevSep) {
      result += ' ';
      prevSep = true;
    }
  }
  return result.trim();
}

/** Folds `s` and returns its indexable tokens. */
export function tokens(s: string): string[] {
  const folded = fold(s);
  if (folded === '') return [];

  const expanded = folded.split(/\s+/).map((t) => ABBREV.get(t) ?? t);
  const kept = expanded.filter((t) => !GENERIC.has(t));

  // Never let stopword removal erase a feature entirely: a street genuinely
  // named "Rynek" must stay findable.
  return kept.length === 0 ? expanded : kept;
}

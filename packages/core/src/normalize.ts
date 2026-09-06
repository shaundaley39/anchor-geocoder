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

  // Drop combining marks: háčky, čárky, ogonki.
  const folded = out.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');

  // Anything that is not a letter or digit becomes a separator.
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

export function tokens(s: string): string[] {
  const folded = fold(s);
  if (folded === '') return [];

  const expanded = folded.split(/\s+/).map((t) => ABBREV.get(t) ?? t);
  const kept = expanded.filter((t) => !GENERIC.has(t));

  // Never erase a feature entirely: a street named "Rynek" must stay findable.
  return kept.length === 0 ? expanded : kept;
}

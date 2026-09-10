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

/** A house-number-shaped run of the query, as a span of folded tokens. */
interface Run { from: number; to: number; text: string }

function reading(toks: Token[], houseNumber: string | null): ParsedQuery {
  return {
    nameTokens: toks.map((t) => t.tok),
    nameVariants: toks.map((t) => t.forms),
    houseNumber,
  };
}

/**
 * A part of a house number written straight after the last one: digits, or up
 * to three letters ending where the word does. The length limit and the
 * lookahead are what stop a run swallowing the street - "12 Main" must not
 * read as house number "12Ma".
 */
const PART = String.raw`(?:\p{Nd}+|\p{L}{1,3}(?!\p{L}))`;

/**
 * What may follow a space and still be part of the number: a single letter, or
 * one of the French ordinals. Anything longer is the street.
 */
const SUFFIX = String.raw`(?:\p{L}|bis|ter|quater)(?!\p{L})`;

/**
 * A run of digits, and whatever is written as part of the same number.
 *
 * Optionally opened by a letter or two: an abbreviation and its separator for
 * the Czech "ev.223", the Russian "уч.2" and the Pakistani "C/18", or a bare
 * letter running straight into the digits for the Illinois grid's "W152S7945".
 * Then digits, then any number of further parts, joined by a slash, a hyphen,
 * a dot, a semicolon, a plus, or nothing at all.
 *
 * A space is allowed around a joiner, and before a trailing letter or a
 * French ordinal - "205 A", "93 E" and "20 ter" are how those are written. It
 * is not allowed before anything longer, which is what stops "12 Main"
 * reading as house number "12Ma", and not before more digits, which is what
 * leaves "602 00" to the postcode rule.
 *
 * A comma is deliberately not a joiner either. It is how a query separates the
 * address from the town, so accepting it would read "Bratislavská 22, 602 00
 * Brno" as house number "22,602".
 */
const RUN = new RegExp(
  String.raw`(?<![\p{L}\p{Nd}])(?:\p{L}{1,2}\s*[./]\s*|\p{L}(?=\p{Nd}))?\p{Nd}+` +
  String.raw`(?:\s*[/\-‐-―.;+]\s*${PART}|${PART}|\s${SUFFIX})*`,
  'giu',
);

/** "85th Street" and "1st Avenue" are streets, not house numbers. */
const ORDINAL = /^\d+(?:st|nd|rd|th)$/i;

/**
 * The house-number-shaped runs of the raw query, in the order written.
 *
 * Read off the raw text rather than the folded tokens, because folding splits
 * a number wherever its punctuation was and then throws the punctuation away:
 * "78-52", "213號", "5/B" and "334/36" all arrive as two tokens, and so does
 * "602 00", which is a postcode. Taking only the first of those two asks for
 * house number 78 on a street whose name has to contain "52", which is how a
 * Queens address, a Taiwanese one and a Dutch one all used to return nothing.
 */
function numberRuns(raw: string): string[] {
  return [...raw.matchAll(RUN)]
    .map((m) => m[0]!.trim())
    .filter((r) => !ORDINAL.test(r));
}

/**
 * Where each run sits in a token list. A run that folds to tokens the list
 * does not hold contiguously is dropped, which is what happens to a run inside
 * the part of the query a postcode was taken out of.
 */
function spans(runs: string[], all: Token[]): Run[] {
  const out: Run[] = [];
  let cursor = 0;
  for (const text of runs) {
    const parts = foldTokens(text);
    if (parts.length === 0) continue;
    for (let i = cursor; i + parts.length <= all.length; i++) {
      if (parts.every((p, k) => all[i + k]!.tok === p)) {
        // Tidied around the joiners and lowercased, because the number sits
        // beside folded name tokens. The space in "318 A" stays: folding
        // splits on it, and the stored number was written the same way, so
        // removing it would stop the two matching.
        out.push({
          from: i, to: i + parts.length,
          text: text.replace(/\s*([/\-‐-―.;+])\s*/gu, '$1').toLowerCase(),
        });
        cursor = i + parts.length;
        break;
      }
    }
  }
  return out;
}

/**
 * The postcode in the query, as a half-open range over the tokens, or null.
 *
 * A postcode is barely in the index: an anchor's token list comes from one of
 * its records, so a street carries at most one of its addresses' postcodes and
 * usually none. Every token but the last has to match a term, so a postcode
 * left in the name matches the wrong things or nothing at all.
 *
 * Read off the raw text too, and for the same reason: the separator is the
 * whole of the evidence. Czech and Slovak write "602 00" and Poland "00-001",
 * and in the token list those look exactly like the "22" and "602" of
 * "Bratislavská 22, 602 00 Brno", of which only the last two are the postcode.
 *
 * A lone four-to-six-digit run is a German postcode or an American ZIP or a
 * house number in a large city. Both readings are offered either way, and
 * looking without it first costs nothing: where the run really was the house
 * number, taking it out leaves no number for that reading to find and the
 * reading is dropped before it is searched. Never at the head of the query,
 * though, where "1600 Pennsylvania Avenue" begins with four digits that are
 * not a postcode.
 */
function postcode(raw: string, all: Token[]): { from: number; to: number } | null {
  const at = (parts: string[], min: number): number => {
    for (let i = min; i + parts.length <= all.length; i++) {
      if (parts.every((p, k) => all[i + k]!.tok === p)) return i;
    }
    return -1;
  };

  for (const re of [/(?<!\d)(\d{3}) (\d{2})(?!\d)/g, /(?<!\d)(\d{2})-(\d{3})(?!\d)/g]) {
    for (const m of raw.matchAll(re)) {
      const i = at([m[1]!, m[2]!], 0);
      if (i >= 0) return { from: i, to: i + 2 };
    }
  }
  for (const m of raw.matchAll(/(?<!\d)(\d{4,6})(?!\d)/g)) {
    const i = at([m[1]!], 1);
    if (i >= 0) return { from: i, to: i + 1 };
  }
  return null;
}

/**
 * Candidate readings, best guess first; the caller takes the first that finds
 * anything. A trailing or medial number is a house number, and a leading one
 * is too, but only as a last resort - "3 Maja" is a common Polish street name
 * and "17 Novembre" a common French one.
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

  const runs = numberRuns(raw);
  const pc = postcode(raw, all);
  const trimmed = pc ? [...all.slice(0, pc.from), ...all.slice(pc.to)] : null;

  const seen = new Set<string>();
  const readings: ParsedQuery[] = [];
  const push = (r: ParsedQuery | null): void => {
    if (r === null || r.nameTokens.length === 0) return;
    const key = `${r.nameTokens.join(' ')} ${r.houseNumber ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    readings.push(r);
  };

  // House-number readings from both token lists, and only then the lists as
  // names in their own right. The caller takes the first reading that finds
  // anything, so a reading that matches weakly must not come before one that
  // would match well: "Städtle 17, 9490 Vaduz" turns up POIs tagged with that
  // postcode, and the address it is asking for is further down.
  for (const r of houseNumbers(trimmed, runs)) push(r);
  for (const r of houseNumbers(all, runs)) push(r);
  if (trimmed !== null) push(reading(trimmed, null));
  push(reading(all, null));

  /**
   * "10 Downing Street", "1600 Pennsylvania Avenue", "78-52 85th Street": the
   * number leads across the English-speaking world, and reading it as part of
   * the name asks the index for a street whose name contains "10", which no
   * street's does.
   *
   * Last of the readings, never first. A leading number is more often part of
   * the name than a house number, so this is reached only once every other
   * reading has come back with nothing - which for "3 Maja" it does not.
   */
  push(leadingNumber(trimmed, runs));
  push(leadingNumber(all, runs));
  return readings;
}

/**
 * The readings that take a trailing or medial house number out of one token
 * list, best first.
 *
 * A number ending the query is the house number. Failing that, the last one
 * that is not the head of the query: "Via Roma 1 Torino" writes the number
 * between the street and the city, which much of the region does, and where
 * the street name carries a number of its own the house number is the later
 * of the two - "Calle 109 99" is number 99 on Calle 109. Earlier numbers are
 * offered after, since the caller only reaches them if the better readings
 * found nothing.
 */
function houseNumbers(all: Token[] | null, runs: string[]): ParsedQuery[] {
  if (all === null || all.length === 0) return [];
  const sp = spans(runs, all).filter((s) => s.from > 0);
  const order = [
    ...sp.filter((s) => s.to === all.length),
    ...sp.filter((s) => s.to !== all.length).reverse(),
  ];
  return order.map((s) =>
    reading([...all.slice(0, s.from), ...all.slice(s.to)], s.text));
}

/** The same, for a number at the head of the query. */
function leadingNumber(all: Token[] | null, runs: string[]): ParsedQuery | null {
  if (all === null || all.length === 0) return null;
  const lead = spans(runs, all).find((s) => s.from === 0);
  if (lead === undefined || lead.to >= all.length) return null;
  return reading(all.slice(lead.to), lead.text);
}

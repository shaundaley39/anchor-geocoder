// Package norm folds place and street names into the token form actually
// indexed by the geocoder.
//
// This is the single largest quality lever in the pipeline. The three target
// countries between them use Czech hacky and carky, Polish ogonki plus the
// stroked l, Bosnian-Croatian-Serbian carons, and Serbian Cyrillic. A user
// typing "Lodz", "Plzen" or "Banja Luka" on a plain keyboard must reach
// "Lodz", "Plzen" and "Banja Luka"/"Bawa Nyka" alike.
//
// Folding happens identically at index time and at query time; that symmetry is
// the whole contract. Anything applied here must be applied to the query too.
package norm

import (
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// singletons maps characters that Unicode NFKD does NOT decompose into a base
// letter plus a combining mark. Stroked and ligatured letters have their own
// codepoints, so diacritic stripping alone leaves them untouched: "Lodz" would
// otherwise fold to "lodz" with the stroked l intact and never match a typed l.
var singletons = map[rune]string{
	'ł': "l", 'Ł': "l", // Polish  — very high frequency
	'đ': "d", 'Đ': "d", // BCS
	'ø': "o", 'Ø': "o",
	'ß': "ss",
	'æ': "ae", 'Æ': "ae",
	'œ': "oe", 'Œ': "oe",
	'ð': "d", 'Ð': "d",
	'þ': "th", 'Þ': "th",
	'ı': "i", 'İ': "i",
}

// cyrillic maps Serbian Cyrillic to its Latin equivalent. The Serbian script
// pair is a clean bijection apart from three digraphs, which is why this is a
// lookup table and not a statistical transliterator. Bosnia carries ~52k
// name:sr values, so this earns its place even though Bosnia ships last.
var cyrillic = map[rune]string{
	'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'ђ': "dj", 'е': "e",
	'ж': "z", 'з': "z", 'и': "i", 'ј': "j", 'к': "k", 'л': "l", 'љ': "lj",
	'м': "m", 'н': "n", 'њ': "nj", 'о': "o", 'п': "p", 'р': "r", 'с': "s",
	'т': "t", 'ћ': "c", 'у': "u", 'ф': "f", 'х': "h", 'ц': "c", 'ч': "c",
	'џ': "dz", 'ш': "s",
}

// abbrev expands the street-type abbreviations that appear in OSM name tags and
// in user queries. Expansion runs before stopword removal so that "ul.",
// "ulica" and an omitted prefix all converge on the same token list.
var abbrev = map[string]string{
	// Czech
	"nam": "namesti", "nám": "namesti", "namesti": "namesti",
	"ul": "ulice", "tr": "trida", "tř": "trida",
	"nabr": "nabrezi", "nábř": "nabrezi",
	"sv": "svaty", "gen": "generala", "kpt": "kapitana",
	"arm": "armady", "prof": "profesora",
	// Polish
	"al": "aleja", "aleje": "aleja", "alei": "aleja",
	"pl": "plac", "os": "osiedle",
	"św": "swiety", "sw": "swiety",
	"ks": "ksiedza", "mjr": "majora", "plk": "pulkownika",
	// generic
	"st": "street", "str": "street", "rd": "road", "ave": "avenue",
}

// generic holds street-type words dropped from the token list. They carry
// almost no discriminating power — Poland has thousands of "ulica X" — and
// dropping them on both sides makes the prefix "ul. Marsz" behave like
// "Marsz". Removal is skipped if it would empty the token list, which protects
// the handful of features actually named just "Plac" or "Rynek".
var generic = map[string]bool{
	"ulice": true, "ulica": true, "street": true, "road": true, "avenue": true,
	"namesti": true, "plac": true, "aleja": true, "trida": true,
	"osiedle": true, "nabrezi": true, "rynek": true,
}

var stripMarks = transform.Chain(
	norm.NFD,
	runes.Remove(runes.In(unicode.Mn)), // drop combining diacritical marks
	norm.NFC,
)

// Fold reduces a string to lowercase ASCII-ish letters and digits, separated by
// single spaces. It is the canonical form used for both index terms and query
// terms.
func Fold(s string) string {
	var b strings.Builder
	b.Grow(len(s))

	// Pass 1: expand the characters NFD cannot handle, and transliterate.
	for _, r := range strings.ToLower(s) {
		if rep, ok := singletons[r]; ok {
			b.WriteString(rep)
			continue
		}
		if rep, ok := cyrillic[r]; ok {
			b.WriteString(rep)
			continue
		}
		b.WriteRune(r)
	}

	// Pass 2: decompose and drop combining marks (hacky, carky, ogonki).
	folded, _, err := transform.String(stripMarks, b.String())
	if err != nil {
		folded = b.String() // folding is best-effort; never fail ingest on it
	}

	// Pass 3: everything that is not a letter or digit becomes a separator.
	var out strings.Builder
	out.Grow(len(folded))
	prevSep := true
	for _, r := range folded {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			out.WriteRune(r)
			prevSep = false
		case !prevSep:
			out.WriteByte(' ')
			prevSep = true
		}
	}
	return strings.TrimSpace(out.String())
}

// Tokens folds s and returns its indexable tokens: abbreviations expanded and
// generic street-type words removed.
func Tokens(s string) []string {
	folded := Fold(s)
	if folded == "" {
		return nil
	}
	raw := strings.Fields(folded)

	expanded := make([]string, 0, len(raw))
	for _, t := range raw {
		if full, ok := abbrev[t]; ok {
			t = full
		}
		expanded = append(expanded, t)
	}

	kept := make([]string, 0, len(expanded))
	for _, t := range expanded {
		if !generic[t] {
			kept = append(kept, t)
		}
	}
	// Never let stopword removal erase a feature entirely: a street genuinely
	// named "Rynek" must stay findable.
	if len(kept) == 0 {
		return expanded
	}
	return kept
}

// QueryTokens folds a user query. It is deliberately the same code path as
// Tokens; the two must not drift.
func QueryTokens(q string) []string { return Tokens(q) }

// Package norm folds names into the token form the geocoder indexes.
//
// The largest quality lever in the pipeline. The region uses Czech hacky and
// carky, Polish ogonki and the stroked l, BCS carons, and Serbian Cyrillic; a
// user typing "Lodz" or "Banja Luka" on a plain keyboard must reach all of it.
//
// Index-time and query-time folding must stay identical — that symmetry is the
// whole contract, and the TypeScript port is held to it by a fixture test.
package norm

import (
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// Characters NFKD does not decompose. Stroked and ligatured letters have their
// own codepoints, so stripping diacritics leaves them untouched and "Lodz"
// would never match a typed l.
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

// Serbian Cyrillic to Latin: a bijection apart from three digraphs, which is
// why a table suffices. Bosnia carries ~52k name:sr values.
var cyrillic = map[rune]string{
	'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'ђ': "dj", 'е': "e",
	'ж': "z", 'з': "z", 'и': "i", 'ј': "j", 'к': "k", 'л': "l", 'љ': "lj",
	'м': "m", 'н': "n", 'њ': "nj", 'о': "o", 'п': "p", 'р': "r", 'с': "s",
	'т': "t", 'ћ': "c", 'у': "u", 'ф': "f", 'х': "h", 'ц': "c", 'ч': "c",
	'џ': "dz", 'ш': "s",
}

// Street-type abbreviations, expanded before stopword removal so "ul.",
// "ulica" and an omitted prefix converge.
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

// Street-type words dropped from the token list: they discriminate nothing, and
// dropping them on both sides makes "ul. Marsz" behave like "Marsz". Skipped
// when it would empty the list, protecting features named just "Rynek".
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

// Fold reduces a string to lowercase ASCII-ish letters and digits, space
// separated: the canonical form for index and query terms alike.
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

// QueryTokens is deliberately the same code path as Tokens; the two must not drift.
func QueryTokens(q string) []string { return Tokens(q) }

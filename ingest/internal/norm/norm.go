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
	// Greek final sigma. Go lowercases Σ to σ wherever it stands; JavaScript
	// applies the contextual rule and gives ς at the end of a word, so
	// "ΒΛΑΧΟΠΟΥΛΟΣ" folded two different ways on the two sides of the artifact.
	// Mapping ς onto σ makes the question moot in both.
	'ς': "σ",
}

// Cyrillic to Latin. Written for Serbo-Croatian, where the same language is
// written in both scripts and the mapping is a bijection apart from three
// digraphs, so a table suffices and "Београд" and "Beograd" must converge.
//
// It has to be *total* over the Cyrillic the corpus contains, which it was not:
// letters outside the Serbian alphabet passed through raw and produced tokens
// half in each script. "София" folded to "sofiя", matching neither "София" nor
// "Sofia"; "Мінск" to "mіnsk"; "Львів" to "lьvіv". Bulgarian, Ukrainian and
// Belarusian are all in the catalogue, so that was three shipped countries.
//
// The additions collapse hard, matching the Serbian entries: ш and щ both to s,
// ч to c, ж to z. That is what makes the Serbian case work — Latin Serbian
// spells them š, č, ž, which strip to the same letters — and it is why English
// romanisations (sh, ch, zh) will not match. Those come in as name:en aliases,
// scored as separate name variants, which is how exonyms already work.
var cyrillic = map[rune]string{
	'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'ђ': "dj", 'е': "e",
	'ж': "z", 'з': "z", 'и': "i", 'ј': "j", 'к': "k", 'л': "l", 'љ': "lj",
	'м': "m", 'н': "n", 'њ': "nj", 'о': "o", 'п': "p", 'р': "r", 'с': "s",
	'т': "t", 'ћ': "c", 'у': "u", 'ф': "f", 'х': "h", 'ц': "c", 'ч': "c",
	'џ': "dz", 'ш': "s",

	// Macedonian
	'ѓ': "gj", 'ќ': "kj", 'ѕ': "dz", 'ѐ': "e", 'ѝ': "i",

	// Bulgarian, Ukrainian, Belarusian, Russian
	'ё': "e", 'є': "e", 'і': "i", 'ї': "i", 'й': "j", 'ґ': "g", 'ў': "u",
	'щ': "s", 'ы': "y", 'э': "e", 'ю': "u", 'я': "a",
	// The soft sign modifies the preceding consonant and has no letter of its
	// own; the hard sign is silent in Russian but a full vowel in Bulgarian,
	// where dropping it would leave "Бургас" without its u.
	'ь': "", 'ъ': "a",
}

// Street-type abbreviations, expanded before stopword removal so "ul.", "ulica"
// and an omitted prefix converge.
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

// Compatibility decomposition, not canonical: NFKD is what makes the full-width
// digits of a Japanese address ("１丁目") the same as ASCII ones, half-width
// katakana the same as full-width, and Ⅱ, ﬁ, ², № into letters a keyboard can
// produce. NFD leaves every one of those as a character nobody can type.
//
// The Mn strip spares the two Japanese voicing marks. They are combining marks
// by category but they are not accents: dropping U+3099 folds ば onto は, which
// is a different word, where dropping a háček is the whole point.
var stripMarks = transform.Chain(
	norm.NFKD,
	runes.Remove(runes.Predicate(func(r rune) bool {
		return r != voicedMark && r != semiVoicedMark && unicode.Is(unicode.Mn, r)
	})),
	norm.NFC,
)

const (
	voicedMark     = 0x3099 // ゙ dakuten
	semiVoicedMark = 0x309A // ゚ handakuten
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

	// Pass 3: lowercase again, and everything that is not a letter or number
	// becomes a separator.
	//
	// Again, because NFKD produces capitals that pass 1 never saw: № decomposes
	// to "No", ℡ to "TEL", Ⅻ to "XII". Per rune rather than over the string, so
	// that JavaScript's contextual rule for a word-final Σ cannot apply on one
	// side and not the other.
	//
	// IsNumber, not IsDigit: IsDigit is category Nd alone, where the TypeScript
	// port's \p{N} is Nd, Nl and No. That gap made "Třeboň Ⅱ" fold to "trebon"
	// here and "trebon ⅱ" there — the index holding one term and the query
	// asking for two, which is exactly the silent drift the two implementations
	// are supposed to be held apart from. The 4,000-name fixture never sampled a
	// Roman numeral; the per-anchor term ids in the artifact did.
	var out strings.Builder
	out.Grow(len(folded))
	prevSep := true
	for _, r := range folded {
		switch {
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			out.WriteRune(unicode.ToLower(r))
			prevSep = false
		case !prevSep:
			out.WriteByte(' ')
			prevSep = true
		}
	}
	return strings.TrimSpace(out.String())
}

// Scripts written without spaces between words, where a token boundary has to
// be invented. Hard-coded ranges rather than unicode.Is(unicode.Han, r) and
// \p{Script=Han}, because those are Unicode-version dependent on each side and
// the two sides have to agree exactly, forever.
var unspacedRanges = [...][2]rune{
	{0x3040, 0x309F},   // Hiragana
	{0x30A0, 0x30FF},   // Katakana
	{0x31F0, 0x31FF},   // Katakana phonetic extensions
	{0x3400, 0x4DBF},   // CJK Unified Ideographs Extension A
	{0x4E00, 0x9FFF},   // CJK Unified Ideographs
	{0xF900, 0xFAFF},   // CJK Compatibility Ideographs
	{0x20000, 0x3FFFF}, // CJK Unified Ideographs Extensions B and beyond
}

// Hangul is deliberately absent: Korean is written with spaces between words,
// so the folding above already finds its boundaries.
func unspaced(r rune) bool {
	for _, g := range unspacedRanges {
		if r >= g[0] && r <= g[1] {
			return true
		}
	}
	return false
}

// segment breaks a folded token on script boundaries and turns each run of an
// unspaced script into overlapping bigrams. Returns nil when there is nothing
// of the kind, which is every token in a European corpus.
//
// "東京都千代田区" is one word to this folder and one token to the whitespace
// split, so a query for "千代田区" would have to reproduce the whole string
// exactly to match anything. Bigrams give both sides the same handful of
// two-character pieces — 千代, 代田, 田区 — and the ordinary AND across query
// tokens does the rest. It is what Lucene's CJK analyzer does, and it needs no
// dictionary, which a geocoder rebuilt from a planet extract cannot carry.
func segment(tok string) []string {
	rs := []rune(tok)
	any := false
	for _, r := range rs {
		if unspaced(r) {
			any = true
			break
		}
	}
	if !any {
		return nil
	}

	var out []string
	for i := 0; i < len(rs); {
		j := i
		if unspaced(rs[i]) {
			for j < len(rs) && unspaced(rs[j]) {
				j++
			}
			run := rs[i:j]
			if len(run) == 1 {
				out = append(out, string(run))
			}
			for k := 0; k+1 < len(run); k++ {
				out = append(out, string(run[k:k+2]))
			}
		} else {
			for j < len(rs) && !unspaced(rs[j]) {
				j++
			}
			out = append(out, string(rs[i:j]))
		}
		i = j
	}
	return out
}

// Tokens folds s and returns its indexable tokens: abbreviations expanded,
// generic street-type words removed, and unspaced scripts cut into bigrams.
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
		kept = expanded
	}

	// Last, so that abbreviation expansion and stopword removal see whole words.
	out := make([]string, 0, len(kept))
	for _, t := range kept {
		if seg := segment(t); seg != nil {
			out = append(out, seg...)
		} else {
			out = append(out, t)
		}
	}
	return out
}

// QueryTokens is deliberately the same code path as Tokens; the two must not
// drift.
func QueryTokens(q string) []string { return Tokens(q) }

// ----------------------------------------------------------------- German ---
//
// Stripping the diacritic is only half of German. "München" and "Muenchen" are
// both correct spellings — the trailing-e digraph is the standard substitute
// wherever the umlaut cannot be typed, and it is what a large share of users
// type anyway — but they fold to "munchen" and "muenchen", which share no term.
// Likewise ß: "Schloßstraße", "Schlossstraße" and "Schlosstraße" are the old
// spelling, the reformed one and the everyday shortening of the same street,
// and the ß -> ss expansion alone leaves the first two on "schlossstrasse" and
// the third on "schlosstrasse".
//
// Neither is fixable by folding harder, because folding is many-to-one and
// these are genuinely different strings. So the index carries the alternatives
// as extra tokens beside the canonical one, and the query widens to the
// alternatives it can infer from what was typed. The exact spelling still wins
// on score: a variant is an additional way in, not a replacement.

var umlauts = map[rune]string{
	'ä': "ae", 'Ä': "ae",
	'ö': "oe", 'Ö': "oe",
	'ü': "ue", 'Ü': "ue",
}

// expandUmlauts rewrites ä/ö/ü to their digraph spellings in *raw* text, before
// Fold strips the diaeresis and the two spellings become indistinguishable.
// NFC first: OSM carries both the precomposed letter and a base plus U+0308.
func expandUmlauts(s string) (string, bool) {
	if !strings.ContainsAny(s, "äöüÄÖÜ̈") {
		return s, false
	}
	var b strings.Builder
	b.Grow(len(s) + 8)
	changed := false
	for _, r := range norm.NFC.String(s) {
		if rep, ok := umlauts[r]; ok {
			b.WriteString(rep)
			changed = true
			continue
		}
		b.WriteRune(r)
	}
	return b.String(), changed
}

func isVowel(r rune) bool {
	switch r {
	case 'a', 'e', 'i', 'o', 'u', 'y':
		return true
	}
	return false
}

// collapseDigraphs is the reverse reading: ae/oe/ue back to a/o/u, for a
// *folded* token. Only at the start of a token or after a consonant, which is
// what tells a written-out umlaut from the vowel pairs it collides with —
// "Muenchen" and "Koeln" collapse, "Neue", "Aue" and "Steuer" do not.
//
// Query-side only. It is a guess about what the typist meant, and a guess is
// worth making about a query, where the alternative is no result at all, but
// not worth baking into 200M index terms.
func collapseDigraphs(tok string) string {
	if !strings.ContainsAny(tok, "aou") {
		return tok
	}
	rs := []rune(tok)
	out := make([]rune, 0, len(rs))
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		if (r == 'a' || r == 'o' || r == 'u') && i+1 < len(rs) && rs[i+1] == 'e' &&
			(len(out) == 0 || !isVowel(out[len(out)-1])) {
			out = append(out, r)
			i++ // swallow the e
			continue
		}
		out = append(out, r)
	}
	return string(out)
}

// collapseSibilants reduces a run of three or more s to two: the ß -> ss
// expansion meeting a compound boundary, as in Schloß|straße. Two is left
// alone, so "Strasse" is not confused with "Strase".
func collapseSibilants(tok string) string {
	if !strings.Contains(tok, "sss") {
		return tok
	}
	var b strings.Builder
	b.Grow(len(tok))
	run := 0
	for _, r := range tok {
		if r == 's' {
			if run++; run > 2 {
				continue
			}
		} else {
			run = 0
		}
		b.WriteRune(r)
	}
	return b.String()
}

// dedup appends v to out when it is neither empty nor already present.
func dedup(out []string, seen map[string]bool, v string) []string {
	if v == "" || seen[v] {
		return out
	}
	seen[v] = true
	return append(out, v)
}

// IndexTokens is what the inverted index stores for s: Tokens(s) first, then
// the alternative spellings of those tokens, each appearing once — a posting
// list holds an anchor at most once anyway, so a repeated word ("rue de la
// ...") is dropped here rather than downstream.
//
// Deliberately not used for the identity keys that merge duplicate features,
// nor for the name-length that bounds relevance server-side: both count real
// tokens, and a variant is not one.
func IndexTokens(s string) []string {
	base := Tokens(s)
	if len(base) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(base)+4)
	out := make([]string, 0, len(base)+4)
	for _, t := range base {
		out = dedup(out, seen, t)
	}
	if alt, changed := expandUmlauts(s); changed {
		for _, t := range Tokens(alt) {
			out = dedup(out, seen, t)
		}
	}
	// Over a snapshot: collapsing is idempotent, so the appended forms would add
	// nothing but a longer loop.
	for _, t := range append([]string(nil), out...) {
		out = dedup(out, seen, collapseSibilants(t))
	}
	return out
}

// QueryVariants is the query-side mirror: for each token of s, the forms worth
// looking up, the token itself first. A term matches when any form does, so a
// multi-token query still ANDs across positions and ORs only within one.
//
// Wider than IndexTokens by collapseDigraphs, and no wider than that: the index
// already carries the digraph spelling of every umlaut it holds, so the query
// only has to bridge the other direction.
func QueryVariants(s string) [][]string {
	base := Tokens(s)
	if len(base) == 0 {
		return nil
	}
	// Expansion never moves a token boundary, so the two lists line up; the
	// length check is a guard, not an expectation.
	var alt []string
	if e, changed := expandUmlauts(s); changed {
		if a := Tokens(e); len(a) == len(base) {
			alt = a
		}
	}

	out := make([][]string, len(base))
	for i, t := range base {
		seen := map[string]bool{}
		forms := dedup(nil, seen, t)
		if alt != nil {
			forms = dedup(forms, seen, alt[i])
		}
		for _, f := range append([]string(nil), forms...) {
			d := collapseDigraphs(f)
			forms = dedup(forms, seen, d)
			forms = dedup(forms, seen, collapseSibilants(f))
			forms = dedup(forms, seen, collapseSibilants(d))
		}
		out[i] = forms
	}
	return out
}

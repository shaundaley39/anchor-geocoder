package norm

import (
	"reflect"
	"testing"
)

func TestFoldDiacritics(t *testing.T) {
	cases := []struct{ in, want string }{
		// Czech hacky and carky
		{"Plzeň", "plzen"},
		{"Náměstí Míru", "namesti miru"},
		{"Český Krumlov", "cesky krumlov"},
		{"Dlouhá třída", "dlouha trida"},
		// Polish ogonki + the stroked l that NFD cannot touch
		{"Łódź", "lodz"},
		{"Marszałkowska", "marszalkowska"},
		{"Świętokrzyska", "swietokrzyska"},
		{"Gdańsk", "gdansk"},
		{"Zażółć gęślą jaźń", "zazolc gesla jazn"},
		// BCS carons and the stroked d
		{"Đakovo", "dakovo"},
		{"Široki Brijeg", "siroki brijeg"},
		// Serbian Cyrillic must reach the same form as its Latin twin
		{"Бања Лука", "banja luka"},
		{"Banja Luka", "banja luka"},
		{"Сарајево", "sarajevo"},
		{"Sarajevo", "sarajevo"},
		// punctuation and spacing
		{"  U  Půjčovny 2/953 ", "u pujcovny 2 953"},
		{"", ""},
	}
	for _, c := range cases {
		if got := Fold(c.in); got != c.want {
			t.Errorf("Fold(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The Cyrillic and Latin spellings of the same Bosnian place must be
// indistinguishable after folding, or cross-script search cannot work.
func TestCyrillicLatinConverge(t *testing.T) {
	pairs := [][2]string{
		{"Бања Лука", "Banja Luka"},
		{"Сарајево", "Sarajevo"},
		{"Мостар", "Mostar"},
		{"Тузла", "Tuzla"},
	}
	for _, p := range pairs {
		if a, b := Fold(p[0]), Fold(p[1]); a != b {
			t.Errorf("scripts diverge: Fold(%q)=%q vs Fold(%q)=%q", p[0], a, p[1], b)
		}
	}
}

func TestTokensAbbrevAndStopwords(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		// All three spellings of a Polish street must converge.
		{"ul. Marszałkowska", []string{"marszalkowska"}},
		{"ulica Marszałkowska", []string{"marszalkowska"}},
		{"Marszałkowska", []string{"marszalkowska"}},
		// Czech equivalents.
		{"nám. Míru", []string{"miru"}},
		{"Náměstí Míru", []string{"miru"}},
		{"tř. Svobody", []string{"svobody"}},
		// Polish aleja variants.
		{"al. Jerozolimskie", []string{"jerozolimskie"}},
		{"Aleje Jerozolimskie", []string{"jerozolimskie"}},
		// A feature named only by a generic word must survive stopword removal.
		{"Rynek", []string{"rynek"}},
		{"Plac", []string{"plac"}},
		{"Ulice", []string{"ulice"}},
	}
	for _, c := range cases {
		if got := Tokens(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Tokens(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// Index-time and query-time folding share one code path; assert they agree so a
// future optimisation to one cannot silently desync the other.
func TestQueryAndIndexAgree(t *testing.T) {
	for _, s := range []string{"ul. Świętokrzyska", "Náměstí Republiky", "Бања Лука"} {
		if !reflect.DeepEqual(Tokens(s), QueryTokens(s)) {
			t.Errorf("index/query folding diverged for %q", s)
		}
	}
}

func BenchmarkFold(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = Fold("Náměstí Svobody 12/34, Brno")
	}
}

// The Cyrillic table has to be total over the scripts the catalogue covers.
// Letters outside the Serbian alphabet used to pass through raw, leaving tokens
// half Latin and half Cyrillic that matched neither spelling.
func TestCyrillicFoldsCompletely(t *testing.T) {
	for _, c := range []struct{ cyr, latin string }{
		{"Београд", "Beograd"},     // sr — the case the table was written for
		{"Скопје", "Skopje"},       // mk
		{"Подгорица", "Podgorica"}, // me
		{"София", "Sofia"},         // bg, via я
		{"Пловдив", "Plovdiv"},     // bg
		{"Львів", "Lviv"},          // uk, via ь and і
		{"Мінск", "Minsk"},         // be, via і
	} {
		got, want := Fold(c.cyr), Fold(c.latin)
		if got != want {
			t.Errorf("%q -> %q, but %q -> %q", c.cyr, got, c.latin, want)
		}
	}
}

// A token must not come out in two scripts at once, whatever the input.
func TestFoldLeavesNoMixedScriptTokens(t *testing.T) {
	for _, s := range []string{
		"София", "Київ", "Львів", "Мінск", "Пловдив", "Бургас", "Щецин",
		"Ужгород", "Чернігів", "Гродна", "Скопје", "Београд",
	} {
		out := Fold(s)
		var latin, cyr bool
		for _, r := range out {
			switch {
			case r >= 'a' && r <= 'z':
				latin = true
			case r >= 0x0400 && r <= 0x04FF:
				cyr = true
			}
		}
		if latin && cyr {
			t.Errorf("%q folded to %q, which is half Latin and half Cyrillic", s, out)
		}
	}
}

// contains reports whether the variant list holds v.
func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// reachable reports whether a query spelling can retrieve a name spelling:
// some form the query looks up is a term the index stores.
func reachable(name, query string) bool {
	indexed := map[string]bool{}
	for _, t := range IndexTokens(name) {
		indexed[t] = true
	}
	for _, forms := range QueryVariants(query) {
		hit := false
		for _, f := range forms {
			if indexed[f] {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	return true
}

// The digraph spelling is an alternative, not a replacement: the canonical fold
// stays first, because it is what an exactly-spelled query hits.
func TestIndexTokensKeepsCanonicalFirst(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"München", []string{"munchen", "muenchen"}},
		{"Städtle", []string{"stadtle", "staedtle"}},
		{"Grünstraße", []string{"grunstrasse", "gruenstrasse"}},
		// Already digraph-spelled, or no umlaut at all: nothing to add.
		{"Muenchen", []string{"muenchen"}},
		{"Praha", []string{"praha"}},
		// Decomposed input — OSM carries both forms of the same letter.
		{"München", []string{"munchen", "muenchen"}},
	}
	for _, c := range cases {
		if got := IndexTokens(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("IndexTokens(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// ß expands to ss, and against a compound boundary that makes three. The
// two-s shortening people actually type is inserted as an extra token.
func TestIndexTokensInsertsEszettShortening(t *testing.T) {
	for _, spelling := range []string{"Schloßstraße", "Schlossstraße"} {
		got := IndexTokens(spelling)
		if !contains(got, "schlossstrasse") || !contains(got, "schlosstrasse") {
			t.Errorf("IndexTokens(%q) = %v, want both the ss and the sss form",
				spelling, got)
		}
	}
	// Two s are left alone: "Strasse" must not become "Strase".
	if got := IndexTokens("Straße"); !reflect.DeepEqual(got, []string{"strasse"}) {
		t.Errorf("IndexTokens(%q) = %v, want just the ss form", "Straße", got)
	}
}

// The point of the whole exercise: every spelling of a German name reaches it.
func TestGermanSpellingsAllReachTheName(t *testing.T) {
	cases := []struct{ name, query string }{
		{"München", "München"},
		{"München", "Muenchen"},
		{"München", "Munchen"},
		{"Städtle", "Staedtle"},
		{"Fürstentum Liechtenstein", "Fuerstentum Liechtenstein"},
		{"Grüßgott", "Gruessgott"},
		// Digraph in the data, umlaut or digraph typed.
		{"Muenchen", "München"},
		{"Muenchen", "Muenchen"},
		// Eszett, both directions and both compound spellings.
		{"Schloßstraße", "Schlosstrasse"},
		{"Schloßstraße", "Schlossstrasse"},
		{"Schlosstraße", "Schloßstraße"},
		{"Weißenburg", "Weissenburg"},
		{"Weissenburg", "Weißenburg"},
	}
	for _, c := range cases {
		if !reachable(c.name, c.query) {
			t.Errorf("query %q cannot reach %q: index=%v query=%v",
				c.query, c.name, IndexTokens(c.name), QueryVariants(c.query))
		}
	}
}

// Collapsing ae/oe/ue is a guess, and it must not fire on the vowel pairs that
// are not written-out umlauts at all.
func TestQueryVariantsLeaveOrdinaryVowelPairsAlone(t *testing.T) {
	for _, s := range []string{"Neue", "Aue", "Steuerweg", "Bauernhof", "Museum"} {
		got := QueryVariants(s)
		if len(got) != 1 {
			t.Fatalf("QueryVariants(%q) = %v, want one token", s, got)
		}
		if len(got[0]) != 1 {
			t.Errorf("QueryVariants(%q) = %v, want no alternative spelling", s, got)
		}
	}
}

// Variants widen retrieval only. The counted things — the identity of an anchor
// and the length of its name — must still see real tokens.
func TestVariantsDoNotDisturbTokens(t *testing.T) {
	for _, s := range []string{"München", "Schloßstraße", "Weißenburg"} {
		if n := len(Tokens(s)); n != 1 {
			t.Errorf("Tokens(%q) = %v, want a single token", s, Tokens(s))
		}
	}
	if got := QueryVariants(""); got != nil {
		t.Errorf("QueryVariants(%q) = %v, want nil", "", got)
	}
	if got := IndexTokens(""); got != nil {
		t.Errorf("IndexTokens(%q) = %v, want nil", "", got)
	}
}

// A query token's forms are a set: a duplicate would double-count the term's
// weight on the server.
func TestQueryVariantsAreDistinct(t *testing.T) {
	for _, s := range []string{"München", "Straße", "Muenchen", "Schloßstraße"} {
		for _, forms := range QueryVariants(s) {
			seen := map[string]bool{}
			for _, f := range forms {
				if seen[f] {
					t.Errorf("QueryVariants(%q) repeats %q in %v", s, f, forms)
				}
				seen[f] = true
			}
		}
	}
}

// Japanese, Chinese and Korean addresses, which the whitespace split cannot
// segment because two of the three do not use whitespace.
func TestUnspacedScriptsBecomeBigrams(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		// A ward of Tokyo inside a full address, and typed on its own: the two
		// have to share tokens or the query can never reach the name.
		{"千代田区", []string{"千代", "代田", "田区"}},
		{"東京", []string{"東京"}},
		{"日", []string{"日"}}, // one character has no bigram; it is its own token
		// Digits break the run, which is what makes "2丁目" reachable inside
		// "新宿区西新宿2丁目8-1".
		{"新宿区西新宿2丁目8-1", []string{"新宿", "宿区", "区西", "西新", "新宿", "2", "丁目", "8", "1"}},
		{"北京市朝阳区", []string{"北京", "京市", "市朝", "朝阳", "阳区"}},
		// Korean is written with spaces, so it is left alone.
		{"서울특별시 중구", []string{"서울특별시", "중구"}},
		// And nothing European moves.
		{"Praha", []string{"praha"}},
		{"Nádražní 1", []string{"nadrazni", "1"}},
	}
	for _, c := range cases {
		if got := Tokens(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Tokens(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// The tokens of a part of a name must be a subset of the whole name's, or
// searching for the part finds nothing.
func TestBigramsOfAPartAreContainedInTheWhole(t *testing.T) {
	whole := map[string]bool{}
	for _, t2 := range Tokens("東京都千代田区千代田1-1") {
		whole[t2] = true
	}
	for _, part := range []string{"千代田区", "東京都", "千代田"} {
		for _, t2 := range Tokens(part) {
			if !whole[t2] {
				t.Errorf("token %q of %q is not in the full address", t2, part)
			}
		}
	}
}

// Compatibility forms: a Japanese address is written with full-width digits as
// often as ASCII ones, and half-width katakana turns up in imported data.
func TestCompatibilityFormsFoldToWhatAKeyboardTypes(t *testing.T) {
	cases := []struct{ in, want string }{
		{"１２３", "123"},
		{"ｶﾀｶﾅ", "カタカナ"}, // half-width to full-width, then bigrams below
		{"Ⅻ", "xii"},
		{"№ 5", "no 5"},
		{"㎡", "m2"},
		{"ﬁ", "fi"},
	}
	for _, c := range cases {
		if got := Fold(c.in); got != c.want {
			t.Errorf("Fold(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Dakuten is a combining mark by category and a different sound in fact.
// Stripping it the way a háček is stripped folds ば onto は.
func TestJapaneseVoicingSurvivesFolding(t *testing.T) {
	if Fold("ばなな") == Fold("はなな") {
		t.Error("ばなな and はなな folded together; the dakuten was stripped")
	}
	if Fold("バナナ") == Fold("ハナナ") {
		t.Error("バナナ and ハナナ folded together")
	}
	// Half-width with a separate voicing mark must reach the composed form.
	if got, want := Fold("ｶﾞ"), Fold("ガ"); got != want {
		t.Errorf("half-width ｶﾞ folded to %q, full-width ガ to %q", got, want)
	}
}

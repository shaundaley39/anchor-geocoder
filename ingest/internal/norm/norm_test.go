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

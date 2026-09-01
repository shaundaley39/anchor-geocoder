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

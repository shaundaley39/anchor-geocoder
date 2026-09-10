package catalog

import (
	"path/filepath"
	"testing"
)

func load(t *testing.T) *Catalog {
	t.Helper()
	c, err := Load(filepath.Join("..", "..", "..", "config"))
	if err != nil {
		t.Fatalf("loading the real config: %v", err)
	}
	return c
}

func TestRealConfigParses(t *testing.T) {
	c := load(t)
	if len(c.Countries) < 40 {
		t.Errorf("only %d countries; the config looks truncated", len(c.Countries))
	}
	for code, ct := range c.Countries {
		if ct.Path == "" || ct.Name == "" {
			t.Errorf("%s: incomplete row %+v", code, ct)
		}
		if len(code) < 2 || len(code) > 3 {
			t.Errorf("%s: implausible country code", code)
		}
	}
}

// Every group must name only countries that exist, or a build fails at fetch
// time with a confusing error rather than here.
func TestGroupsReferenceKnownCountries(t *testing.T) {
	c := load(t)
	if len(c.Groups) == 0 {
		t.Fatal("no groups defined")
	}
	for name, members := range c.Groups {
		if len(members) == 0 {
			t.Errorf("group %q is empty", name)
		}
		for _, m := range members {
			if _, ok := c.Countries[m]; !ok {
				t.Errorf("group %q references unknown country %q", name, m)
			}
		}
	}
}

func TestFilenameAndURL(t *testing.T) {
	c := load(t)
	// Paths with a subdirectory must still yield a flat local filename.
	gb := c.Countries["gb"]
	if got := gb.Filename(); got != "great-britain-latest.osm.pbf" {
		t.Errorf("gb filename = %q", got)
	}
	if got := gb.URL(); got != "https://download.geofabrik.de/europe/great-britain-latest.osm.pbf" {
		t.Errorf("gb url = %q", got)
	}
}

func TestResolve(t *testing.T) {
	c := load(t)

	got, err := c.Resolve("cz,pl")
	if err != nil || len(got) != 2 || got[0] != "cz" || got[1] != "pl" {
		t.Errorf("Resolve(cz,pl) = %v, %v", got, err)
	}

	// Groups expand, and order is preserved.
	nordics, err := c.Resolve("@nordics")
	if err != nil {
		t.Fatal(err)
	}
	if len(nordics) != 5 {
		t.Errorf("@nordics = %v, want 5 countries", nordics)
	}

	// Mixing a group with a bare code, and deduplicating the overlap.
	mixed, err := c.Resolve("@baltics,lv,pl")
	if err != nil {
		t.Fatal(err)
	}
	if len(mixed) != 4 { // ee, lv, lt, pl — lv appears once
		t.Errorf("Resolve(@baltics,lv,pl) = %v, want 4 unique", mixed)
	}

	if _, err := c.Resolve("zz"); err == nil {
		t.Error("unknown country should error")
	}
	if _, err := c.Resolve("@nosuchgroup"); err == nil {
		t.Error("unknown group should error")
	}
	if _, err := c.Resolve(" , "); err == nil {
		t.Error("empty selection should error")
	}
}

// The whole-Europe group is what a full run uses; a missing member there is a
// silent coverage hole.
// @world is the group a planet build names, so a country the catalogue holds
// but the group omits is a country that silently never gets indexed.
func TestWorldGroupCoversEveryCountry(t *testing.T) {
	c := load(t)
	inWorld := map[string]bool{}
	for _, m := range c.Groups["world"] {
		inWorld[m] = true
	}
	for code := range c.Countries {
		if !inWorld[code] {
			t.Errorf("country %q is configured but missing from the @world group", code)
		}
	}
}

// The continent groups partition the catalogue: every country in exactly one,
// which is what lets @world be assembled from them and what makes a build of
// one continent mean what it says.
func TestContinentGroupsPartitionTheCatalogue(t *testing.T) {
	c := load(t)
	// Keyed by the Geofabrik path's first segment, which is where the extract
	// actually lives. russia and antarctica are continent-level files.
	group := map[string]string{
		"africa": "africa", "asia": "asia", "australia-oceania": "oceania",
		"central-america": "camerica", "europe": "europe",
		"north-america": "namerica", "south-america": "samerica",
	}
	in := map[string][]string{}
	for name, members := range c.Groups {
		for _, m := range members {
			if name == "world" {
				continue
			}
			if _, ok := groupIsContinent(group, name); ok {
				in[m] = append(in[m], name)
			}
		}
	}
	for code, country := range c.Countries {
		top := country.Path
		if i := indexByte(top, '/'); i >= 0 {
			top = top[:i]
		}
		want, isContinent := group[top]
		if !isContinent {
			continue // russia, antarctica: their own files, in no continent group
		}
		got := in[code]
		if len(got) != 1 || got[0] != want {
			t.Errorf("country %q (%s) is in continent groups %v, want exactly [%s]",
				code, country.Path, got, want)
		}
	}
}

func groupIsContinent(m map[string]string, name string) (string, bool) {
	for _, v := range m {
		if v == name {
			return v, true
		}
	}
	return "", false
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

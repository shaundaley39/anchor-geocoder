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
func TestEuropeGroupCoversEveryCountry(t *testing.T) {
	c := load(t)
	inEurope := map[string]bool{}
	for _, m := range c.Groups["europe"] {
		inEurope[m] = true
	}
	for code := range c.Countries {
		if !inEurope[code] {
			t.Errorf("country %q is configured but missing from the @europe group", code)
		}
	}
}

package model

import (
	"sort"
	"strconv"
	"strings"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
)

// Tag frequencies measured over the full extracts (cmd/tagstat), which is what
// the rules below derive from:
//
//	                        Czechia   Poland
//	  addr:housenumber       100.0%   100.0%
//	  addr:street             52.9%    64.9%   <- absent for ~half of Czechia
//	  addr:place              84.5%    35.3%
//	  addr:city               24.8%    64.5%
//	  addr:conscriptionnumber 85.0%     0.3%
//
// Czechia leans on addr:place, Poland on addr:city, neither guarantees a
// street. Hence the polymorphic anchor.

// Settlement classes, for when no population is tagged.
var placeRank = map[string]float64{
	"city": 1.0, "borough": 0.85, "town": 0.7, "suburb": 0.6,
	"quarter": 0.5, "village": 0.45, "neighbourhood": 0.35,
	"hamlet": 0.25, "isolated_dwelling": 0.1, "municipality": 0.7,
}

// Non-language tags carrying an alternate name. Measured over the Czech extract
// (cmd/namestat): official_name 21,764, alt_name 8,880, short_name 4,311.
var aliasTags = []string{
	"alt_name", "short_name", "official_name", "old_name",
	"loc_name", "int_name", "nat_name", "reg_name", "nickname",
}

// POIs only: "Zabka" and "Ceska posta" are what people type. On a school the
// operator is the municipality, which is noise.
var poiAliasTags = []string{"brand", "operator"}

// Every alternate name from a feature's tags. All name:<lang> variants rather
// than a fixed list — the Czech extract alone carries fourteen languages, and
// picking a subset silently fails queries in the rest.
func collectAltNames(t map[string]string, isPOI bool) []string {
	seen := map[string]bool{t["name"]: true}
	var out []string

	add := func(v string) {
		// Some values are semicolon-delimited lists (1,206 in Czechia).
		for _, part := range strings.Split(v, ";") {
			part = strings.TrimSpace(part)
			if part == "" || seen[part] {
				continue
			}
			seen[part] = true
			out = append(out, part)
		}
	}

	for k, v := range t {
		if v == "" || !strings.HasPrefix(k, "name:") {
			continue
		}
		// name:<lang>, not name:left or name:etymology:wikidata.
		lang := strings.TrimPrefix(k, "name:")
		if lang == "" || len(lang) > 3 || strings.Contains(lang, ":") {
			continue
		}
		add(v)
	}
	for _, k := range aliasTags {
		if v := t[k]; v != "" {
			add(v)
		}
	}
	if isPOI {
		for _, k := range poiAliasTags {
			if v := t[k]; v != "" {
				add(v)
			}
		}
	}
	sort.Strings(out) // deterministic builds
	return out
}

// FromTags returns the records an extracted feature should produce.
//
// Usually one, but a named POI carrying a house number yields two — 10.5% of
// named Czech POIs. Collapsing them would lose either the POI from search or
// the address from the address layer, and so from reverse geocoding.
func FromTags(osmType byte, osmID int64, category string, t map[string]string,
	lat, lon float64, country string, ring []geom.Point, ringClosed bool) []*Record {

	var shape []float64
	if len(ring) >= 4 {
		shape = make([]float64, 0, 2*len(ring))
		for _, p := range ring {
			shape = append(shape, p.Lat, p.Lon)
		}
	}

	base := "osm:" + string(osmType) + strconv.FormatInt(osmID, 10)
	plainAlts := collectAltNames(t, false)
	poiAlts := collectAltNames(t, true)

	newRec := func(idSuffix string, alts []string) *Record {
		return &Record{
			ID: base + idSuffix, Lat: lat, Lon: lon,
			Country: country, AltNames: alts,
			Shape: shape, Closed: ringClosed && len(shape) > 0,
		}
	}

	var out []*Record

	if category != "" {
		r := newRec("#poi", poiAlts)
		buildPOI(r, t, category)
		if r.Display != "" {
			r.Tokens = SearchTokens(r)
			out = append(out, r)
		}
	}

	var r *Record
	switch {
	case hasAddress(t):
		r = newRec("", plainAlts)
		buildAddress(r, t)
	case placeRank[t["place"]] > 0 && t["name"] != "":
		if category != "" {
			return out // already emitted as a POI; do not double-index
		}
		r = newRec("", plainAlts)
		buildPlace(r, t)
	case t["name"] != "" && t["highway"] != "":
		r = newRec("", plainAlts)
		buildStreet(r, t)
	default:
		return out
	}

	if r.Display == "" {
		return out
	}
	r.Tokens = SearchTokens(r)
	return append(out, r)
}

// Address components are retained so the result renders "Restaurace U Fleku,
// Kremencova 11, Praha" and the address tokens stay searchable.
func buildPOI(r *Record, t map[string]string, category string) {
	r.Layer = LayerPOI
	r.Name = t["name"]
	r.Category = category
	r.Street = t["addr:street"]
	r.Place = t["addr:place"]
	r.City = firstNonEmpty(t["addr:city"], t["addr:place"], t["is_in:city"])
	r.Postcode = t["addr:postcode"]
	r.HouseNumber = t["addr:housenumber"]

	parts := []string{r.Name}
	if r.Street != "" {
		if r.HouseNumber != "" {
			parts = append(parts, r.Street+" "+r.HouseNumber)
		} else {
			parts = append(parts, r.Street)
		}
	}
	if r.City != "" && !strings.EqualFold(r.City, r.Name) {
		parts = append(parts, r.City)
	}
	r.Display = strings.Join(parts, ", ")
}

func hasAddress(t map[string]string) bool {
	return t["addr:housenumber"] != "" || t["addr:conscriptionnumber"] != "" ||
		t["addr:provisionalnumber"] != ""
}

func buildAddress(r *Record, t map[string]string) {
	r.Layer = LayerAddress
	r.Conscription = t["addr:conscriptionnumber"]
	// In Czech tagging this is the cislo orientacni, sequential along the street,
	// not a second house number.
	r.Orientation = t["addr:streetnumber"]

	// Present on 100% of addressed features and already composed, so preferred;
	// composition is only for the rare feature carrying parts but not the whole.
	r.HouseNumber = t["addr:housenumber"]
	if r.HouseNumber == "" {
		r.HouseNumber = ComposeCzechNumber(r.Conscription, r.Orientation,
			t["addr:provisionalnumber"])
	}

	r.Street = t["addr:street"]
	r.Place = t["addr:place"]
	r.City = t["addr:city"]
	r.Postcode = t["addr:postcode"]
	if r.City == "" {
		// Czechia tags addr:place four times as often as addr:city.
		r.City = t["addr:place"]
	}
	if s := t["addr:suburb"]; s != "" && r.Place == "" {
		r.Place = s
	}

	_, kind := r.Anchor()
	r.AnchorKind = kind
	r.Display = BuildAddressDisplay(r)
}

func buildPlace(r *Record, t map[string]string) {
	r.Layer = LayerPlace
	r.Name = t["name"]
	r.PlaceType = t["place"]
	r.City = t["name"]
	r.Postcode = t["addr:postcode"]
	if p, err := strconv.ParseInt(strings.ReplaceAll(t["population"], " ", ""), 10, 64); err == nil {
		r.Population = p
	}
	r.Display = t["name"]
}

func buildStreet(r *Record, t map[string]string) {
	r.Layer = LayerStreet
	r.Name = t["name"]
	r.Street = t["name"]
	r.City = firstNonEmpty(t["addr:city"], t["addr:place"], t["is_in:city"])
	r.Postcode = t["addr:postcode"]
	r.AnchorKind = AnchorStreet
	if r.City != "" {
		r.Display = r.Name + ", " + r.City
	} else {
		r.Display = r.Name
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// SearchTokens is the indexed token list. Every component a user might type,
// deduplicated: a query mixes them freely — "Pražská 248 Poděbrady" spans
// three. Exported so the build can re-tokenize after attaching a derived
// locality.
//
// IndexTokens rather than Tokens: retrieval must also answer the other correct
// spellings of a German name, so "München" is indexed under "muenchen" too.
func SearchTokens(r *Record) []string {
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		for _, tok := range norm.IndexTokens(s) {
			if tok != "" && !seen[tok] {
				seen[tok] = true
				out = append(out, tok)
			}
		}
	}

	add(r.Name)
	add(r.Street)
	add(r.Place)
	add(r.City)
	for _, v := range r.AltNames {
		add(v) // exonyms, brands, Cyrillic variants
	}
	if r.Layer == LayerAddress || r.Layer == LayerPOI {
		add(r.HouseNumber)
		// Written "248/39" but typed either way, so both are indexed.
		add(r.Conscription)
		add(r.Orientation)
		add(r.Postcode)
	}
	return out
}

package model

import (
	"sort"
	"strconv"
	"strings"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
)

// Tag frequencies measured over the full 2026-08-31 extracts, which is what the
// rules below are derived from (see cmd/tagstat):
//
//	                        Czechia   Poland
//	  addr:housenumber       100.0%   100.0%
//	  addr:street             52.9%    64.9%   <- absent for ~half of Czechia
//	  addr:place              84.5%    35.3%
//	  addr:city               24.8%    64.5%
//	  addr:conscriptionnumber 85.0%     0.3%
//
// Czechia leans on addr:place, Poland on addr:city, and neither guarantees a
// street. Hence the polymorphic anchor.

// placeRank scores settlement classes when no population is tagged. A city
// outranks a hamlet of the same name, which is what a user almost always means.
var placeRank = map[string]float64{
	"city": 1.0, "borough": 0.85, "town": 0.7, "suburb": 0.6,
	"quarter": 0.5, "village": 0.45, "neighbourhood": 0.35,
	"hamlet": 0.25, "isolated_dwelling": 0.1, "municipality": 0.7,
}

// aliasTags are the non-language tags that carry an alternate name. Measured
// over the Czech extract (cmd/namestat): official_name 21,764, alt_name 8,880,
// short_name 4,311, old_name 2,907, loc_name 974.
var aliasTags = []string{
	"alt_name", "short_name", "official_name", "old_name",
	"loc_name", "int_name", "nat_name", "reg_name", "nickname",
}

// poiAliasTags apply only to points of interest. "Zabka", "Biedronka" and
// "Ceska posta" are what people type; the feature's own name is often the
// branch. 85,128 Czech features carry an operator and 29,537 a brand — but on a
// school the operator is the municipality, which is noise, so these are not
// applied to other layers.
var poiAliasTags = []string{"brand", "operator"}

// collectAltNames gathers every alternate name from a feature's tags.
//
// All name:<lang> variants are taken rather than a fixed language list: the
// Czech extract alone carries de, cs, en, ru, pl, be, hu, sk, uk, fr, ja, nl,
// it and zh, and picking a subset means silently failing queries in the rest.
func collectAltNames(t map[string]string, isPOI bool) []string {
	seen := map[string]bool{t["name"]: true}
	var out []string

	add := func(v string) {
		// A handful of values are semicolon-delimited lists (1,206 in Czechia).
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
		// name:<lang>, not name:left / name:prefix / name:etymology:wikidata.
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

// FromTags converts an extracted OSM feature into the records it should
// produce.
//
// Usually one, but a named POI that also carries a house number yields two:
// the POI itself and the address point underneath it. 10.5% of named Czech POIs
// are tagged this way, and collapsing them into one record would mean either
// losing "Restaurace U Fleku" from search or losing "Kremencova 11" from the
// address layer — and with it from reverse geocoding, which only searches
// addresses.
func FromTags(osmType byte, osmID int64, category string, t map[string]string,
	lat, lon float64, country string) []*Record {

	base := "osm:" + string(osmType) + strconv.FormatInt(osmID, 10)
	plainAlts := collectAltNames(t, false)
	poiAlts := collectAltNames(t, true)

	newRec := func(idSuffix string, alts []string) *Record {
		return &Record{
			ID: base + idSuffix, Lat: lat, Lon: lon,
			Country: country, AltNames: alts,
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

// buildPOI fills in a point of interest. Address components are retained when
// present so the result renders "Restaurace U Fleku, Kremencova 11, Praha"
// rather than a bare name, and so the address tokens are searchable alongside
// it.
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
	// In Czech OSM tagging addr:streetnumber carries the cislo orientacni, the
	// number sequential along the street, not a second house number.
	r.Orientation = t["addr:streetnumber"]

	// addr:housenumber is present on 100% of addressed features in both
	// countries and already holds the composed "248/39" or "ev.38" form, so it
	// is preferred; composition is only a fallback for the rare feature that
	// carries the parts but not the whole.
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
		// Czechia tags the settlement as addr:place four times as often as
		// addr:city, so fall back rather than emit a city-less address.
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

// searchTokens builds the indexed token list. Every component a user might
// plausibly type is folded in, deduplicated, because a query mixes them freely:
// "Pražská 248 Poděbrady" spans street, number and city.
// SearchTokens is exported so the build can re-tokenize a record after
// enriching it with a spatially derived locality.
func SearchTokens(r *Record) []string {
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		for _, tok := range norm.Tokens(s) {
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
		// Czech addresses are written "248/39" but spoken and typed either way,
		// so both numbers are indexed separately in addition to the composed
		// form the fold above already split on the slash.
		add(r.Conscription)
		add(r.Orientation)
		add(r.Postcode)
	}
	return out
}

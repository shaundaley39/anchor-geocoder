package model

import (
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

// langKeys are the name:<lang> variants worth retaining. Serbian and Croatian
// matter for Bosnia (52k name:sr values, largely Cyrillic); German and English
// help cross-border and non-local queries.
var langKeys = []string{"cs", "pl", "sr", "hr", "bs", "de", "en", "sk", "uk"}

// FromTags converts an extracted OSM feature into a Record, or returns nil if
// the feature is not something we index.
func FromTags(osmType byte, osmID int64, t map[string]string, lat, lon float64, country string) *Record {
	r := &Record{
		ID:      "osm:" + string(osmType) + strconv.FormatInt(osmID, 10),
		Lat:     lat,
		Lon:     lon,
		Country: country,
	}

	// Multilingual names, retained for every layer.
	for _, l := range langKeys {
		if v := t["name:"+l]; v != "" {
			if r.Names == nil {
				r.Names = map[string]string{}
			}
			r.Names[l] = v
		}
	}

	switch {
	case hasAddress(t):
		buildAddress(r, t)
	case placeRank[t["place"]] > 0 && t["name"] != "":
		buildPlace(r, t)
	case t["name"] != "" && t["highway"] != "":
		buildStreet(r, t)
	default:
		return nil
	}

	if r.Display == "" {
		return nil
	}
	r.Tokens = SearchTokens(r)
	return r
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
	for _, v := range r.Names {
		add(v) // Cyrillic variants fold to the same Latin tokens
	}
	if r.Layer == LayerAddress {
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

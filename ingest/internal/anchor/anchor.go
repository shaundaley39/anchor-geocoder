// Package anchor turns a pipeline record into the rows the artifact stores: an
// anchor for anything searchable by name, an address for anything with a house
// number.
//
// The importance priors live here too. They decide what "Praha" means when
// forty things are called it, so they are the part of the build most worth
// being able to test on its own.
package anchor

import (
	"math"
	"strings"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/index"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
)

func coord(v float64) int32 { return int32(math.Round(v * index.CoordScale)) }

// PlaceNameKey identifies a settlement by country and folded name, for binding
// an address to the nearest place of that name.
func PlaceNameKey(country uint8, name string) string {
	return string(rune('0'+country)) + "|" + strings.Join(norm.Tokens(name), " ")
}

// Add records a searchable feature, merging it into an existing anchor when one
// already carries the same name in the same place.
func Add(b *index.Builder, r *model.Record) {
	name := r.Name
	if name == "" {
		name = r.Street
	}
	if name == "" {
		return
	}
	layer := index.LayerStreet
	switch r.Layer {
	case model.LayerPlace:
		layer = index.LayerPlace
	case model.LayerPOI:
		layer = index.LayerPOI
	}
	var key string
	switch layer {
	case index.LayerPlace:
		key = index.PlaceKey(r.Country, norm.Tokens(name), r.Lat, r.Lon)
	case index.LayerPOI:
		key = index.POIKey(r.ID)
	default:
		key = index.AnchorKey(r.Country, layer, norm.Tokens(name), norm.Tokens(r.City))
	}
	id, _ := b.AnchorID(key)
	a := &b.Anchors[id]

	// Rare: geoingest already deduplicates within a layer.
	if a.Real {
		b.Counts["anchor_duplicate_key"]++
		if placePrior(r) <= a.Score {
			return
		}
	}
	a.Real = true
	a.NameTokens = shortestNameTokens(name, r.AltNames)
	setGeometry(a, r)
	a.NameID = b.Strings.Intern(name)
	a.LocalID = b.Strings.Intern(r.City)
	a.Lat, a.Lon = coord(r.Lat), coord(r.Lon)
	a.Country = b.CountryID(r.Country)
	a.Tokens = r.Tokens
	a.Layer = layer
	if len(r.AltNames) > 0 {
		a.AltID = b.Strings.Intern(strings.Join(r.AltNames, index.AltSep))
	}

	switch layer {
	case index.LayerPlace:
		a.Score = placePrior(r)
		b.Counts["anchor_place"]++
	case index.LayerPOI:
		a.Score = poiPrior(r)
		a.CatID = b.Strings.Intern(r.Category)
		b.Counts["anchor_poi"]++
	default:
		a.Score = 1
		b.Counts["anchor_street"]++
	}
}

// Importance prior for a POI, same scale. Ordered by what people search for: a
// station or airport is a navigation landmark and outranks a village, a
// hairdresser does not, chain retail sits in between.
func poiPrior(r *model.Record) float32 {
	switch r.Category {
	case "aeroway=aerodrome":
		return 7
	case "railway=station", "public_transport=station":
		return 5.5
	case "amenity=hospital", "amenity=university":
		return 5
	case "natural=peak", "natural=volcano", "natural=glacier",
		"natural=bay", "waterway=river", "natural=water":
		// A named mountain or lake is a landmark of the same standing as a station,
		// and rather more permanent.
		return 5
	case "historic=castle", "tourism=museum", "tourism=zoo", "tourism=theme_park":
		return 4.5
	case "railway=halt", "amenity=bus_station", "amenity=townhall",
		"amenity=college", "tourism=attraction":
		return 4
	case "natural=wood", "natural=beach", "natural=island", "natural=cape",
		"natural=spring", "waterway=waterfall", "mountain_pass=yes",
		"natural=saddle", "natural=cliff", "natural=cave_entrance":
		return 3.5
	case "amenity=theatre", "amenity=cinema", "tourism=gallery",
		"historic=monument", "leisure=stadium", "amenity=library":
		return 3.5
	case "amenity=school", "amenity=place_of_worship", "leisure=park",
		"amenity=police", "amenity=post_office", "railway=tram_stop":
		return 3
	case "tourism=hotel", "amenity=pharmacy", "amenity=fuel",
		"shop=supermarket", "shop=mall", "amenity=marketplace":
		return 2.5
	}
	// Everything else that survived curation: shops, cafes, offices, clinics.
	// Above a plain street, below any settlement.
	return 1.8
}

// The shortest name an anchor is known by, in tokens, which is what bounds
// relevance server-side. Clamped into a byte; anything longer than 255 tokens is
// not a name anyone types.
func shortestNameTokens(name string, alts []string) uint8 {
	shortest := len(norm.Tokens(name))
	for _, alt := range alts {
		if n := len(norm.Tokens(alt)); n > 0 && (shortest == 0 || n < shortest) {
			shortest = n
		}
	}
	if shortest < 1 {
		shortest = 1
	}
	if shortest > 255 {
		shortest = 255
	}
	return uint8(shortest)
}

// Copies a record's outline and box onto its anchor, in fixed point.
func setGeometry(a *index.Anchor, r *model.Record) {
	a.Closed = r.Closed
	if len(r.Shape) < 4 {
		a.Shape = nil
		a.MinLat, a.MaxLat = coord(r.Lat), coord(r.Lat)
		a.MinLon, a.MaxLon = coord(r.Lon), coord(r.Lon)
		return
	}
	a.Shape = make([]int32, len(r.Shape))
	minLat, minLon := math.Inf(1), math.Inf(1)
	maxLat, maxLon := math.Inf(-1), math.Inf(-1)
	for i := 0; i < len(r.Shape); i += 2 {
		lat, lon := r.Shape[i], r.Shape[i+1]
		a.Shape[i], a.Shape[i+1] = coord(lat), coord(lon)
		minLat, maxLat = math.Min(minLat, lat), math.Max(maxLat, lat)
		minLon, maxLon = math.Min(minLon, lon), math.Max(maxLon, lon)
	}
	a.MinLat, a.MinLon = coord(minLat), coord(minLon)
	a.MaxLat, a.MaxLon = coord(maxLat), coord(maxLon)
}

// Importance prior for a settlement, on a scale where a street is 1. Population
// dominates when tagged, class is the fallback, and both are compressed so
// Warsaw does not outscore every street by six orders.
func placePrior(r *model.Record) float32 {
	if r.Layer != model.LayerPlace {
		return 1
	}
	base := map[string]float64{
		"city": 6, "borough": 4.5, "municipality": 4, "town": 3.5,
		"suburb": 2.5, "quarter": 2, "village": 2,
		"neighbourhood": 1.5, "hamlet": 1.2, "isolated_dwelling": 1,
	}[r.PlaceType]
	if base == 0 {
		base = 1
	}
	if r.Population > 0 {
		base += math.Log10(float64(r.Population)) // +6 for a million-person city
	}
	return float32(base)
}

// AddAddress hangs a house number off the anchor its street or place names,
// creating a placeholder anchor when that name was never mapped in its own right.
func AddAddress(b *index.Builder, r *model.Record, placesByName map[string][]uint32) {
	anchorName, kind := r.Anchor()
	if anchorName == "" {
		// Nothing to hang the number off: 4,460 of 11.6M, left out rather than
		// indexed unfindably.
		b.Counts["address_no_anchor"]++
		return
	}
	cc := b.CountryID(r.Country)

	var id uint32
	if kind == model.AnchorPlace {
		// Nearest real place of that name. Candidate lists are tiny, so a linear scan
		// beats a spatial index.
		cands := placesByName[PlaceNameKey(cc, anchorName)]
		best, bestD := uint32(0), math.MaxFloat64
		found := false
		for _, c := range cands {
			a := &b.Anchors[c]
			dLat := float64(a.Lat)/index.CoordScale - r.Lat
			dLon := (float64(a.Lon)/index.CoordScale - r.Lon) *
				math.Cos(r.Lat*math.Pi/180)
			if d := dLat*dLat + dLon*dLon; d < bestD {
				best, bestD, found = c, d, true
			}
		}
		if found {
			id = best
			b.Counts["address_bound_to_place"]++
		} else {
			id = b.NewSynthetic(anchorName, r.City, cc, index.LayerPlace,
				b.Strings, append(norm.Tokens(anchorName), norm.Tokens(r.City)...),
				coord(r.Lat), coord(r.Lon))
			b.Counts["anchor_synthetic_place"]++
		}
	} else {
		key := index.AnchorKey(r.Country, index.LayerStreet,
			norm.Tokens(anchorName), norm.Tokens(r.City))
		var created bool
		id, created = b.AnchorID(key)
		if created {
			// In addr:street but never mapped as a highway.
			a := &b.Anchors[id]
			a.NameID = b.Strings.Intern(anchorName)
			a.LocalID = b.Strings.Intern(r.City)
			a.Country = cc
			a.Layer = index.LayerStreet
			a.Score = 1
			a.Tokens = append(norm.Tokens(anchorName), norm.Tokens(r.City)...)
			b.Counts["anchor_synthetic_street"]++
		}
	}

	b.Addrs = append(b.Addrs, index.Address{
		AnchorID: id,
		NumID:    b.Strings.Intern(r.HouseNumber),
		Lat:      coord(r.Lat),
		Lon:      coord(r.Lon),
		SortKey:  index.LeadingInt(r.HouseNumber),
	})
}

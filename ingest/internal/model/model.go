// Package model defines the normalized records the ingest stage emits.
//
// The schema is deliberately wider than the classic {housenumber, street, city}
// triple. Roughly 47% of Czech address points carry no addr:street at all: they
// hang off addr:place (the "cast obce", a municipality part) and are identified
// by a conscription number. Poland uses the street model for most urban
// addresses but falls back to addr:place across much of the countryside. A
// schema that assumes a street exists silently drops half of Czechia.
package model

import "strings"

// Layer is the result class of a record. Ordering matters: the geocoder ranks
// more specific layers above less specific ones when scores are otherwise close.
type Layer string

const (
	LayerAddress Layer = "address"
	LayerStreet  Layer = "street"
	LayerPlace   Layer = "place"
	LayerPOI     Layer = "poi"
)

// LayerRank gives the ranking prior for a layer. Higher wins.
func LayerRank(l Layer) float64 {
	switch l {
	case LayerAddress:
		return 3
	case LayerPOI:
		return 2.5
	case LayerStreet:
		return 2
	case LayerPlace:
		return 1
	}
	return 0
}

// AnchorKind records which field a record's address hangs off.
type AnchorKind string

const (
	AnchorStreet AnchorKind = "street" // addr:street — the usual case
	AnchorPlace  AnchorKind = "place"  // addr:place  — CZ cast obce, PL rural
	AnchorNone   AnchorKind = "none"   // neither; only usable via city/postcode
)

// Record is one normalized, geocodable feature.
type Record struct {
	ID    string `json:"id"` // stable across rebuilds, e.g. "osm:n1234"
	Layer Layer  `json:"layer"`

	// Name is the feature's own display name: the street name for a street,
	// the settlement name for a place, empty for most address points.
	Name string `json:"name,omitempty"`
	// AltNames holds every other name the feature is known by: name:<lang>
	// exonyms, alt_name, short_name, official_name, old_name, and for POIs the
	// brand and operator. Each is a searchable name in its own right — "Prague"
	// and "Praha" are the same city, and a user may type either.
	//
	// These are scored per variant rather than merged, so a query matching one
	// alias exactly is treated as an exact name match. Merging them into one
	// token bag would make every well-documented place look like it has a very
	// long name and score worse for it.
	AltNames []string `json:"alt_names,omitempty"`

	// --- address components -------------------------------------------------

	// HouseNumber is the rendered, human-facing number. For Czech addresses
	// this is the composed "conscription/orientation" form, e.g. "729/37".
	HouseNumber string `json:"house_number,omitempty"`
	// Conscription is the Czech cislo popisne (c.p.), unique within a cast obce.
	Conscription string `json:"conscription,omitempty"`
	// Orientation is the Czech cislo orientacni (c.o.), sequential along a street.
	Orientation string `json:"orientation,omitempty"`

	Street   string `json:"street,omitempty"`
	Place    string `json:"place,omitempty"` // cast obce / rural locality
	City     string `json:"city,omitempty"`
	Postcode string `json:"postcode,omitempty"`

	AnchorKind AnchorKind `json:"anchor_kind,omitempty"`

	Country string `json:"country"` // ISO-3166-1 alpha-2, lowercased

	// --- geometry -----------------------------------------------------------

	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`

	// --- ranking inputs -----------------------------------------------------

	PlaceType  string `json:"place_type,omitempty"` // city|town|village|hamlet|suburb...
	Population int64  `json:"population,omitempty"`
	// Category is the POI classification, "key=value" as tagged in OSM
	// (amenity=restaurant, railway=station, shop=supermarket...).
	Category string `json:"category,omitempty"`

	// Search text, precomputed by the normalizer so the server never has to.
	// Tokens is the folded, transliterated token list actually indexed.
	Tokens []string `json:"tokens,omitempty"`
	// Display is the human-facing one-line rendering returned to API callers.
	Display string `json:"display"`
}

// Anchor returns the addressing anchor and its kind. This is the join key that
// groups address points into a searchable unit; see the package comment.
func (r *Record) Anchor() (string, AnchorKind) {
	if r.Street != "" {
		return r.Street, AnchorStreet
	}
	if r.Place != "" {
		return r.Place, AnchorPlace
	}
	return "", AnchorNone
}

// ComposeCzechNumber renders the Czech two-number form. A Czech address may
// carry a conscription number (c.p.), an orientation number (c.o.), or both:
//
//	both  -> "729/37"   (as written on the building)
//	c.p.  -> "729"
//	c.o.  -> "37"
//
// fallback is used when neither is present (a plain addr:housenumber).
func ComposeCzechNumber(conscription, orientation, fallback string) string {
	switch {
	case conscription != "" && orientation != "":
		return conscription + "/" + orientation
	case conscription != "":
		return conscription
	case orientation != "":
		return orientation
	default:
		return fallback
	}
}

// Display builds the one-line rendering for an address record, skipping empty
// components. Czech village addresses render as "Cerna Hora 42", street
// addresses as "Dlouha 729/37, Praha".
func BuildAddressDisplay(r *Record) string {
	var head string
	anchor, _ := r.Anchor()
	switch {
	case anchor != "" && r.HouseNumber != "":
		head = anchor + " " + r.HouseNumber
	case anchor != "":
		head = anchor
	default:
		head = r.HouseNumber
	}

	parts := []string{head}
	// Only add the city when it differs from the anchor, so a village address
	// anchored on its own name doesn't render as "Cerna Hora 42, Cerna Hora".
	if r.City != "" && !strings.EqualFold(r.City, anchor) {
		parts = append(parts, r.City)
	}
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, ", ")
}

// Package model defines the normalized records the ingest stage emits.
//
// The schema is wider than the classic {housenumber, street, city} because 47%
// of Czech addresses have no street: they hang off addr:place (the cast obce)
// with a conscription number. Poland uses both models. Assuming a street exists
// silently drops half of Czechia.
package model

import "strings"

// Layer is the result class of a record.
type Layer string

const (
	LayerAddress Layer = "address"
	LayerStreet  Layer = "street"
	LayerPlace   Layer = "place"
	LayerPOI     Layer = "poi"
)

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
	// Every other name the feature is known by: name:<lang> exonyms, alt_name,
	// short_name, official_name, old_name, and for POIs brand and operator.
	//
	// Scored per variant, not merged: merging would make a well-documented
	// place look like it has a very long name and rank worse for it.
	AltNames []string `json:"alt_names,omitempty"`

	// --- address components -------------------------------------------------

	// The rendered form: for Czech addresses the composed "729/37".
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

	// The feature's outline, flattened as [lat,lon,lat,lon,...]. Present for
	// area features large enough for their shape to matter, and for long
	// streets, where it is sampled points rather than a ring.
	//
	// Reverse needs it: a click inside a park is inside it however far the
	// centroid is, and a bounding box is a poor stand-in for a crescent.
	Shape []float64 `json:"shape,omitempty"`
	// A ring can contain a point; sampled points along a line cannot.
	Closed bool `json:"closed,omitempty"`

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

// The addressing anchor and its kind: the join key grouping address points into
// a searchable unit.
func (r *Record) Anchor() (string, AnchorKind) {
	if r.Street != "" {
		return r.Street, AnchorStreet
	}
	if r.Place != "" {
		return r.Place, AnchorPlace
	}
	return "", AnchorNone
}

// Renders the Czech two-number form: conscription and orientation give
// "729/37", either alone gives itself, neither falls back.
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

// One-line rendering, skipping empty components: "Cerna Hora 42" for a village
// address, "Dlouha 729/37, Praha" for a street one.
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
	// Skipped when it equals the anchor, or a village address renders as
	// "Cerna Hora 42, Cerna Hora".
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

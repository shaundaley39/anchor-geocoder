// The rows the artifact is built from: one Anchor per searchable name, one
// Address per house number hanging off it.

package index

import (
	"strconv"
)

// Anchor is a searchable street, place or POI: what text queries match against.
type Anchor struct {
	Key      string // country|folded name|folded locality — dedup key only
	NameID   uint32
	LocalID  uint32 // locality (city) string id
	Lat, Lon int32
	Layer    uint8
	Country  uint8
	Score    float32 // importance prior, pre-multiplied at build time
	CatID    uint32  // POI category string id; 0 for non-POI anchors
	// AltID is a string id whose value is the anchor's alternate names joined by
	// AltSep. Stored rather than discarded after tokenizing because ranking has to
	// know that "Prague" is a *name* of Praha, not incidental context.
	AltID     uint32
	Tokens    []string
	AddrStart uint32
	AddrCount uint32
	// Real distinguishes an anchor built from an actual street or place record
	// from a placeholder synthesised because an address referenced a name that was
	// never mapped in its own right.
	Real bool

	// BBox in fixed point. Degenerate to the representative point when the feature
	// has no extent, so every anchor can live in one spatial index.
	MinLat, MinLon, MaxLat, MaxLon int32
	// Shape is the simplified outline as fixed-point lat/lon pairs, empty when the
	// feature is small enough that its representative point suffices.
	Shape []int32
	// Closed marks a ring, which can contain a click, as against a street's
	// sampled points, which can only be measured to.
	Closed bool
	// NameTokens is the token count of the *shortest* name this anchor is known
	// by. The server bounds relevance with it: a query of q tokens can use at most
	// min(q, n)/n of an n-token name, and only an equal-length name can be an
	// exact match. Shortest, because relevance takes the best variant.
	NameTokens uint8
}

// Address is one address point, in a run belonging to a single anchor.
type Address struct {
	AnchorID uint32
	NumID    uint32 // house number string id
	Lat, Lon int32
	// Leading integer of the house number. Runs sort by it, so a numeric lookup is
	// a binary search and results come back in street order.
	SortKey uint32
}

// LeadingInt is the first run of digits: Czech numbers are
// "conscription/orientation" and Polish ones carry letter suffixes, so it is
// the only comparable part.
func LeadingInt(s string) uint32 {
	start := -1
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			start = i
			break
		}
	}
	if start < 0 {
		return 0
	}
	end := start
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	// Capped, so an absurd OSM value cannot wrap and sort first.
	n, err := strconv.ParseUint(s[start:end], 10, 32)
	if err != nil {
		return 0
	}
	if n > 1<<31 {
		return 1 << 31
	}
	return uint32(n)
}

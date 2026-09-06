// Identity keys. Two records collapse into one anchor when their keys match, so
// what goes into a key decides what counts as "the same place".

package index

import (
	"math"
	"strconv"
	"strings"
)

// The dedup key joining addresses to their anchor, computed identically for
// street records, place records and addresses.
//
// Layer is part of it: without that a street named after the village it runs
// through collides with the village, and one silently overwrites the other.
func AnchorKey(country string, layer uint8, foldedName, foldedLocality []string) string {
	l := "s"
	if layer == LayerPlace {
		l = "p"
	}
	return country + "|" + l + "|" + strings.Join(foldedName, " ") +
		"|" + strings.Join(foldedLocality, " ")
}

// geoingest already collapsed node-and-way duplicates, so this only keeps
// genuinely distinct POIs apart — hence the OSM id.
func POIKey(id string) string { return "poi|" + id }

// Dedup key for a settlement. A place's locality is its own name, so AnchorKey
// alone merges every same-named village — and "Nowa Wies" names hundreds. A
// ~28km cell keeps them apart while still collapsing node-and-area pairs.
//
// Addresses bind by nearest matching name instead, so a village near a cell
// boundary still gathers its own.
func PlaceKey(country string, foldedName []string, lat, lon float64) string {
	const cellDeg = 0.25
	return country + "|p|" + strings.Join(foldedName, " ") + "|" +
		strconv.Itoa(int(math.Floor(lat/cellDeg))) + "," +
		strconv.Itoa(int(math.Floor(lon/cellDeg)))
}

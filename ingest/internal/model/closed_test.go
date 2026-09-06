package model

import (
	"testing"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
)

// A linear way must never be marked as a ring. The Vltava is tagged
// waterway=river and mapped as an open centreline; treated as closed, ray
// casting joins its endpoints into an 11km lens that reported Old Town Square,
// 300m inland, as inside the river.
func TestLinearWayIsNotClosed(t *testing.T) {
	line := []geom.Point{
		{Lat: 50.00, Lon: 14.40}, {Lat: 50.02, Lon: 14.41},
		{Lat: 50.04, Lon: 14.42}, {Lat: 50.06, Lon: 14.43},
	}
	recs := FromTags('w', 1, "waterway=river",
		map[string]string{"name": "Vltava", "waterway": "river"},
		50.03, 14.415, "cz", line, false)
	if len(recs) == 0 {
		t.Fatal("expected a record")
	}
	for _, r := range recs {
		if r.Closed {
			t.Error("an open way was marked as a closed ring")
		}
		if len(r.Shape) == 0 {
			t.Error("the shape was dropped; distance still needs it")
		}
	}
}

func TestClosedWayKeepsItsRing(t *testing.T) {
	ring := []geom.Point{
		{Lat: 50.00, Lon: 14.40}, {Lat: 50.00, Lon: 14.41},
		{Lat: 50.01, Lon: 14.41}, {Lat: 50.00, Lon: 14.40},
	}
	recs := FromTags('w', 2, "leisure=park",
		map[string]string{"name": "Stromovka", "leisure": "park"},
		50.005, 14.405, "cz", ring, true)
	var sawClosed bool
	for _, r := range recs {
		if r.Closed {
			sawClosed = true
		}
	}
	if !sawClosed {
		t.Error("a closed way lost its ring")
	}
}

package streets

import (
	"math"
	"strings"
	"testing"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
)

func place(name, class string, lat, lon float64) *model.Record {
	return &model.Record{
		Name: name, PlaceType: class, Lat: lat, Lon: lon,
		Country: "cz", Layer: model.LayerPlace,
	}
}

func segment(name string, lat, lon float64) Segment {
	return Segment{
		Rec:     &model.Record{Name: name, Country: "cz", Layer: model.LayerStreet},
		Lat:     lat,
		Lon:     lon,
		Country: "cz",
	}
}

// The bug this whole mechanism exists for: OSM tags a locality on addresses but
// not on roads, so grouping on the tag alone merged every same-named street in
// the country into one result.
func TestGroupSeparatesSameNameInDifferentTowns(t *testing.T) {
	places := map[string]*model.Record{
		"a": place("Alpha", "town", 50.00, 14.00),
		"b": place("Beta", "town", 51.00, 15.00),
	}
	segs := []Segment{
		segment("Nadrazni", 50.001, 14.001),
		segment("Nadrazni", 50.002, 14.002),
		segment("Nadrazni", 51.001, 15.001),
	}
	got := Group(segs, NewCatchment(places), map[string]int{})
	if len(got) != 2 {
		t.Fatalf("want 2 streets (one per town), got %d", len(got))
	}
	for _, agg := range got {
		if agg.Rec.City != "Alpha" && agg.Rec.City != "Beta" {
			t.Errorf("street assigned to %q", agg.Rec.City)
		}
	}
}

// Catchment is the point: a city claims streets far from its centre, a hamlet
// only claims what is on top of it. Without this a street on the edge of Prague
// goes to whichever village sits just past the city limit.
func TestCatchmentLetsTheCityWinAtDistance(t *testing.T) {
	// 8km from the city, 3km from the hamlet. Nearest wins on raw distance;
	// catchment-scored, the city should win: 8/15 < 3/1.2.
	places := map[string]*model.Record{
		"city":   place("Metropolis", "city", 50.000, 14.000),
		"hamlet": place("Tinyville", "hamlet", 50.100, 14.000),
	}
	segs := []Segment{segment("Hlavni", 50.072, 14.000)}
	got := Group(segs, NewCatchment(places), map[string]int{})
	for _, agg := range got {
		if agg.Rec.City != "Metropolis" {
			t.Errorf("want Metropolis, got %q", agg.Rec.City)
		}
	}
}

func TestNothingClaimsAStreetBeyondEveryCatchment(t *testing.T) {
	places := map[string]*model.Record{"h": place("Tinyville", "hamlet", 50.0, 14.0)}
	// 5km out, well past a hamlet's 1.2km.
	got := Group([]Segment{segment("Polni", 50.045, 14.0)}, NewCatchment(places), map[string]int{})
	for _, agg := range got {
		if agg.Rec.City != "" {
			t.Errorf("want no locality, got %q", agg.Rec.City)
		}
	}
}

func TestAnExplicitTagBeatsTheSpatialGuess(t *testing.T) {
	places := map[string]*model.Record{"c": place("Metropolis", "city", 50.0, 14.0)}
	seg := segment("Krátká", 50.001, 14.001)
	seg.Rec.City = "Somewhere Else"
	got := Group([]Segment{seg}, NewCatchment(places), map[string]int{})
	for _, agg := range got {
		if agg.Rec.City != "Somewhere Else" {
			t.Errorf("spatial guess overrode an explicit addr:city: %q", agg.Rec.City)
		}
	}
}

// A street's point must sit on the street. The mean of an L-shaped street falls
// off it, so Finalize picks the sampled point nearest the mean instead.
func TestFinalizePicksAPointOnTheStreet(t *testing.T) {
	a := &Aggregate{Rec: &model.Record{Name: "L"}}
	corner := [][2]float64{{50.00, 14.00}, {50.00, 14.01}, {50.01, 14.01}}
	for _, p := range corner {
		a.Add(p[0], p[1])
	}
	a.Finalize()

	onStreet := false
	for _, p := range corner {
		if math.Abs(a.Rec.Lat-p[0]) < 1e-9 && math.Abs(a.Rec.Lon-p[1]) < 1e-9 {
			onStreet = true
		}
	}
	if !onStreet {
		t.Errorf("point (%.5f, %.5f) is not one of the sampled points", a.Rec.Lat, a.Rec.Lon)
	}
}

func TestSegmentsCountsWhatMerged(t *testing.T) {
	places := map[string]*model.Record{"c": place("Metropolis", "city", 50.0, 14.0)}
	segs := []Segment{
		segment("Dlouha", 50.001, 14.001),
		segment("Dlouha", 50.002, 14.002),
		segment("Dlouha", 50.003, 14.003),
	}
	got := Group(segs, NewCatchment(places), map[string]int{})
	if len(got) != 1 {
		t.Fatalf("want 1 street, got %d", len(got))
	}
	for _, agg := range got {
		if agg.Segments() != 3 {
			t.Errorf("want 3 segments merged, got %d", agg.Segments())
		}
	}
}

// POIs were left out of locality assignment entirely: a POI got one only from
// its own addr:city. That broke ranking between namesakes, since the locality
// prior had nothing to work with.
func TestResolvePOILocalitiesFillsTheGap(t *testing.T) {
	places := map[string]*model.Record{
		"c": place("Metropolis", "city", 50.0, 14.0),
	}
	pois := map[string]*model.Record{
		"a": {Name: "Sagrada Familia", Display: "Sagrada Familia", Country: "cz",
			Layer: model.LayerPOI, Lat: 50.002, Lon: 14.002},
		// Already tagged: must not be overwritten.
		"b": {Name: "Museum", Display: "Museum, Elsewhere", City: "Elsewhere",
			Country: "cz", Layer: model.LayerPOI, Lat: 50.003, Lon: 14.003},
		// Too far for any catchment.
		"c": {Name: "Remote Hut", Display: "Remote Hut", Country: "cz",
			Layer: model.LayerPOI, Lat: 52.0, Lon: 18.0},
	}
	counts := map[string]int{}
	ResolvePOILocalities(pois, NewCatchment(places), counts)

	if got := pois["a"].City; got != "Metropolis" {
		t.Errorf("nearby POI got city %q, want Metropolis", got)
	}
	if !strings.Contains(pois["a"].Display, "Metropolis") {
		t.Errorf("display not updated: %q", pois["a"].Display)
	}
	if got := pois["b"].City; got != "Elsewhere" {
		t.Errorf("an explicit addr:city was overwritten with %q", got)
	}
	if got := pois["c"].City; got != "" {
		t.Errorf("a POI outside every catchment got %q", got)
	}
	if counts["poi_locality_resolved"] != 1 {
		t.Errorf("resolved count %d, want 1", counts["poi_locality_resolved"])
	}
}

// A POI named after the settlement it is in must not become "Vaduz, Vaduz".
func TestResolvePOILocalitiesSkipsSelfNaming(t *testing.T) {
	places := map[string]*model.Record{"c": place("Vaduz", "town", 47.14, 9.52)}
	pois := map[string]*model.Record{
		"a": {Name: "Vaduz", Display: "Vaduz", Country: "li",
			Layer: model.LayerPOI, Lat: 47.141, Lon: 9.521},
	}
	ResolvePOILocalities(pois, NewCatchment(places), map[string]int{})
	if pois["a"].Display != "Vaduz" {
		t.Errorf("display became %q", pois["a"].Display)
	}
}

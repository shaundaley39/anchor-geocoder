package anchor

import (
	"testing"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
)

func settlement(class string, pop int64) *model.Record {
	return &model.Record{Layer: model.LayerPlace, PlaceType: class, Population: pop}
}

// The prior decides what "Praha" means when forty things are called it, so the
// ordering between classes is the part worth pinning down. The exact numbers
// are tunable; the order is not.
func TestPlacePriorOrdersSettlementClasses(t *testing.T) {
	descending := []string{
		"city", "borough", "municipality", "town",
		"suburb", "quarter", "neighbourhood", "hamlet", "isolated_dwelling",
	}
	for i := 1; i < len(descending); i++ {
		hi := placePrior(settlement(descending[i-1], 0))
		lo := placePrior(settlement(descending[i], 0))
		if hi < lo {
			t.Errorf("%s (%.2f) ranks below %s (%.2f)",
				descending[i-1], hi, descending[i], lo)
		}
	}
}

// Log, not linear: Prague at 1.3M should not outrank Brno at 380k by 3.4x, or
// population swamps every other signal.
func TestPopulationContributesOnALogScale(t *testing.T) {
	small := placePrior(settlement("city", 100_000))
	big := placePrior(settlement("city", 1_000_000))
	if gap := big - small; gap < 0.9 || gap > 1.1 {
		t.Errorf("a 10x population gap moved the prior by %.2f, want ~1", gap)
	}
}

func TestPlacePriorIgnoresNonPlaces(t *testing.T) {
	street := &model.Record{Layer: model.LayerStreet, PlaceType: "city", Population: 5_000_000}
	if got := placePrior(street); got != 1 {
		t.Errorf("a street took a settlement prior: %.2f", got)
	}
}

func TestUnknownPlaceTypeGetsTheFloorNotZero(t *testing.T) {
	if got := placePrior(settlement("borough_of_nowhere", 0)); got != 1 {
		t.Errorf("want the floor of 1, got %.2f", got)
	}
}

// A landmark has to beat a corner shop, and a bare street, or a query for a
// mountain returns the cafe named after it.
func TestPoiPriorRanksLandmarksAboveOrdinaryPlaces(t *testing.T) {
	cases := []struct{ better, worse string }{
		{"aeroway=aerodrome", "railway=station"},
		{"railway=station", "railway=tram_stop"},
		{"natural=peak", "tourism=hotel"},
		{"historic=castle", "shop=supermarket"},
		{"amenity=hospital", "amenity=pharmacy"},
	}
	for _, c := range cases {
		hi := poiPrior(&model.Record{Category: c.better})
		lo := poiPrior(&model.Record{Category: c.worse})
		if hi <= lo {
			t.Errorf("%s (%.1f) does not beat %s (%.1f)", c.better, hi, c.worse, lo)
		}
	}
}

// Everything uncurated lands above a plain street and below any settlement,
// which is what keeps a cafe from answering a query for the village it is in.
func TestUncategorisedPoiSitsBetweenStreetAndSettlement(t *testing.T) {
	got := poiPrior(&model.Record{Category: "shop=hairdresser"})
	if got <= 1 {
		t.Errorf("a POI (%.2f) does not beat a plain street (1.0)", got)
	}
	if smallest := placePrior(settlement("isolated_dwelling", 0)); got > smallest+1 {
		t.Errorf("a POI (%.2f) outranks the smallest settlement (%.2f)", got, smallest)
	}
}

func TestShortestNameTokensPicksTheShortestVariant(t *testing.T) {
	// The server bounds relevance with this, so it must be the shortest: a
	// longer one would claim more of the query can be matched than really can.
	got := shortestNameTokens("Hlavní nádraží Praha", []string{"Praha", "Prague Main Station"})
	if got != 1 {
		t.Errorf("want 1 (from the alias %q), got %d", "Praha", got)
	}
}

func TestShortestNameTokensNeverReturnsZero(t *testing.T) {
	if got := shortestNameTokens("", nil); got != 1 {
		t.Errorf("want the floor of 1, got %d", got)
	}
}

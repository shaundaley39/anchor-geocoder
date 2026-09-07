package pbf

import (
	"testing"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
)

func way(first, last int64, pts ...[2]float64) memberWay {
	gp := make([]geom.Point, len(pts))
	for i, p := range pts {
		gp[i] = geom.Point{Lat: p[0], Lon: p[1]}
	}
	return memberWay{first: first, last: last, pts: gp}
}

// The case that matters: OSM splits a ring across many ways, in arbitrary order
// and either direction. Prague's airport is 68 of them.
func TestAssembleRingsJoinsOutOfOrderAndReversedWays(t *testing.T) {
	// A unit square, split into four ways given out of order, two reversed.
	ms := []memberWay{
		way(3, 4, [2]float64{1, 1}, [2]float64{0, 1}), // top-right -> top-left
		way(1, 2, [2]float64{0, 0}, [2]float64{1, 0}), // bottom
		way(4, 1, [2]float64{0, 1}, [2]float64{0, 0}), // left, closes
		way(3, 2, [2]float64{1, 1}, [2]float64{1, 0}), // right, reversed
	}
	rings := assembleRings(ms)
	if len(rings) != 1 {
		t.Fatalf("want 1 ring, got %d", len(rings))
	}
	r := rings[0]
	if r[0] != r[len(r)-1] {
		t.Errorf("ring is not closed: %v .. %v", r[0], r[len(r)-1])
	}
	if got := absShoelace(r); got < 0.9 || got > 1.1 {
		t.Errorf("unit square came out with area %.3f", got)
	}
}

// An unclosed chain is broken data. Dropping it is right; forcing it shut
// invents a boundary that was never mapped.
func TestAssembleRingsDropsAnUnclosedChain(t *testing.T) {
	ms := []memberWay{
		way(1, 2, [2]float64{0, 0}, [2]float64{1, 0}),
		way(2, 3, [2]float64{1, 0}, [2]float64{1, 1}),
	}
	if got := assembleRings(ms); len(got) != 0 {
		t.Errorf("want no ring from an open chain, got %d", len(got))
	}
}

func TestAssembleRingsSeparatesTwoRings(t *testing.T) {
	ms := []memberWay{
		way(1, 1, [2]float64{0, 0}, [2]float64{1, 0}, [2]float64{1, 1}, [2]float64{0, 0}),
		way(2, 2, [2]float64{5, 5}, [2]float64{9, 5}, [2]float64{9, 9}, [2]float64{5, 5}),
	}
	rings := assembleRings(ms)
	if len(rings) != 2 {
		t.Fatalf("want 2 rings, got %d", len(rings))
	}
	// The larger is the one indexed.
	if got := absShoelace(largestRing(rings)); got < 7 {
		t.Errorf("largestRing picked the smaller one (area %.1f)", got)
	}
}

// A stitched ring can self-intersect, and then the shoelace areas cancel: the
// divisor comes out small without being small enough to look degenerate, and
// the centroid flies off the map. One Norwegian multipolygon produced latitude
// 94.2, whose cosine is negative — enough to turn a bounded spatial walk into
// ten million iterations.
func TestRepresentativePointStaysInsideTheRing(t *testing.T) {
	// A figure-eight: two lobes of opposite winding, so the areas cancel.
	pts := [][2]float64{
		{60.0, 5.0}, {60.1, 5.0}, {60.1, 5.1}, {60.0, 5.1},
		{60.0, 5.0}, {59.9, 5.0}, {59.9, 4.9}, {60.0, 4.9}, {60.0, 5.0},
	}
	lat, lon := representativePoint(pts, true)
	if lat < 59.9 || lat > 60.1 || lon < 4.9 || lon > 5.1 {
		t.Errorf("centroid (%.4f, %.4f) is outside the ring's own bounds", lat, lon)
	}
}

func TestRepresentativePointRejectsImpossibleLatitude(t *testing.T) {
	// Whatever the geometry, the answer has to be a coordinate.
	pts := [][2]float64{{89.9, 10.0}, {89.95, 10.001}, {89.9, 10.002}, {89.9, 10.0}}
	lat, _ := representativePoint(pts, true)
	if lat > 90 || lat < -90 {
		t.Errorf("returned latitude %.4f", lat)
	}
}

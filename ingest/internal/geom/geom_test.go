package geom

import (
	"math"
	"testing"
)

func TestSimplifyKeepsEndpointsAndShape(t *testing.T) {
	// A square with many redundant collinear points along each edge.
	var ring []Point
	for i := 0; i <= 40; i++ {
		ring = append(ring, Point{Lat: 50.0, Lon: 14.0 + float64(i)*0.001})
	}
	for i := 1; i <= 40; i++ {
		ring = append(ring, Point{Lat: 50.0 + float64(i)*0.001, Lon: 14.04})
	}
	out := Simplify(ring, 10, 64)
	if len(out) > 6 {
		t.Errorf("collinear runs should collapse; got %d points from %d", len(out), len(ring))
	}
	if out[0] != ring[0] || out[len(out)-1] != ring[len(ring)-1] {
		t.Error("endpoints must be preserved")
	}
}

func TestSimplifyRespectsMaxPoints(t *testing.T) {
	// A circle: Douglas-Peucker cannot drop anything at a tight tolerance, so
	// only the hard cap bounds it.
	var ring []Point
	for i := 0; i < 2000; i++ {
		a := 2 * math.Pi * float64(i) / 2000
		ring = append(ring, Point{Lat: 50 + 0.05*math.Sin(a), Lon: 14 + 0.05*math.Cos(a)})
	}
	out := Simplify(ring, 1, 32)
	if len(out) > 32 {
		t.Errorf("cap not applied: %d points", len(out))
	}
	if len(out) < 8 {
		t.Errorf("over-thinned a circle to %d points", len(out))
	}
}

func TestSimplifyShortInputUntouched(t *testing.T) {
	pts := []Point{{50, 14}, {51, 15}}
	if got := Simplify(pts, 10, 32); len(got) != 2 {
		t.Errorf("got %d points, want 2", len(got))
	}
}

func TestBoundsAndDiagonal(t *testing.T) {
	b := Bounds([]Point{{50, 14}, {50.01, 14.02}, {49.99, 13.99}})
	if b.MinLat != 49.99 || b.MaxLat != 50.01 || b.MinLon != 13.99 || b.MaxLon != 14.02 {
		t.Errorf("bounds wrong: %+v", b)
	}
	// ~2.2km north-south, ~2.2km east-west at this latitude.
	if d := b.DiagonalMetres(); d < 2000 || d > 4000 {
		t.Errorf("diagonal %.0fm outside the expected range", d)
	}
}

func TestEmptyBoundsHasZeroDiagonal(t *testing.T) {
	if d := Bounds(nil).DiagonalMetres(); d != 0 {
		t.Errorf("empty bounds diagonal = %v, want 0", d)
	}
}

package spatial

import (
	"math"
	"math/rand"
	"testing"
)

func TestDistanceKnownPairs(t *testing.T) {
	// Prague -> Brno is ~184km; Prague -> Warsaw ~517km.
	if d := DistanceKm(50.0755, 14.4378, 49.1951, 16.6068); math.Abs(d-184) > 4 {
		t.Errorf("Prague-Brno = %.1fkm, want ~184", d)
	}
	if d := DistanceKm(50.0755, 14.4378, 52.2297, 21.0122); math.Abs(d-517) > 8 {
		t.Errorf("Prague-Warsaw = %.1fkm, want ~517", d)
	}
}

// The grid must agree with brute force on every query, including the awkward
// case where the true nearest point sits in a ring beyond the first non-empty
// one.
func TestNearestMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	g := NewGrid(0.05)
	type pt struct{ lat, lon float64 }
	var pts []pt
	for i := 0; i < 4000; i++ {
		p := pt{48.5 + rng.Float64()*6, 12 + rng.Float64()*12} // CZ/PL bbox
		pts = append(pts, p)
		g.Add(p.lat, p.lon)
	}

	for i := 0; i < 2000; i++ {
		qlat := 48.5 + rng.Float64()*6
		qlon := 12 + rng.Float64()*12

		bruteD, bruteI := math.MaxFloat64, -1
		for j, p := range pts {
			if d := DistanceKm(qlat, qlon, p.lat, p.lon); d < bruteD {
				bruteD, bruteI = d, j
			}
		}
		id, d, ok := g.Nearest(qlat, qlon, 500)
		if !ok {
			t.Fatalf("query %d: no result, brute force found %d at %.3fkm", i, bruteI, bruteD)
		}
		// Compare distances rather than indices: exact ties are possible.
		if math.Abs(d-bruteD) > 1e-9 {
			t.Fatalf("query %d: grid %d@%.6f != brute %d@%.6f", i, id, d, bruteI, bruteD)
		}
	}
}

func TestNearestRespectsRadius(t *testing.T) {
	g := NewGrid(0.05)
	g.Add(50.0, 14.0)
	if _, _, ok := g.Nearest(51.0, 14.0, 10); ok {
		t.Error("point ~111km away should be outside a 10km radius")
	}
	if _, d, ok := g.Nearest(51.0, 14.0, 200); !ok || math.Abs(d-111.2) > 1 {
		t.Errorf("expected hit at ~111km, got ok=%v d=%.1f", ok, d)
	}
}

func TestEmptyGrid(t *testing.T) {
	if _, _, ok := NewGrid(0.05).Nearest(50, 14, 100); ok {
		t.Error("empty grid must not report a hit")
	}
}

func TestWithinMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	g := NewGrid(0.05)
	type pt struct{ lat, lon float64 }
	var pts []pt
	for i := 0; i < 3000; i++ {
		p := pt{49 + rng.Float64()*4, 14 + rng.Float64()*8}
		pts = append(pts, p)
		g.Add(p.lat, p.lon)
	}
	for i := 0; i < 500; i++ {
		qlat, qlon := 49+rng.Float64()*4, 14+rng.Float64()*8
		radius := 5 + rng.Float64()*40

		want := 0
		for _, p := range pts {
			if DistanceKm(qlat, qlon, p.lat, p.lon) <= radius {
				want++
			}
		}
		if got := len(g.Within(qlat, qlon, radius)); got != want {
			t.Fatalf("Within(%.3f,%.3f,%.1f) = %d points, brute force = %d",
				qlat, qlon, radius, got, want)
		}
	}
}

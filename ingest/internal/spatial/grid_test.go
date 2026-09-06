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

// Within must also report the same distance the caller would compute itself.
func TestWithinReportsDistance(t *testing.T) {
	g := NewGrid(0.05)
	g.Add(50.0, 14.0)
	g.Add(50.1, 14.1)
	for _, n := range g.Within(50.05, 14.05, 50, nil) {
		lat, lon := g.At(n.ID)
		if want := DistanceKm(50.05, 14.05, lat, lon); math.Abs(n.DistKm-want) > 1e-9 {
			t.Errorf("Within reported %.9f km, want %.9f", n.DistKm, want)
		}
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
		if got := len(g.Within(qlat, qlon, radius, nil)); got != want {
			t.Fatalf("Within(%.3f,%.3f,%.1f) = %d points, brute force = %d",
				qlat, qlon, radius, got, want)
		}
	}
}

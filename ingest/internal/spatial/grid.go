// Package spatial is a uniform lat/lon grid for bounded-radius lookups during
// the build.
//
// It answers "which settlement is this street segment in?", because OSM
// highways almost never carry addr:city: four of 241,815 named Czech street
// ways do. Without it every "Nadrazni" in the country collapses into one
// record.
//
// A grid rather than a k-d tree: bounded-radius queries against a small static
// point set, where a ring scan wins and is a fraction of the code. The server's
// reverse path has different constraints and uses a tree.
package spatial

import "math"

const earthRadiusKm = 6371.0088

type cell struct{ x, y int32 }

// Grid indexes points for bounded-radius nearest lookups.
type Grid struct {
	cellDeg float64
	buckets map[cell][]int32
	lats    []float64
	lons    []float64
}

// NewGrid takes a cell size in degrees of latitude; 0.05 (~5.5km) matches
// settlement spacing.
func NewGrid(cellDeg float64) *Grid {
	return &Grid{cellDeg: cellDeg, buckets: map[cell][]int32{}}
}

func (g *Grid) cellOf(lat, lon float64) cell {
	return cell{
		x: int32(math.Floor(lon / g.cellDeg)),
		y: int32(math.Floor(lat / g.cellDeg)),
	}
}

// Add inserts a point and returns its index.
func (g *Grid) Add(lat, lon float64) int32 {
	id := int32(len(g.lats))
	g.lats = append(g.lats, lat)
	g.lons = append(g.lons, lon)
	c := g.cellOf(lat, lon)
	g.buckets[c] = append(g.buckets[c], id)
	return id
}

func (g *Grid) Len() int { return len(g.lats) }

// DistanceKm is the great-circle distance.
func DistanceKm(lat1, lon1, lat2, lon2 float64) float64 {
	const rad = math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLon := (lon2 - lon1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusKm * math.Asin(math.Sqrt(a))
}

// Cells whose Chebyshev distance from c is exactly r.
func ring(c cell, r int32) []cell {
	if r == 0 {
		return []cell{c}
	}
	out := make([]cell, 0, 8*int(r))
	for dx := -r; dx <= r; dx++ {
		for dy := -r; dy <= r; dy++ {
			if max32(abs32(dx), abs32(dy)) != r {
				continue
			}
			out = append(out, cell{c.x + dx, c.y + dy})
		}
	}
	return out
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}
func max32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}

// Neighbour is a point found by Within, with its distance.
type Neighbour struct {
	ID     int32
	DistKm float64
}

// Within appends points within maxKm to buf, in no particular order.
//
// Not "nearest": picking the literally closest settlement puts streets on the
// edge of Prague into whatever village sits just outside, so the caller weighs
// every candidate against the settlement's size.
//
// This is the hot loop of the build — millions of calls — so the distance comes
// back with the id (recomputing it caller-side doubled the slowest phase) and
// buf is passed in to reuse one allocation.
// A 15km search over the smallest cell this build uses needs ~30 rings; past a
// few hundred the answer cannot change and the input is wrong.
const maxRingCap = 512

func (g *Grid) Within(lat, lon, maxKm float64, buf []Neighbour) []Neighbour {
	if len(g.lats) == 0 {
		return buf
	}
	center := g.cellOf(lat, lon)
	// Abs, because a latitude past the pole gives a negative cosine, and the
	// Max below then clamps to 1e-6 rather than to a small distance — which
	// makes maxRing ten million and the walk unbounded.
	kmPerDegLon := 111.32 * math.Abs(math.Cos(lat*math.Pi/180))
	cellKm := g.cellDeg * math.Min(111.32, math.Max(kmPerDegLon, 1e-6))
	maxRing := int32(math.Ceil(maxKm/math.Max(cellKm, 1e-9))) + 1
	// Nothing is gained by walking further than the grid extends, and this is
	// the difference between a bad input costing a query and costing the build.
	if maxRing > maxRingCap {
		maxRing = maxRingCap
	}

	for r := int32(0); r <= maxRing; r++ {
		for _, c := range ring(center, r) {
			for _, pid := range g.buckets[c] {
				if d := DistanceKm(lat, lon, g.lats[pid], g.lons[pid]); d <= maxKm {
					buf = append(buf, Neighbour{ID: pid, DistKm: d})
				}
			}
		}
	}
	return buf
}

// At returns the coordinates of an indexed point.
func (g *Grid) At(id int32) (lat, lon float64) { return g.lats[id], g.lons[id] }

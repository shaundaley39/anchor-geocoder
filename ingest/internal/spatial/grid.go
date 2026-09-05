// Package spatial provides a uniform lat/lon grid index for nearest-neighbour
// lookups during the build.
//
// The build needs this to answer "which settlement is this street segment in?",
// because OSM highway ways essentially never carry addr:city — of 241,815 named
// Czech street ways, four do. Without a spatial answer every "Nadrazni" in the
// country collapses into a single record.
//
// A uniform grid rather than a k-d tree: the queries are all bounded-radius
// against a small, static point set (~20k Czech settlements), where a grid's
// expanding-ring scan beats a tree and is a fraction of the code. The server's
// reverse-geocoding path has different constraints — millions of points, k
// nearest in true distance order — and uses a k-d tree instead.
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

// NewGrid returns a grid with the given cell size in degrees of latitude.
// 0.05 deg is ~5.5km, a good match for settlement spacing in Central Europe.
func NewGrid(cellDeg float64) *Grid {
	return &Grid{cellDeg: cellDeg, buckets: map[cell][]int32{}}
}

func (g *Grid) cellOf(lat, lon float64) cell {
	return cell{
		x: int32(math.Floor(lon / g.cellDeg)),
		y: int32(math.Floor(lat / g.cellDeg)),
	}
}

// Add inserts a point and returns its index, which Nearest reports back.
func (g *Grid) Add(lat, lon float64) int32 {
	id := int32(len(g.lats))
	g.lats = append(g.lats, lat)
	g.lons = append(g.lons, lon)
	c := g.cellOf(lat, lon)
	g.buckets[c] = append(g.buckets[c], id)
	return id
}

func (g *Grid) Len() int { return len(g.lats) }

// DistanceKm is the great-circle distance via the haversine formula.
func DistanceKm(lat1, lon1, lat2, lon2 float64) float64 {
	const rad = math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLon := (lon2 - lon1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusKm * math.Asin(math.Sqrt(a))
}

// Nearest returns the index of the closest indexed point within maxKm.
//
// It scans rings of cells outward from the query cell. Crucially it does not
// stop at the first ring containing a point: a point just across a cell
// boundary in the next ring out can be closer than one in the far corner of the
// current ring. It therefore continues until the ring's guaranteed minimum
// distance exceeds the best found so far.
func (g *Grid) Nearest(lat, lon, maxKm float64) (id int32, distKm float64, ok bool) {
	if len(g.lats) == 0 {
		return 0, 0, false
	}
	center := g.cellOf(lat, lon)

	// Cell width in km shrinks with latitude; use the smaller of the two axes
	// so the ring lower bound stays conservative.
	kmPerDegLat := 111.32
	kmPerDegLon := 111.32 * math.Cos(lat*math.Pi/180)
	cellKm := g.cellDeg * math.Min(kmPerDegLat, math.Max(kmPerDegLon, 1e-6))

	best := math.MaxFloat64
	bestID := int32(-1)

	maxRing := int32(math.Ceil(maxKm/math.Max(cellKm, 1e-9))) + 1
	for r := int32(0); r <= maxRing; r++ {
		// Every cell in ring r is at least (r-1)*cellKm away. Once that floor
		// exceeds the best distance found, no further ring can improve it.
		if bestID >= 0 && float64(r-1)*cellKm > best {
			break
		}
		for _, c := range ring(center, r) {
			for _, pid := range g.buckets[c] {
				d := DistanceKm(lat, lon, g.lats[pid], g.lons[pid])
				if d < best {
					best, bestID = d, pid
				}
			}
		}
	}
	if bestID < 0 || best > maxKm {
		return 0, 0, false
	}
	return bestID, best, true
}

// ring returns the cells whose Chebyshev distance from c is exactly r.
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

// Neighbour is a point found by Within, with its distance already computed.
type Neighbour struct {
	ID     int32
	DistKm float64
}

// Within appends the points within maxKm of the query to buf, in no particular
// order, and returns the extended slice.
//
// Street-to-settlement assignment needs this rather than Nearest: picking the
// literally closest settlement puts streets on the edge of Prague into whatever
// village happens to sit just outside. The caller instead weighs every
// candidate in range against the settlement's size.
//
// The distance comes back with the id because the caller needs it too, and this
// is the hot loop of the whole build: one call per street segment and per
// locality-less address, several million of them, against a grid holding every
// settlement in fourteen countries. Recomputing the haversine caller-side
// doubled the cost of the slowest phase, and passing buf in lets the caller
// reuse one allocation across all of those calls.
func (g *Grid) Within(lat, lon, maxKm float64, buf []Neighbour) []Neighbour {
	if len(g.lats) == 0 {
		return buf
	}
	center := g.cellOf(lat, lon)
	kmPerDegLon := 111.32 * math.Cos(lat*math.Pi/180)
	cellKm := g.cellDeg * math.Min(111.32, math.Max(kmPerDegLon, 1e-6))
	maxRing := int32(math.Ceil(maxKm/math.Max(cellKm, 1e-9))) + 1

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

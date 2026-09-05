// Package geom holds the build-time geometry work: reducing an OSM way's
// vertices to a shape small enough to store for every feature, and the bounding
// box that indexes it.
//
// # Why geometry is kept at all
//
// Reverse geocoding answers "what is here", and a click inside a park is inside
// it however far the park's centroid happens to be. Ranking on distance to a
// representative point cannot express that: the Englischer Garten is 3.7km
// long, so a click at its north end sits ~2km from the stored centroid and
// falls below every house in between.
//
// A bounding box alone is not enough either — a diagonal or crescent-shaped
// feature fills a fraction of its box, so "inside the box" is not "inside the
// feature". The box is the *filter*; the simplified ring is the *refinement*.
//
// # Why this is affordable
//
// Only features with real extent need a ring. Measured over the fourteen
// extracts:
//
//	address ways   32,430,081  building footprints — metres across, centroid is fine
//	street ways     9,045,760  linear, described by sampled points not a ring
//	POI ways          926,901  parks, lakes, campuses, forests — these need rings
//	place ways          8,472  likewise
//
// So the ring budget covers ~935k features, not 42M, which is what makes real
// geometry practical here.
package geom

import "math"

// Point is a WGS84 coordinate pair.
type Point struct{ Lat, Lon float64 }

// BBox is an axis-aligned bound in degrees.
type BBox struct{ MinLat, MinLon, MaxLat, MaxLon float64 }

// Bounds returns the bounding box of a set of points.
func Bounds(pts []Point) BBox {
	b := BBox{MinLat: math.Inf(1), MinLon: math.Inf(1),
		MaxLat: math.Inf(-1), MaxLon: math.Inf(-1)}
	for _, p := range pts {
		b.MinLat = math.Min(b.MinLat, p.Lat)
		b.MaxLat = math.Max(b.MaxLat, p.Lat)
		b.MinLon = math.Min(b.MinLon, p.Lon)
		b.MaxLon = math.Max(b.MaxLon, p.Lon)
	}
	return b
}

// DiagonalMetres is the corner-to-corner size of a box, used to decide whether
// a feature is big enough for its shape to matter.
func (b BBox) DiagonalMetres() float64 {
	if math.IsInf(b.MinLat, 1) {
		return 0
	}
	latM := (b.MaxLat - b.MinLat) * 111_320
	lonM := (b.MaxLon - b.MinLon) * 111_320 *
		math.Cos((b.MinLat+b.MaxLat)/2*math.Pi/180)
	return math.Hypot(latM, lonM)
}

// Simplify reduces a ring or line with Douglas-Peucker, then hard-caps the
// vertex count so no single feature can dominate the geometry blob.
//
// The tolerance is in metres. Ten metres is far below the accuracy at which
// anyone clicks a map, and takes a typical OSM park outline from hundreds of
// vertices to a few dozen.
func Simplify(pts []Point, toleranceM float64, maxPoints int) []Point {
	if len(pts) <= 2 {
		return pts
	}
	out := douglasPeucker(pts, toleranceM)
	// Douglas-Peucker has no upper bound on output size; a coastline or a
	// national forest can still come back with thousands of vertices. Drop
	// evenly spaced points until it fits.
	for len(out) > maxPoints {
		stride := float64(len(out)) / float64(maxPoints)
		thinned := make([]Point, 0, maxPoints)
		for i := 0.0; int(i) < len(out) && len(thinned) < maxPoints; i += stride {
			thinned = append(thinned, out[int(i)])
		}
		out = thinned
	}
	return out
}

func douglasPeucker(pts []Point, toleranceM float64) []Point {
	if len(pts) < 3 {
		return pts
	}
	// Work in a local metric frame so the perpendicular distance is in metres
	// and does not skew with longitude convergence.
	scale := math.Cos(pts[0].Lat * math.Pi / 180)
	x := func(p Point) float64 { return p.Lon * scale * 111_320 }
	y := func(p Point) float64 { return p.Lat * 111_320 }

	first, last := pts[0], pts[len(pts)-1]
	x0, y0, x1, y1 := x(first), y(first), x(last), y(last)
	dx, dy := x1-x0, y1-y0
	den := math.Hypot(dx, dy)

	maxDist, maxIdx := 0.0, 0
	for i := 1; i < len(pts)-1; i++ {
		px, py := x(pts[i]), y(pts[i])
		var d float64
		if den < 1e-9 {
			d = math.Hypot(px-x0, py-y0)
		} else {
			d = math.Abs(dy*px-dx*py+x1*y0-y1*x0) / den
		}
		if d > maxDist {
			maxDist, maxIdx = d, i
		}
	}
	if maxDist <= toleranceM {
		return []Point{first, last}
	}
	left := douglasPeucker(pts[:maxIdx+1], toleranceM)
	right := douglasPeucker(pts[maxIdx:], toleranceM)
	return append(left[:len(left)-1], right...)
}

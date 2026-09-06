// Package geom reduces an OSM way's vertices to a storable shape and its box.
//
// Reverse geocoding answers "what is here", and a click inside a park is inside
// it however far the centroid is — a 3.7km park puts its north end ~2km from
// the stored point, below every house in between. A box alone will not do
// either: a crescent fills a fraction of it. The box filters, the ring refines.
//
// Affordable because only features with real extent need a ring. Measured over
// fourteen extracts: 32.4M building ways need none (metres across), 9.0M street
// ways are linear and take sampled points, and ~935k POI and place ways get
// rings. That budget is what makes real geometry practical.
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

// DiagonalMetres is corner-to-corner size, for deciding whether a shape matters.
func (b BBox) DiagonalMetres() float64 {
	if math.IsInf(b.MinLat, 1) {
		return 0
	}
	latM := (b.MaxLat - b.MinLat) * 111_320
	lonM := (b.MaxLon - b.MinLon) * 111_320 *
		math.Cos((b.MinLat+b.MaxLat)/2*math.Pi/180)
	return math.Hypot(latM, lonM)
}

// Simplify runs Douglas-Peucker at a metre tolerance, then a hard cap so no single
// feature
// dominates the blob. Ten metres is far below map-click accuracy and takes a
// typical park from hundreds of vertices to a few dozen.
func Simplify(pts []Point, toleranceM float64, maxPoints int) []Point {
	if len(pts) <= 2 {
		return pts
	}
	out := douglasPeucker(pts, toleranceM)
	// Douglas-Peucker has no upper bound: a coastline can still return
	// thousands. Drop evenly spaced points until it fits.
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
	// Local metric frame, so distances are metres and do not skew with
	// longitude convergence.
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

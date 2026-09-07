package pbf

import (
	"context"
	"math"
	"sort"

	"github.com/paulmach/osm"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
)

const (
	// Below this size a feature's centroid is already within the accuracy of a map
	// click, so its outline cannot change a ranking.
	minRingDiagonalM = 60
	// Ten metres is far finer than anyone clicks, and takes a typical OSM park
	// from hundreds of vertices to a few dozen.
	ringToleranceM = 10
	// A hard ceiling so one coastline or national forest cannot dominate the
	// geometry blob.
	maxRingPoints = 48
)

// scanWays is pass 1: select the ways worth keeping and record the node ids
// needed to give each one a point.
func (e *Extractor) scanWays(ctx context.Context, st *Stats, memberWays []int64) ([]int64, []int64, error) {
	f, s, err := e.openScanner(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	defer s.Close()
	s.SkipNodes = true
	s.SkipRelations = true

	var (
		ways   []int64
		needed []int64
	)
	for s.Scan() {
		w, ok := s.Object().(*osm.Way)
		if !ok {
			continue
		}
		st.WaysScanned++

		tags := tagsOf(w.Tags)
		addressed := isAddressed(tags)
		place := isPlace(tags)
		street := isNamedStreet(tags)
		_, poi := isPOI(tags)
		// A relation member usually carries no tags of its own, so nothing else
		// would keep it, and its vertices are the relation's only geometry.
		member := search(memberWays, int64(w.ID)) >= 0
		if e.PlacesOnly {
			// Members stay: a place mapped as a multipolygon has no geometry
			// without them, and dropping them cost four Czech settlements.
			if !place && !member {
				continue
			}
			addressed, street, poi = false, false, false
		} else if !addressed && !place && !street && !poi && !member {
			continue
		}
		if len(w.Nodes) == 0 {
			st.WaysUnresolved++
			continue
		}

		// A building or place polygon needs every vertex for its centroid; a street
		// needs only a point that lies on the line. See package doc.
		wantAll := addressed || place || poi || member
		ways = append(ways, packWay(int64(w.ID), wantAll))

		if wantAll {
			for _, n := range w.Nodes {
				needed = append(needed, int64(n.ID))
			}
		} else {
			mid := w.Nodes[len(w.Nodes)/2]
			needed = append(needed, int64(mid.ID))
		}

		switch {
		case !addressed && !place && !street && !poi:
			// retained only as relation geometry
		case addressed:
			st.AddrWays++
		case place:
			st.PlaceWays++
		case poi:
			st.POIWays++
		default:
			st.StreetWays++
		}
		if st.WaysScanned%2_000_000 == 0 {
			e.log("  pass 1: %dM ways scanned, %d selected", st.WaysScanned/1e6, len(ways))
		}
	}
	return ways, needed, s.Err()
}

// scanNodes is pass 2: emit standalone address and place nodes, and retain the
// locations pass 1 asked for.
func (e *Extractor) scanNodes(ctx context.Context, st *Stats, needed []int64, locs []coord) (int, error) {
	f, s, err := e.openScanner(ctx)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	defer s.Close()
	s.SkipWays = true
	s.SkipRelations = true

	found := 0
	for s.Scan() {
		n, ok := s.Object().(*osm.Node)
		if !ok {
			continue
		}
		st.NodesScanned++

		if i := search(needed, int64(n.ID)); i >= 0 {
			locs[i] = coord{lat: packLat(n.Lat), lon: packLat(n.Lon)}
			found++
		}

		if len(n.Tags) == 0 {
			continue
		}
		tags := tagsOf(n.Tags)
		addressed := isAddressed(tags)
		place := isPlace(tags)
		_, poi := isPOI(tags)
		if e.PlacesOnly {
			if !place {
				continue
			}
			addressed, poi = false, false
		} else if !addressed && !place && !poi {
			continue
		}
		switch {
		case addressed:
			st.AddrNodes++
		case place:
			st.PlaceNodes++
		default:
			st.POINodes++
		}
		poiCat, _ := isPOI(tags)
		if err := e.Emit(RawFeature{
			OSMType: 'n', OSMID: int64(n.ID), Tags: tags,
			Lat: n.Lat, Lon: n.Lon, Category: poiCat,
		}); err != nil {
			return found, err
		}
		if st.NodesScanned%20_000_000 == 0 {
			e.log("  pass 2: %dM nodes scanned, %d locations resolved",
				st.NodesScanned/1e6, found)
		}
	}
	return found, s.Err()
}

// emitWays is pass 3: rebuild each selected way's geometry from the retained
// locations.
func (e *Extractor) emitWays(ctx context.Context, st *Stats, ways []int64, needed []int64,
	locs []coord, memberWays []int64) (map[int64]memberWay, error) {

	// Geometry of the ways a relation is built from, kept for stitching. Only
	// the members, so this holds thousands of ways rather than millions.
	geoms := make(map[int64]memberWay, len(memberWays))
	// `ways` is sorted, so membership is a binary search — ~25 comparisons against
	// a flat int64 slice, rather than a map of tens of millions of entries that
	// would itself cost gigabytes.
	sort.Slice(ways, func(i, j int) bool { return ways[i]>>1 < ways[j]>>1 })

	f, s, err := e.openScanner(ctx)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	defer s.Close()
	s.SkipNodes = true
	s.SkipRelations = true

	emitted := 0
	for s.Scan() {
		w, ok := s.Object().(*osm.Way)
		if !ok {
			continue
		}
		isBuild, want := findWay(ways, int64(w.ID))
		if !want {
			continue
		}
		// Re-read rather than carried since pass 1: retaining tag maps for every
		// selected way took peak build memory from 5.5GB to 11.5GB.
		tags := tagsOf(w.Tags)

		pts := make([][2]float64, 0, len(w.Nodes))
		if isBuild {
			for _, n := range w.Nodes {
				if i := search(needed, int64(n.ID)); i >= 0 {
					c := locs[i]
					if c.lat != 0 || c.lon != 0 {
						pts = append(pts, [2]float64{unpackLat(c.lat), unpackLat(c.lon)})
					}
				}
			}
		} else {
			mid := w.Nodes[len(w.Nodes)/2]
			if i := search(needed, int64(mid.ID)); i >= 0 {
				c := locs[i]
				if c.lat != 0 || c.lon != 0 {
					pts = append(pts, [2]float64{unpackLat(c.lat), unpackLat(c.lon)})
				}
			}
		}
		if len(w.Nodes) >= 2 && search(memberWays, int64(w.ID)) >= 0 && len(pts) == len(w.Nodes) {
			gp := make([]geom.Point, len(pts))
			for i, p := range pts {
				gp[i] = geom.Point{Lat: p[0], Lon: p[1]}
			}
			geoms[int64(w.ID)] = memberWay{
				first: int64(w.Nodes[0].ID),
				last:  int64(w.Nodes[len(w.Nodes)-1].ID),
				pts:   gp,
			}
		}

		if len(pts) == 0 {
			st.WaysUnresolved++
			continue
		}

		lat, lon := representativePoint(pts, isBuild)
		poiCat, _ := isPOI(tags)

		// `isBuild` means every vertex was retained, not that the way is an area.
		// Closedness has to come from the way itself.
		closed := len(w.Nodes) >= 4 && w.Nodes[0].ID == w.Nodes[len(w.Nodes)-1].ID

		// Keep the outline only where it can change an answer. A building is a few
		// metres across, so its centroid is already inside clicking tolerance and a
		// ring would cost 32M rings for nothing; a park or a lake is not.
		var ring []geom.Point
		if isBuild && !isAddressed(tags) && len(pts) >= 4 {
			gp := make([]geom.Point, len(pts))
			for i, p := range pts {
				gp[i] = geom.Point{Lat: p[0], Lon: p[1]}
			}
			if geom.Bounds(gp).DiagonalMetres() >= minRingDiagonalM {
				ring = geom.Simplify(gp, ringToleranceM, maxRingPoints)
			}
		}

		if err := e.Emit(RawFeature{
			OSMType: 'w', OSMID: int64(w.ID), Tags: tags,
			Lat: lat, Lon: lon, Category: poiCat, Ring: ring, RingClosed: closed,
		}); err != nil {
			return nil, err
		}
		emitted++
		if emitted%1_000_000 == 0 {
			e.log("  pass 3: %dM ways emitted", emitted/1e6)
		}
	}
	return geoms, s.Err()
}

// representativePoint reduces a way's vertices to the single point the geocoder
// will return.
//
// For a closed building outline this is the polygon area centroid (the shoelace
// formula), not the mean of the vertices: OSM buildings often have many nodes
// bunched along one detailed facade and few along a plain wall, which drags a
// vertex mean off-centre. For a street it is simply the supplied midpoint,
// which lies on the carriageway; an area centroid of a curved road can land in
// a neighbouring field.
func representativePoint(pts [][2]float64, polygon bool) (lat, lon float64) {
	if len(pts) == 1 || !polygon {
		return pts[0][0], pts[0][1]
	}

	// Work in a local planar frame so the shoelace terms are metric-ish and do not
	// skew with longitude convergence.
	latScale := math.Cos(pts[0][0] * math.Pi / 180)

	var area, cx, cy float64
	n := len(pts)
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		x0, y0 := pts[i][1]*latScale, pts[i][0]
		x1, y1 := pts[j][1]*latScale, pts[j][0]
		cross := x0*y1 - x1*y0
		area += cross
		cx += (x0 + x1) * cross
		cy += (y0 + y1) * cross
	}
	area /= 2

	// Degenerate ring (unclosed, collinear, or zero area): fall back to the vertex
	// mean, which is always defined.
	if math.Abs(area) < 1e-12 {
		var sx, sy float64
		for _, p := range pts {
			sy += p[0]
			sx += p[1]
		}
		return sy / float64(n), sx / float64(n)
	}

	cx /= 6 * area
	cy /= 6 * area
	return cy, cx / latScale
}

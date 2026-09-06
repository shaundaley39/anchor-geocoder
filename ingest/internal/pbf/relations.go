package pbf

import (
	"context"
	"sort"

	"github.com/paulmach/osm"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
)

// A named multipolygon worth indexing, and the outer member ways its ring is
// split across.
type multipolygon struct {
	id      int64
	tags    map[string]string
	outers  []int64
	members []memberWay
}

// One member way's geometry, kept with its end node ids so rings can be
// stitched on identity rather than on coordinate equality.
type memberWay struct {
	first, last int64
	pts         []geom.Point
}

// scanRelations is pass 0: find the named multipolygons worth indexing and the
// member ways their geometry is split across.
//
// It runs first because pass 1 has to know which extra ways to retain. Those
// ways usually carry no tags of their own — an airport perimeter is 68
// untagged segments — so nothing else would select them.
func (e *Extractor) scanRelations(ctx context.Context, st *Stats) ([]*multipolygon, []int64, error) {
	f, s, err := e.openScanner(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	defer s.Close()
	s.SkipNodes = true
	s.SkipWays = true

	var mps []*multipolygon
	var wanted []int64
	for s.Scan() {
		r, ok := s.Object().(*osm.Relation)
		if !ok {
			continue
		}
		st.RelationsScanned++
		tags := tagsOf(r.Tags)
		if tags["type"] != "multipolygon" || tags["name"] == "" {
			continue
		}
		_, poi := isPOI(tags)
		if !poi && !isPlace(tags) {
			continue
		}
		mp := &multipolygon{id: int64(r.ID), tags: tags}
		for _, m := range r.Members {
			// A missing role means outer, per the multipolygon spec.
			if m.Type != osm.TypeWay || (m.Role != "outer" && m.Role != "") {
				continue
			}
			mp.outers = append(mp.outers, m.Ref)
			wanted = append(wanted, m.Ref)
		}
		if len(mp.outers) == 0 {
			continue
		}
		mps = append(mps, mp)
		st.RelationsSelected++
	}
	sort.Slice(wanted, func(i, j int) bool { return wanted[i] < wanted[j] })
	return mps, dedupeSorted(wanted), s.Err()
}

// assembleRings joins member ways end to end into closed rings.
//
// OSM splits a ring wherever tagging changes or ways meet, in no particular
// order and either direction, so this walks the pieces matching end node ids
// and reversing where needed. Prague's airport is one ring across 68 ways;
// without stitching it is 68 fragments and no containment at all.
//
// Chains that never close are dropped rather than forced shut: an unclosed
// outer ring means broken data, and guessing at it invents geometry.
func assembleRings(ms []memberWay) [][]geom.Point {
	used := make([]bool, len(ms))
	var rings [][]geom.Point

	for i := range ms {
		if used[i] || len(ms[i].pts) == 0 {
			continue
		}
		used[i] = true
		ring := append([]geom.Point(nil), ms[i].pts...)
		first, last := ms[i].first, ms[i].last

		for first != last {
			joined := false
			for j := range ms {
				if used[j] || len(ms[j].pts) == 0 {
					continue
				}
				switch {
				case ms[j].first == last:
					ring = append(ring, ms[j].pts[1:]...)
					last = ms[j].last
				case ms[j].last == last:
					for k := len(ms[j].pts) - 2; k >= 0; k-- {
						ring = append(ring, ms[j].pts[k])
					}
					last = ms[j].first
				default:
					continue
				}
				used[j] = true
				joined = true
				break
			}
			if !joined {
				break
			}
		}
		if first == last && len(ring) >= 4 {
			rings = append(rings, ring)
		}
	}
	return rings
}

// largestRing picks the ring to index when a relation has several.
//
// Only one is kept, so an archipelago loses its smaller islands. Inner rings
// are ignored too, which means a click in a courtyard reads as inside the
// building around it. Both are wrong at the edges and both are much less wrong
// than having no geometry at all, which is what came before.
func largestRing(rings [][]geom.Point) []geom.Point {
	var best []geom.Point
	var bestArea float64
	for _, r := range rings {
		if a := absShoelace(r); a > bestArea {
			best, bestArea = r, a
		}
	}
	return best
}

func absShoelace(pts []geom.Point) float64 {
	if len(pts) < 3 {
		return 0
	}
	var sum float64
	for i := 0; i < len(pts)-1; i++ {
		sum += pts[i].Lon*pts[i+1].Lat - pts[i+1].Lon*pts[i].Lat
	}
	if sum < 0 {
		return -sum / 2
	}
	return sum / 2
}

// emitRelations stitches each multipolygon's outer ring and emits it as one
// feature, with the same shape a closed way produces.
func (e *Extractor) emitRelations(st *Stats, mps []*multipolygon, geoms map[int64]memberWay) error {
	for _, mp := range mps {
		ms := make([]memberWay, 0, len(mp.outers))
		for _, id := range mp.outers {
			if m, ok := geoms[id]; ok {
				ms = append(ms, m)
			}
		}
		if len(ms) == 0 {
			continue
		}
		ring := largestRing(assembleRings(ms))
		if len(ring) < 4 {
			continue
		}

		pts := make([][2]float64, len(ring))
		for i, p := range ring {
			pts[i] = [2]float64{p.Lat, p.Lon}
		}
		lat, lon := representativePoint(pts, true)

		var simplified []geom.Point
		if geom.Bounds(ring).DiagonalMetres() >= minRingDiagonalM {
			simplified = geom.Simplify(ring, ringToleranceM, maxRingPoints)
		}

		poiCat, _ := isPOI(mp.tags)
		if err := e.Emit(RawFeature{
			OSMType: 'r', OSMID: mp.id, Tags: mp.tags,
			Lat: lat, Lon: lon, Category: poiCat,
			Ring: simplified, RingClosed: true,
		}); err != nil {
			return err
		}
		st.RelationsResolved++
	}
	return nil
}

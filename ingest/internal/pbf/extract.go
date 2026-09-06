// Package pbf extracts geocodable features from an OpenStreetMap .osm.pbf.
//
// Three passes, because a pbf is ordered nodes-then-ways and way members are
// bare node ids, so geometry needs locations already streamed past. That is not
// a corner case: 5.37M of Poland's 8.58M addressed features are on building
// ways, so a node-only ingest drops 63% of the country. Holding every node
// location is not an option either — hundreds of millions per extract.
//
//	pass 1  ways   — select features, record the node ids they need
//	pass 2  nodes  — emit address/place nodes; retain only the wanted locations
//	pass 3  ways   — resolve geometry, emit
//
// Each pass skips decoding the object types it does not need. Buildings need
// every vertex for a centroid, but a street needs one point, so highways retain
// only their middle vertex — which lies on the road, unlike a centroid, which
// can fall off a curved one.
package pbf

import (
	"context"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"

	"github.com/paulmach/osm"
	"github.com/paulmach/osm/osmpbf"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
)

// Packed node location: 8 bytes rather than 16, at ~1.1cm resolution.
type coord struct{ lat, lon int32 }

func packLat(v float64) int32   { return int32(math.Round(v * 1e7)) }
func unpackLat(v int32) float64 { return float64(v) / 1e7 }

// A selected way is one packed int64: its OSM id shifted left a bit, low bit
// set when it needs all its vertices rather than a midpoint.
//
// Deliberately not a struct holding the way's tags. Pass 3 re-reads the same
// way, so retaining a map per selected way costs tens of millions of Go maps —
// it dominated peak memory — to save work that has to happen there anyway.
func packWay(id int64, needsAllVertices bool) int64 {
	if needsAllVertices {
		return id<<1 | 1
	}
	return id << 1
}

// Reports whether a way was selected and whether it needs all its vertices.
// `wanted` must be sorted; pbf emits ways in ascending id order, so it already
// is.
func findWay(wanted []int64, id int64) (needsAllVertices, ok bool) {
	lo, hi := 0, len(wanted)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if wanted[mid]>>1 < id {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(wanted) && wanted[lo]>>1 == id {
		return wanted[lo]&1 == 1, true
	}
	return false, false
}

// Extractor pulls features out of one country extract.
type Extractor struct {
	Path    string
	Country string
	// Emit is called for every extracted raw feature. It must be safe to call from
	// a single goroutine only; extraction is parallel internally but emission is
	// serialized.
	Emit func(RawFeature) error
	// Progress, if set, is called periodically with a human-readable status.
	Progress func(string)
}

// RawFeature is pre-normalization output: OSM tags plus a resolved point.
type RawFeature struct {
	OSMType byte // 'n' node, 'w' way, 'r' relation
	OSMID   int64
	Tags    map[string]string
	Lat     float64
	Lon     float64
	// Non-empty when the feature is a POI (see poi.go), computed here so the
	// converter need not repeat the classification.
	Category string
	// Simplified outline, for any way big enough for its shape to matter. Nil for
	// nodes, buildings, and anything under the size threshold.
	Ring []geom.Point
	// RingClosed distinguishes an area from a linear way. Both get a Ring — a
	// river is worth measuring distance to — but only a closed one can contain a
	// click, and the two must not be confused: the Vltava's centreline, treated
	// as a ring, joins its endpoints into an 11km lens that "contains" Old Town
	// Square.
	RingClosed bool
}

func (e *Extractor) log(format string, args ...any) {
	if e.Progress != nil {
		e.Progress(fmt.Sprintf(format, args...))
	}
}

// Czech addresses often carry a conscription or provisional number with no
// plain addr:housenumber, so all three count.
func isAddressed(t map[string]string) bool {
	if t["addr:housenumber"] != "" || t["addr:conscriptionnumber"] != "" ||
		t["addr:provisionalnumber"] != "" {
		return true
	}
	return false
}

// Routable named ways only: service-level ones add noise ("Parking Aisle")
// without adding places anyone searches for.
var streetTypes = map[string]bool{
	"motorway": true, "trunk": true, "primary": true, "secondary": true,
	"tertiary": true, "unclassified": true, "residential": true,
	"living_street": true, "pedestrian": true, "road": true,
}

func isNamedStreet(t map[string]string) bool {
	return t["name"] != "" && streetTypes[t["highway"]]
}

// Settlement classes worth indexing as standalone results.
var placeTypes = map[string]bool{
	"city": true, "town": true, "village": true, "hamlet": true,
	"suburb": true, "quarter": true, "neighbourhood": true,
	"borough": true, "isolated_dwelling": true, "municipality": true,
}

func isPlace(t map[string]string) bool {
	return t["name"] != "" && placeTypes[t["place"]]
}

func tagsOf(t osm.Tags) map[string]string {
	m := make(map[string]string, len(t))
	for _, kv := range t {
		m[kv.Key] = kv.Value
	}
	return m
}

// Run performs the four-pass extraction.
func (e *Extractor) Run(ctx context.Context) (Stats, error) {
	var st Stats

	// ---- pass 0: multipolygon relations and the ways they are built from ----
	mps, memberWays, err := e.scanRelations(ctx, &st)
	if err != nil {
		return st, fmt.Errorf("pass 0 (relations): %w", err)
	}
	e.log("pass 0 done: %d multipolygons selected, %d member ways to retain",
		len(mps), len(memberWays))

	// ---- pass 1: select ways, collect the node IDs they need ----------------
	ways, needed, err := e.scanWays(ctx, &st, memberWays)
	if err != nil {
		return st, fmt.Errorf("pass 1 (ways): %w", err)
	}
	e.log("pass 1 done: %d ways selected, %d node refs needed", len(ways), len(needed))

	// Sort and dedupe so pass 2 can binary-search. Sorting 30M int64s costs a
	// couple of seconds and saves the ~1GB a hash map of the same set would.
	sort.Slice(needed, func(i, j int) bool { return needed[i] < needed[j] })
	needed = dedupeSorted(needed)
	locs := make([]coord, len(needed))
	e.log("pass 1 dedupe: %d unique node refs (%.0f MB retained)",
		len(needed), float64(len(needed)*16)/1e6)

	// ---- pass 2: emit address/place nodes, retain wanted locations ----------
	found, err := e.scanNodes(ctx, &st, needed, locs)
	if err != nil {
		return st, fmt.Errorf("pass 2 (nodes): %w", err)
	}
	e.log("pass 2 done: %d/%d node locations resolved", found, len(needed))

	// ---- pass 3: resolve way geometry and emit ------------------------------
	geoms, err := e.emitWays(ctx, &st, ways, needed, locs, memberWays)
	if err != nil {
		return st, fmt.Errorf("pass 3 (way geometry): %w", err)
	}

	// ---- stitch and emit the relations, in memory ---------------------------
	if err := e.emitRelations(&st, mps, geoms); err != nil {
		return st, fmt.Errorf("relation assembly: %w", err)
	}
	e.log("relations: %d/%d multipolygons resolved to a closed ring",
		st.RelationsResolved, st.RelationsSelected)
	return st, nil
}

// Stats is what extraction saw, for the build manifest.
type Stats struct {
	NodesScanned   int64
	WaysScanned    int64
	AddrNodes      int64
	AddrWays       int64
	PlaceNodes     int64
	PlaceWays      int64
	StreetWays     int64
	POINodes       int64
	POIWays        int64
	WaysUnresolved int64 // selected but geometry could not be built

	RelationsScanned  int64
	RelationsSelected int64
	RelationsResolved int64 // outer ring successfully stitched closed
}

func dedupeSorted(a []int64) []int64 {
	if len(a) == 0 {
		return a
	}
	out := a[:1]
	for _, v := range a[1:] {
		if v != out[len(out)-1] {
			out = append(out, v)
		}
	}
	return out
}

// Binary search over the sorted node-id set. Pass 2 calls it once per node —
// hundreds of millions of times — so it avoids sort.Search's closure overhead.
func search(a []int64, v int64) int {
	lo, hi := 0, len(a)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if a[mid] < v {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(a) && a[lo] == v {
		return lo
	}
	return -1
}

func (e *Extractor) openScanner(ctx context.Context) (*os.File, *osmpbf.Scanner, error) {
	f, err := os.Open(e.Path)
	if err != nil {
		return nil, nil, err
	}
	s := osmpbf.New(ctx, f, runtime.GOMAXPROCS(-1))
	return f, s, nil
}

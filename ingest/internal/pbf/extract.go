// Package pbf extracts geocodable features from an OpenStreetMap .osm.pbf
// extract.
//
// # Why three passes
//
// A pbf file is ordered nodes, then ways, then relations, and way members are
// bare node ID references. Resolving way geometry therefore needs node
// locations that were already streamed past by the time the way is seen. This
// matters a great deal here: 5.37M of Poland's 8.58M addressed features are
// tagged on building *ways*, not nodes, so an ingest that only reads nodes
// silently drops 63% of Polish addresses.
//
// Holding every node location is not an option — a Poland extract has a few
// hundred million nodes, and a map keyed by int64 OSM IDs would run to tens of
// gigabytes. Instead:
//
//	pass 1  ways      — decide which ways we want, record the node IDs they need
//	pass 2  nodes     — emit address/place nodes; retain only the wanted locations
//	pass 3  ways      — resolve geometry, emit
//
// Pass 1 and 3 skip node decoding and pass 2 skips way decoding, so each pass
// only pays to inflate the blobs it actually cares about.
//
// # The node-set optimisation
//
// Buildings need every vertex to compute a centroid, but a street only needs a
// single representative point. Collecting all nodes of every named highway
// would dominate the retained set (Poland has 7.6M highway ways, many of them
// long). So for highways we record only the middle vertex, which is guaranteed
// to lie on the road — unlike a centroid, which can fall off a curved one.
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
)

// coord is a packed node location. Fixed-point at 1e7 keeps the retained set to
// 8 bytes per node instead of 16 for two float64s; 1e-7 degrees is ~1.1cm.
type coord struct{ lat, lon int32 }

func packLat(v float64) int32   { return int32(math.Round(v * 1e7)) }
func unpackLat(v int32) float64 { return float64(v) / 1e7 }

// wantedWay is a way selected in pass 1, awaiting geometry in pass 3.
type wantedWay struct {
	id      int64
	tags    map[string]string
	isBuild bool // true: needs all vertices (centroid); false: single midpoint
}

// Extractor pulls features out of one country extract.
type Extractor struct {
	Path    string
	Country string
	// Emit is called for every extracted raw feature. It must be safe to call
	// from a single goroutine only; extraction is parallel internally but
	// emission is serialized.
	Emit func(RawFeature) error
	// Progress, if set, is called periodically with a human-readable status.
	Progress func(string)
}

// RawFeature is the pre-normalization output of extraction: OSM tags plus a
// resolved point. Turning this into a model.Record is the normalizer's job.
type RawFeature struct {
	OSMType byte // 'n' node, 'w' way, 'r' relation
	OSMID   int64
	Tags    map[string]string
	Lat     float64
	Lon     float64
	// Category is non-empty when the feature qualifies as a point of interest;
	// see poi.go. Computed during extraction so the converter does not repeat
	// the classification.
	Category string
}

func (e *Extractor) log(format string, args ...any) {
	if e.Progress != nil {
		e.Progress(fmt.Sprintf(format, args...))
	}
}

// isAddressed reports whether tags describe an address point. Czech addresses
// frequently carry a conscription or provisional number with no plain
// addr:housenumber, so all three are accepted.
func isAddressed(t map[string]string) bool {
	if t["addr:housenumber"] != "" || t["addr:conscriptionnumber"] != "" ||
		t["addr:provisionalnumber"] != "" {
		return true
	}
	return false
}

// isNamedStreet reports whether tags describe a routable, named way we want as
// a street record. Non-routable and service-level ways are excluded: they add
// noise ("Parking Aisle") without adding places people search for.
var streetTypes = map[string]bool{
	"motorway": true, "trunk": true, "primary": true, "secondary": true,
	"tertiary": true, "unclassified": true, "residential": true,
	"living_street": true, "pedestrian": true, "road": true,
}

func isNamedStreet(t map[string]string) bool {
	return t["name"] != "" && streetTypes[t["highway"]]
}

// placeTypes are the settlement classes worth indexing as standalone results.
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

// Run performs the three-pass extraction.
func (e *Extractor) Run(ctx context.Context) (Stats, error) {
	var st Stats

	// ---- pass 1: select ways, collect the node IDs they need ----------------
	ways, needed, err := e.scanWays(ctx, &st)
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
	if err := e.emitWays(ctx, &st, ways, needed, locs); err != nil {
		return st, fmt.Errorf("pass 3 (way geometry): %w", err)
	}
	return st, nil
}

// Stats counts what extraction saw, for the build manifest and the README.
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

// search is a tight binary search over the sorted node-ID set. Pass 2 calls it
// once per node in the extract — hundreds of millions of times — so it avoids
// sort.Search's closure-call overhead.
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

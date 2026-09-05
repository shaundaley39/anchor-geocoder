// Command relstat measures what is lost by skipping OSM relations.
//
// Extraction reads nodes and ways only, because resolving multipolygon geometry
// needs member ways and then their nodes — two more passes and a large jump in
// complexity. That is a defensible trade, but only if the size of the gap is
// known rather than assumed. Measured on the 2026-08-31 extracts:
//
//	Czechia  252,959 relations, 71,880 named, 12,563 named and POI-tagged
//	Poland   278,966 relations, 112,620 named, 24,140 named and POI-tagged
//
// 36,703 POI relations against 663,724 indexed POIs is 5.2% by count, but they
// skew large: Prague's Letiste Vaclava Havla is a multipolygon and is missing,
// while Warsaw Chopin and Krakow-Balice, mapped as ways, are present.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"runtime"

	"github.com/paulmach/osm"
	"github.com/paulmach/osm/osmpbf"
)

func main() {
	p := flag.String("f", "", "")
	flag.Parse()
	f, _ := os.Open(*p)
	defer f.Close()
	s := osmpbf.New(context.Background(), f, runtime.GOMAXPROCS(-1))
	defer s.Close()
	s.SkipNodes, s.SkipWays = true, true
	keys := []string{"amenity", "shop", "tourism", "leisure", "historic", "office",
		"healthcare", "craft", "railway", "aeroway", "public_transport", "man_made"}
	var total, named, poi, addressed int
	for s.Scan() {
		r, ok := s.Object().(*osm.Relation)
		if !ok {
			continue
		}
		total++
		m := map[string]string{}
		for _, kv := range r.Tags {
			m[kv.Key] = kv.Value
		}
		if m["name"] == "" {
			continue
		}
		named++
		for _, k := range keys {
			if v := m[k]; v != "" && v != "no" {
				poi++
				break
			}
		}
		if m["addr:housenumber"] != "" {
			addressed++
		}
	}
	fmt.Printf("  relations: %d total, %d named, %d named+POI-tagged, %d addressed\n",
		total, named, poi, addressed)
}

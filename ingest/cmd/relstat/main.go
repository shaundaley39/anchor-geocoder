// Command relstat measures what is lost by skipping OSM relations.
//
// Extraction reads nodes and ways only; resolving multipolygon geometry needs
// two more passes. A defensible trade, but only if the gap is measured. On
// Czechia and Poland: 36,703 named POI relations against 663,724 indexed POIs,
// 5.2% by count — but they skew large. Prague's airport is a multipolygon and
// missing; Warsaw Chopin, mapped as a way, is present.
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

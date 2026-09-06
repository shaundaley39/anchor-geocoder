// Command poistat counts named POI features by category, to size the layer
// before building it. Taginfo counts are not enough: what matters is how many
// are both POI-tagged and named, and how many already carry an address.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"runtime"
	"sort"

	"github.com/paulmach/osm"
	"github.com/paulmach/osm/osmpbf"
)

var keys = []string{
	"amenity", "shop", "tourism", "leisure", "historic", "office",
	"healthcare", "railway", "aeroway", "public_transport", "craft", "man_made",
}

func main() {
	path := flag.String("f", "", "path to .osm.pbf")
	flag.Parse()

	f, err := os.Open(*path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	s := osmpbf.New(context.Background(), f, runtime.GOMAXPROCS(-1))
	defer s.Close()
	s.SkipRelations = true

	byKey := map[string]int{}
	byValue := map[string]int{}
	var named, namedAddressed, nodes, ways int

	for s.Scan() {
		var tags osm.Tags
		isWay := false
		switch o := s.Object().(type) {
		case *osm.Node:
			tags = o.Tags
		case *osm.Way:
			tags = o.Tags
			isWay = true
		default:
			continue
		}
		if len(tags) == 0 {
			continue
		}
		m := make(map[string]string, len(tags))
		for _, kv := range tags {
			m[kv.Key] = kv.Value
		}
		if m["name"] == "" {
			continue
		}
		hit := false
		for _, k := range keys {
			v := m[k]
			if v == "" || v == "no" {
				continue
			}
			byKey[k]++
			byValue[k+"="+v]++
			hit = true
		}
		if !hit {
			continue
		}
		named++
		if isWay {
			ways++
		} else {
			nodes++
		}
		if m["addr:housenumber"] != "" {
			namedAddressed++
		}
	}

	fmt.Printf("named POI features: %d  (%d nodes, %d ways)\n", named, nodes, ways)
	fmt.Printf("  of which already carry addr:housenumber: %d (%.1f%%)\n\n",
		namedAddressed, 100*float64(namedAddressed)/float64(named))

	type kv struct {
		k string
		v int
	}
	var ks []kv
	for k, v := range byKey {
		ks = append(ks, kv{k, v})
	}
	sort.Slice(ks, func(i, j int) bool { return ks[i].v > ks[j].v })
	fmt.Println("by key:")
	for _, e := range ks {
		fmt.Printf("  %-18s %8d\n", e.k, e.v)
	}

	var vs []kv
	for k, v := range byValue {
		vs = append(vs, kv{k, v})
	}
	sort.Slice(vs, func(i, j int) bool { return vs[i].v > vs[j].v })
	fmt.Println("\ntop 60 categories:")
	for i, e := range vs {
		if i >= 60 {
			break
		}
		fmt.Printf("  %-34s %7d\n", e.k, e.v)
	}
}

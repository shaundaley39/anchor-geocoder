// Command tagstat reports which combinations of address tags actually occur, so
// the converter's rules derive from the data rather than from assumptions.
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

func main() {
	path := flag.String("f", "", "path to .osm.pbf")
	limit := flag.Int("limit", 0, "stop after N addressed features (0 = full scan)")
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

	combos := map[string]int{}
	var nNode, nWay int
	keys := map[string]int{}
	samples := map[string]string{}
	n := 0

	keysOfInterest := []string{
		"addr:housenumber", "addr:conscriptionnumber", "addr:streetnumber",
		"addr:provisionalnumber", "addr:street", "addr:place", "addr:city",
		"addr:suburb", "addr:postcode", "addr:district", "addr:municipality",
	}

	for s.Scan() {
		if *limit > 0 && n >= *limit {
			break
		}
		var tags osm.Tags
		var isWay bool
		switch o := s.Object().(type) {
		case *osm.Node:
			tags = o.Tags
			isWay = false
		case *osm.Way:
			tags = o.Tags
			isWay = true
		default:
			continue
		}
		m := map[string]string{}
		for _, kv := range tags {
			m[kv.Key] = kv.Value
		}
		if m["addr:housenumber"] == "" && m["addr:conscriptionnumber"] == "" &&
			m["addr:provisionalnumber"] == "" {
			continue
		}
		n++
		if isWay {
			nWay++
		} else {
			nNode++
		}

		var present []string
		for _, k := range keysOfInterest {
			if m[k] != "" {
				present = append(present, k)
				keys[k]++
			}
		}
		combo := fmt.Sprint(present)
		combos[combo]++
		if _, ok := samples[combo]; !ok {
			samples[combo] = fmt.Sprintf("hn=%q cp=%q co=%q street=%q place=%q city=%q suburb=%q",
				m["addr:housenumber"], m["addr:conscriptionnumber"], m["addr:streetnumber"],
				m["addr:street"], m["addr:place"], m["addr:city"], m["addr:suburb"])
		}
	}

	fmt.Printf("scanned %d addressed features (%d nodes, %d ways)\n\n== key frequency ==\n", n, nNode, nWay)
	type kv struct {
		k string
		v int
	}
	var ks []kv
	for k, v := range keys {
		ks = append(ks, kv{k, v})
	}
	sort.Slice(ks, func(i, j int) bool { return ks[i].v > ks[j].v })
	for _, e := range ks {
		fmt.Printf("  %-26s %8d  %5.1f%%\n", e.k, e.v, 100*float64(e.v)/float64(n))
	}

	fmt.Println("\n== top tag combinations ==")
	var cs []kv
	for k, v := range combos {
		cs = append(cs, kv{k, v})
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].v > cs[j].v })
	for i, e := range cs {
		if i >= 8 {
			break
		}
		fmt.Printf("  %6d (%4.1f%%) %s\n           %s\n", e.v,
			100*float64(e.v)/float64(n), e.k, samples[e.k])
	}
}

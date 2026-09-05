// Command namestat measures how alternate names are tagged, to decide which
// tags the index must carry.
//
// A place routinely has several names people actually type: an exonym
// (Prague/Praha, Danzig/Gdansk), a colloquial short form, a former name, or a
// formal official name nobody uses. OSM spreads these across name:<lang>,
// alt_name, short_name, official_name, old_name and friends, and several of
// them are semicolon-delimited lists.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"

	"github.com/paulmach/osm"
	"github.com/paulmach/osm/osmpbf"
)

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

	aliasKeys := map[string]int{}
	langs := map[string]int{}
	var named, withAlias, semicolon int

	for s.Scan() {
		var tags osm.Tags
		switch o := s.Object().(type) {
		case *osm.Node:
			tags = o.Tags
		case *osm.Way:
			tags = o.Tags
		case *osm.Relation:
			tags = o.Tags
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
		named++
		hit := false
		for k, v := range m {
			if v == "" {
				continue
			}
			switch {
			case strings.HasPrefix(k, "name:"):
				lang := strings.TrimPrefix(k, "name:")
				if len(lang) <= 3 && lang != "" {
					langs[lang]++
					aliasKeys["name:<lang>"]++
					hit = true
				}
			case k == "alt_name" || k == "short_name" || k == "official_name" ||
				k == "old_name" || k == "loc_name" || k == "int_name" ||
				k == "nat_name" || k == "reg_name" || k == "nickname" ||
				k == "brand" || k == "operator":
				aliasKeys[k]++
				hit = true
				if strings.Contains(v, ";") {
					semicolon++
				}
			}
		}
		if hit {
			withAlias++
		}
	}

	fmt.Printf("named features: %d, of which %d (%.1f%%) carry at least one alternate name\n",
		named, withAlias, 100*float64(withAlias)/float64(named))
	fmt.Printf("semicolon-delimited alias values: %d\n\nby tag:\n", semicolon)

	type kv struct {
		k string
		v int
	}
	var ks []kv
	for k, v := range aliasKeys {
		ks = append(ks, kv{k, v})
	}
	sort.Slice(ks, func(i, j int) bool { return ks[i].v > ks[j].v })
	for _, e := range ks {
		fmt.Printf("  %-16s %8d\n", e.k, e.v)
	}

	var ls []kv
	for k, v := range langs {
		ls = append(ls, kv{k, v})
	}
	sort.Slice(ls, func(i, j int) bool { return ls[i].v > ls[j].v })
	fmt.Println("\ntop name:<lang> codes:")
	for i, e := range ls {
		if i >= 14 {
			break
		}
		fmt.Printf("  name:%-6s %7d\n", e.k, e.v)
	}
}

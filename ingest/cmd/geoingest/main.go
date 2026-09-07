// Command geoingest extracts OSM country files into the normalized record
// stream.
//
// The offline half: pbf decoding, geometry resolution, text folding, street
// grouping and deduplication all happen here, once. The artifact format is the
// contract, so this stage could be rewritten in another language without the
// server noticing.
package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/catalog"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/pbf"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/streets"
)

// A four-country default anyone can build: ~3.5GB against ~30GB for Europe,
// while still spanning the interesting cases — Czechia for the polymorphic
// anchor (47% of addresses have no street), Poland for street-and-city at
// scale, Switzerland for four languages and alpine POIs, Bosnia for sparse
// coverage with Cyrillic and Latin names.
//
// Any subset of config/countries.tsv works; config/groups.tsv names the sets.
const defaultCountries = "@default"

// source pairs an extract file with the country it is authoritative for.
type source struct {
	country string
	path    string
}

func main() {
	var (
		rawDir = flag.String("raw", "../data/raw", "directory holding .osm.pbf extracts")
		outDir = flag.String("out", "../build", "directory for the index artifact")
		list   = flag.String("countries", defaultCountries,
			"comma-separated country codes, or @group names, to ingest")
		configDir = flag.String("config", "../config", "directory holding countries.tsv")
	)
	flag.Parse()

	cat, err := catalog.Load(*configDir)
	if err != nil {
		log.Fatalf("reading the country catalog: %v", err)
	}
	codes, err := cat.Resolve(*list)
	if err != nil {
		log.Fatal(err)
	}

	// Order matters: the first extract to claim an OSM id wins the border-buffer
	// duplicate, so largest first keeps it from whichever side maps more.
	sort.SliceStable(codes, func(i, j int) bool {
		return cat.Countries[codes[i]].Size > cat.Countries[codes[j]].Size
	})

	var sources []source
	for _, c := range codes {
		p := filepath.Join(*rawDir, cat.Countries[c].Filename())
		if _, err := os.Stat(p); err != nil {
			log.Fatalf("missing extract for %s (%s): run `make fetch COUNTRIES=%s`",
				c, cat.Countries[c].Name, *list)
		}
		sources = append(sources, source{country: c, path: p})
	}
	log.Printf("ingesting %d countries: %s", len(codes), strings.Join(codes, ", "))

	if err := run(sources, *outDir); err != nil {
		log.Fatal(err)
	}
}

type manifest struct {
	BuiltAt   time.Time         `json:"built_at"`
	Countries []string          `json:"countries"`
	Sources   map[string]string `json:"sources"`
	Counts    map[string]int    `json:"counts"`
	Extract   map[string]any    `json:"extract_stats"`
	Duration  string            `json:"duration"`
}

func run(sources []source, outDir string) error {
	start := time.Now()
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	outPath := filepath.Join(outDir, "records.ndjson.gz")
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, _ := gzip.NewWriterLevel(f, gzip.BestSpeed)
	defer gz.Close()
	enc := json.NewEncoder(gz)

	var (
		// Deduplicates across extracts: Geofabrik files carry a cross-border buffer,
		// so the Poland extract contains Czech and German villages and every border
		// settlement would be indexed twice. First claim wins.
		//
		// Packed int64 keys, not "osm:n123" strings: ~70M entries at fourteen
		// countries, where string keys cost ~90 bytes each against 16.
		seenOSM = make(map[int64]struct{}, 16_000_000)
		segs    []streets.Segment
		orphans []streets.Segment // addresses with no locality tag of any kind
		places  = map[string]*model.Record{}
		pois    = map[string]*model.Record{}
		counts  = map[string]int{}
		stats   = map[string]any{}
	)

	writeRec := func(r *model.Record) error {
		counts[string(r.Layer)]++
		return enc.Encode(r)
	}

	for _, src := range sources {
		log.Printf("[%s] extracting %s", src.country, filepath.Base(src.path))
		ex := &pbf.Extractor{
			Path:     src.path,
			Country:  src.country,
			Progress: func(s string) { log.Printf("[%s] %s", src.country, s) },
		}
		var route func(*model.Record, string) error

		ex.Emit = func(rf pbf.RawFeature) error {
			key := packOSMKey(rf.OSMType, rf.OSMID)
			if _, dup := seenOSM[key]; dup {
				counts["dedup_cross_extract"]++
				return nil
			}
			seenOSM[key] = struct{}{}

			for _, r := range model.FromTags(rf.OSMType, rf.OSMID, rf.Category,
				rf.Tags, rf.Lat, rf.Lon, src.country, rf.Ring, rf.RingClosed) {
				if err := route(r, src.country); err != nil {
					return err
				}
			}
			return nil
		}

		route = func(r *model.Record, country string) error {
			switch r.Layer {
			case model.LayerPOI:
				// Often mapped twice, as a node inside its own building way. Collapse on
				// name plus a ~500m cell, keeping the fuller one.
				k := fmt.Sprintf("%s|%s|%s|%.3f|%.3f", country, r.Category,
					strings.Join(norm.Tokens(r.Name), " "), r.Lat, r.Lon)
				if prev, ok := pois[k]; ok {
					counts["dedup_poi"]++
					if len(r.Tokens) <= len(prev.Tokens) {
						return nil
					}
				}
				pois[k] = r
				return nil

			case model.LayerStreet:
				// Buffered: grouping needs a locality, and OSM highways almost never carry
				// one. It is derived spatially once every place in every extract has been
				// seen.
				segs = append(segs, streets.Segment{Rec: r, Lat: r.Lat, Lon: r.Lon,
					Country: country})
				return nil

			case model.LayerPlace:
				// Often mapped as both node and area; collapse on name plus a ~1km cell,
				// keeping the higher-ranked class.
				k := fmt.Sprintf("%s|%s|%.2f|%.2f", country,
					strings.Join(norm.Tokens(r.Name), " "), r.Lat, r.Lon)
				if prev, ok := places[k]; ok {
					if settlementRank(r) <= settlementRank(prev) {
						counts["dedup_place"]++
						return nil
					}
					counts["dedup_place"]++
				}
				places[k] = r
				return nil
			}
			// 3.6% of Czech addresses have neither addr:city nor addr:place, so nothing
			// to render or search on. Buffered and resolved spatially alongside the
			// streets; only the orphans, so memory stays bounded.
			if r.Layer == model.LayerAddress && r.City == "" && r.Place == "" {
				orphans = append(orphans, streets.Segment{Rec: r, Lat: r.Lat, Lon: r.Lon,
					Country: src.country})
				return nil
			}
			return writeRec(r)
		}

		st, err := ex.Run(context.Background())
		if err != nil {
			return fmt.Errorf("%s: %w", src.country, err)
		}
		stats[src.country] = st
		log.Printf("[%s] extract stats: %+v", src.country, st)
	}

	// One catchment index over every place seen, shared by all three
	// assignments below. Building it per caller is what left POIs out.
	cat := streets.NewCatchment(places)

	grouped := streets.Group(segs, cat, counts)

	// Locality-less addresses get the same treatment, minus the grouping: each
	// stays its own result, it just gains a city for display and search.
	streets.ResolveOrphanAddresses(orphans, cat, counts)
	log.Printf("resolved locality for %d/%d orphan addresses",
		counts["address_locality_resolved"], len(orphans))
	for i := range orphans {
		if err := writeRec(orphans[i].Rec); err != nil {
			return err
		}
	}

	// And POIs, which had been left out: only the 41.3% carrying addr:city had
	// a locality, so the prior could not break ties between namesakes.
	streets.ResolvePOILocalities(pois, cat, counts)
	log.Printf("resolved locality for %d/%d POIs without one",
		counts["poi_locality_resolved"], len(pois))

	// Stable order, so builds are reproducible.
	log.Printf("grouping %d street segments -> %d streets, %d places",
		len(segs), len(grouped), len(places))
	for _, k := range streets.SortedKeys(grouped) {
		agg := grouped[k]
		agg.Finalize()
		counts["street_segments_merged"] += agg.Segments() - 1
		if err := writeRec(agg.Rec); err != nil {
			return err
		}
	}
	for _, k := range streets.SortedKeysRec(places) {
		if err := writeRec(places[k]); err != nil {
			return err
		}
	}
	for _, k := range streets.SortedKeysRec(pois) {
		if err := writeRec(pois[k]); err != nil {
			return err
		}
	}

	if err := gz.Close(); err != nil {
		return err
	}

	countries := make([]string, 0, len(sources))
	srcMap := map[string]string{}
	for _, s := range sources {
		countries = append(countries, s.country)
		srcMap[s.country] = filepath.Base(s.path)
	}
	man := manifest{
		BuiltAt: time.Now().UTC(), Countries: countries, Sources: srcMap,
		Counts: counts, Extract: stats, Duration: time.Since(start).Round(time.Second).String(),
	}
	mf, err := os.Create(filepath.Join(outDir, "manifest.json"))
	if err != nil {
		return err
	}
	me := json.NewEncoder(mf)
	me.SetIndent("", "  ")
	if err := me.Encode(man); err != nil {
		_ = mf.Close() // already failing; this error adds nothing
		return err
	}
	// Checked, not deferred: a failed Close on a writer means unflushed data.
	if err := mf.Close(); err != nil {
		return err
	}

	fi, _ := os.Stat(outPath)
	log.Printf("wrote %s (%.0f MB) in %s", outPath, float64(fi.Size())/1e6, man.Duration)
	for _, k := range sortedStrKeys(counts) {
		log.Printf("  %-24s %d", k, counts[k])
	}
	return nil
}

// Folds an OSM type and id into one int64; ids are well under 2^62.
func packOSMKey(osmType byte, id int64) int64 {
	var t int64
	switch osmType {
	case 'w':
		t = 1
	case 'r':
		t = 2
	}
	return id<<2 | t
}

// Ranks duplicate place features so the better mapping survives. Ranks
// settlement classes so deduplication can keep the better of two records for
// the same place. Not the ranking prior — that is anchor.placePrior, which is a
// different curve for a different job. This one only has to order two
// candidates that are already known to be the same settlement.
func settlementRank(r *model.Record) float64 {
	s := float64(r.Population) / 1e6
	switch r.PlaceType {
	case "city":
		s += 6
	case "town":
		s += 5
	case "village":
		s += 4
	case "suburb", "borough":
		s += 3
	case "quarter", "neighbourhood":
		s += 2
	default:
		s += 1
	}
	return s
}

func sortedStrKeys(m map[string]int) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}

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
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/catalog"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/pbf"
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

// One way of a named street, buffered until the places layer can say which
// settlement it is in.
type streetSeg struct {
	rec      *model.Record
	lat, lon float64
	country  string
}

// Accumulates the many way segments of one named street into a single record.
//
// A street is split at every junction and attribute change, so one result per
// segment would bury everything else. Segments group by (name, locality) and
// reduce to the sampled midpoint nearest their mean — the mean itself can fall
// off an L-shaped street, a midpoint cannot.
type streetAgg struct {
	rec     *model.Record
	sumLat  float64
	sumLon  float64
	n       int
	samples [][2]float64
}

const maxStreetSamples = 16

func (s *streetAgg) add(lat, lon float64) {
	s.sumLat += lat
	s.sumLon += lon
	s.n++
	if len(s.samples) < maxStreetSamples {
		s.samples = append(s.samples, [2]float64{lat, lon})
	}
}

func (s *streetAgg) finalize() {
	if s.n == 0 {
		return
	}
	mLat, mLon := s.sumLat/float64(s.n), s.sumLon/float64(s.n)
	best, bestD := s.samples[0], math.MaxFloat64
	for _, p := range s.samples {
		// Planar distance is ample for choosing between points on one street.
		dy := p[0] - mLat
		dx := (p[1] - mLon) * math.Cos(mLat*math.Pi/180)
		if d := dy*dy + dx*dx; d < bestD {
			best, bestD = p, d
		}
	}
	s.rec.Lat, s.rec.Lon = best[0], best[1]

	// A street is linear, so one point misdescribes it. Keep the sampled
	// midpoints as an open shape; an unordered set suffices, since only the
	// minimum distance to any of them is needed.
	if len(s.samples) > 1 {
		pts := make([]geom.Point, len(s.samples))
		for i, p := range s.samples {
			pts[i] = geom.Point{Lat: p[0], Lon: p[1]}
		}
		if geom.Bounds(pts).DiagonalMetres() >= minStreetShapeM {
			s.rec.Shape = make([]float64, 0, 2*len(pts))
			for _, p := range pts {
				s.rec.Shape = append(s.rec.Shape, p.Lat, p.Lon)
			}
			s.rec.Closed = false
		}
	}
}

// Below this a street's single point is within clicking tolerance. Most
// residential streets fall under it.
const minStreetShapeM = 150

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
		// Deduplicates across extracts: Geofabrik files carry a cross-border
		// buffer, so the Poland extract contains Czech and German villages and
		// every border settlement would be indexed twice. First claim wins.
		//
		// Packed int64 keys, not "osm:n123" strings: ~70M entries at fourteen
		// countries, where string keys cost ~90 bytes each against 16.
		seenOSM = make(map[int64]struct{}, 16_000_000)
		segs    []streetSeg
		orphans []streetSeg // addresses with no locality tag of any kind
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
		// Declared up front: Emit calls it, and it is defined below.
		var route func(*model.Record, string) error

		ex.Emit = func(rf pbf.RawFeature) error {
			key := packOSMKey(rf.OSMType, rf.OSMID)
			if _, dup := seenOSM[key]; dup {
				counts["dedup_cross_extract"]++
				return nil
			}
			seenOSM[key] = struct{}{}

			for _, r := range model.FromTags(rf.OSMType, rf.OSMID, rf.Category,
				rf.Tags, rf.Lat, rf.Lon, src.country, rf.Ring) {
				if err := route(r, src.country); err != nil {
					return err
				}
			}
			return nil
		}

		route = func(r *model.Record, country string) error {
			switch r.Layer {
			case model.LayerPOI:
				// Often mapped twice, as a node inside its own building way.
				// Collapse on name plus a ~500m cell, keeping the fuller one.
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
				// Buffered: grouping needs a locality, and OSM highways almost
				// never carry one. It is derived spatially once every place in
				// every extract has been seen.
				segs = append(segs, streetSeg{rec: r, lat: r.Lat, lon: r.Lon,
					country: country})
				return nil

			case model.LayerPlace:
				// Often mapped as both node and area; collapse on name plus a
				// ~1km cell, keeping the higher-ranked class.
				k := fmt.Sprintf("%s|%s|%.2f|%.2f", country,
					strings.Join(norm.Tokens(r.Name), " "), r.Lat, r.Lon)
				if prev, ok := places[k]; ok {
					if placeScore(r) <= placeScore(prev) {
						counts["dedup_place"]++
						return nil
					}
					counts["dedup_place"]++
				}
				places[k] = r
				return nil
			}
			// 3.6% of Czech addresses have neither addr:city nor addr:place, so
			// nothing to render or search on. Buffered and resolved spatially
			// alongside the streets; only the orphans, so memory stays bounded.
			if r.Layer == model.LayerAddress && r.City == "" && r.Place == "" {
				orphans = append(orphans, streetSeg{rec: r, lat: r.Lat, lon: r.Lon,
					country: src.country})
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

	// Assign a locality to every street segment, then group.
	streets := groupStreets(segs, places, counts)

	// Same treatment for locality-less addresses, minus the grouping: each is
	// still its own result, it just gains a city for display and search.
	resolveOrphanAddresses(orphans, places, counts)
	for i := range orphans {
		if err := writeRec(orphans[i].rec); err != nil {
			return err
		}
	}

	// Stable order, so builds are reproducible.
	log.Printf("grouping %d street segments -> %d streets, %d places",
		len(segs), len(streets), len(places))
	for _, k := range sortedKeys(streets) {
		agg := streets[k]
		agg.finalize()
		counts["street_segments_merged"] += agg.n - 1
		if err := writeRec(agg.rec); err != nil {
			return err
		}
	}
	for _, k := range sortedKeysRec(places) {
		if err := writeRec(places[k]); err != nil {
			return err
		}
	}
	for _, k := range sortedKeysRec(pois) {
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

// Ranks duplicate place features so the better mapping survives.
func placeScore(r *model.Record) float64 {
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

func sortedKeys(m map[string]*streetAgg) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}
func sortedKeysRec(m map[string]*model.Record) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}
func sortedStrKeys(m map[string]int) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}

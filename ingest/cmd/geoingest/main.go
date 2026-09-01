// Command geoingest builds the geocoder's index artifact from OpenStreetMap
// country extracts.
//
// It is the offline half of the system. Everything expensive — pbf decoding,
// geometry resolution, text folding, street grouping, deduplication — happens
// here, once, and the result is an immutable artifact the TypeScript server
// loads at boot and never mutates. The artifact format is the contract between
// the two halves; this stage could be rewritten in Java or Rust without the
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

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/pbf"
)

// source pairs an extract file with the country it is authoritative for.
type source struct {
	country string
	path    string
}

func main() {
	var (
		rawDir = flag.String("raw", "../data/raw", "directory holding .osm.pbf extracts")
		outDir = flag.String("out", "../build", "directory for the index artifact")
		list   = flag.String("countries", "cz,pl", "comma-separated country codes to ingest")
	)
	flag.Parse()

	files := map[string]string{
		"cz": "czech-republic-latest.osm.pbf",
		"pl": "poland-latest.osm.pbf",
		"ba": "bosnia-herzegovina-latest.osm.pbf",
	}

	var sources []source
	for _, c := range strings.Split(*list, ",") {
		c = strings.TrimSpace(c)
		f, ok := files[c]
		if !ok {
			log.Fatalf("unknown country %q (known: cz, pl, ba)", c)
		}
		p := filepath.Join(*rawDir, f)
		if _, err := os.Stat(p); err != nil {
			log.Fatalf("missing extract for %s: %v", c, err)
		}
		sources = append(sources, source{country: c, path: p})
	}

	if err := run(sources, *outDir); err != nil {
		log.Fatal(err)
	}
}

// streetSeg is one OSM way of a named street, buffered until the places layer
// is complete enough to say which settlement it belongs to.
type streetSeg struct {
	rec      *model.Record
	lat, lon float64
	country  string
}

// streetAgg accumulates the many OSM way segments that make up one named street
// into a single searchable record.
//
// A street is split into dozens of ways at every junction and attribute change;
// emitting one result per segment would bury everything else in the ranking.
// Segments are grouped by (folded name, folded locality) and reduced to one
// point. We keep a running mean plus a bounded sample of segment midpoints, and
// finally pick the sampled midpoint nearest the mean: the mean itself can fall
// off an L-shaped or crescent street, whereas a midpoint always lies on it.
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
		// seenOSM deduplicates across extracts. Geofabrik country files carry a
		// cross-border buffer: the Poland extract contains Czech villages
		// (Detrichovec) and German ones (Gorlitz). Without this, every border
		// settlement is indexed twice. First extract to claim an OSM ID wins.
		seenOSM = make(map[string]struct{}, 12_000_000)
		segs    []streetSeg
		orphans []streetSeg // addresses with no locality tag of any kind
		places  = map[string]*model.Record{}
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
		ex.Emit = func(rf pbf.RawFeature) error {
			key := "osm:" + string(rf.OSMType) + fmt.Sprint(rf.OSMID)
			if _, dup := seenOSM[key]; dup {
				counts["dedup_cross_extract"]++
				return nil
			}
			seenOSM[key] = struct{}{}

			r := model.FromTags(rf.OSMType, rf.OSMID, rf.Tags, rf.Lat, rf.Lon, src.country)
			if r == nil {
				return nil
			}

			switch r.Layer {
			case model.LayerStreet:
				// Buffered: grouping needs a locality, and OSM highways almost
				// never carry one. It is derived spatially once every place in
				// every extract has been seen.
				segs = append(segs, streetSeg{rec: r, lat: r.Lat, lon: r.Lon,
					country: src.country})
				return nil

			case model.LayerPlace:
				// A settlement is often mapped as both a node and an area.
				// Collapse them on name plus a ~1km cell, keeping the
				// higher-ranked class (a "town" beats a "suburb" of the name).
				k := fmt.Sprintf("%s|%s|%.2f|%.2f", src.country,
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
			// An address with neither addr:city nor addr:place (3.6% of
			// Czechia) has no locality to render or search on. Buffer it and
			// resolve it spatially alongside the streets. Only the orphans are
			// buffered, so peak memory stays a few hundred MB rather than the
			// several GB holding every address would cost.
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

	// Flush the grouped layers in a stable order so builds are reproducible.
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
	defer mf.Close()
	me := json.NewEncoder(mf)
	me.SetIndent("", "  ")
	if err := me.Encode(man); err != nil {
		return err
	}

	fi, _ := os.Stat(outPath)
	log.Printf("wrote %s (%.0f MB) in %s", outPath, float64(fi.Size())/1e6, man.Duration)
	for _, k := range sortedStrKeys(counts) {
		log.Printf("  %-24s %d", k, counts[k])
	}
	return nil
}

// placeScore ranks duplicate place features so the better mapping survives.
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

// Command geoindex turns the record stream into the binary artifact.
//
// Separate from extraction on purpose: extraction is bound by pbf decoding and
// changes when OSM tagging does, indexing is bound by sorting and changes when
// ranking or the layout does. Retuning the index costs 36s, not 3m30s.
package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"flag"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/anchor"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/buildmem"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/index"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
)

func main() {
	in := flag.String("in", "../build/records.ndjson.gz", "record stream from geoingest")
	out := flag.String("out", "../build/index", "output directory for the artifact")
	flag.Parse()
	buildmem.SetLimit()
	if err := run(*in, *out); err != nil {
		log.Fatal(err)
	}
}

// Walks the record stream.
func scan(inPath string, fn func(*model.Record) error) error {
	f, err := os.Open(inPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var r model.Record
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			return err
		}
		if err := fn(&r); err != nil {
			return err
		}
	}
	return sc.Err()
}

func run(inPath, outDir string) error {
	start := time.Now()
	b := index.NewBuilder()
	countries := map[string]bool{}

	// Two passes, because geoingest emits addresses while streaming the pbf but
	// can only emit streets and places after grouping — so anchors arrive last. A
	// single pass would create a placeholder for every address anchor and then
	// discard the real record behind it.
	nAnchor := 0
	if err := scan(inPath, func(r *model.Record) error {
		countries[r.Country] = true
		if r.Layer == model.LayerAddress {
			return nil
		}
		anchor.Add(b, r)
		nAnchor++
		return nil
	}); err != nil {
		return err
	}
	log.Printf("pass 1: %d anchor records -> %d anchors", nAnchor, len(b.Anchors))
	buildmem.Log("after pass 1")

	// Lets a place-anchored address find its village. Keying on the address's own
	// addr:city would miss: a village is keyed on its name, while an address in it
	// may carry the surrounding municipality.
	placesByName := map[string][]uint32{}
	for id := range b.Anchors {
		a := &b.Anchors[id]
		if a.Layer == index.LayerPlace {
			nm := b.Strings.Get(a.NameID)
			k := anchor.PlaceNameKey(a.Country, nm)
			placesByName[k] = append(placesByName[k], uint32(id))
		}
	}

	n := 0
	if err := scan(inPath, func(r *model.Record) error {
		if r.Layer != model.LayerAddress {
			return nil
		}
		n++
		anchor.AddAddress(b, r, placesByName)
		if n%4_000_000 == 0 {
			log.Printf("  pass 2: %dM addresses", n/1e6)
		}
		return nil
	}); err != nil {
		return err
	}
	log.Printf("pass 2: %d addresses -> %d anchors total", n, len(b.Anchors))
	buildmem.Log("after pass 2")

	cs := make([]string, 0, len(countries))
	for c := range countries {
		cs = append(cs, c)
	}
	man := &index.Manifest{
		BuiltAt:   time.Now().UTC().Format(time.RFC3339),
		Countries: cs,
		Bytes:     map[string]int{},
	}
	if err := b.Finish(outDir, man); err != nil {
		return err
	}
	man.Duration = time.Since(start).Round(time.Millisecond).String()

	// Rewrite the manifest now that the duration is known.
	mf, err := os.Create(filepath.Join(outDir, "manifest.json"))
	if err != nil {
		return err
	}
	e := json.NewEncoder(mf)
	e.SetIndent("", "  ")
	if err := e.Encode(man); err != nil {
		_ = mf.Close() // already failing; this error adds nothing
		return err
	}
	// Checked, not deferred: a failed Close on a writer means unflushed data.
	if err := mf.Close(); err != nil {
		return err
	}

	total := 0
	for _, v := range man.Bytes {
		total += v
	}
	log.Printf("wrote %s: %d anchors, %d addresses, %d terms, %d postings, %.1f MB in %s",
		outDir, man.NumAnchors, man.NumAddrs, man.NumTerms, man.NumPosting,
		float64(total)/1e6, man.Duration)
	for k, v := range b.Counts {
		log.Printf("  %-34s %d", k, v)
	}
	return nil
}

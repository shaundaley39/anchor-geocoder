// Command formatconsts emits the constants both halves must agree on, for the
// TypeScript side to assert against.
//
// Six values are hand-mirrored across the boundary, and every one fails
// silently on drift: a reader with the wrong cell stride finds nothing, one
// with the wrong layer codes mislabels everything. Same trick as the fold
// vectors — make the contract executable.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"os"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/index"
)

func main() {
	out := flag.String("out", "../server/test/format-constants.json", "fixture output")
	flag.Parse()

	consts := map[string]any{
		"version":     index.Version,
		"coordScale":  index.CoordScale,
		"layerStreet": index.LayerStreet,
		"layerPlace":  index.LayerPlace,
		"layerPOI":    index.LayerPOI,
		"altSep":      index.AltSep,
		"cellDeg":     index.CellDeg,
		"cellOrigin":  index.CellOrigin,
		"cellStride":  index.CellStride,
		"kdNodeSize":  index.KDNodeSize,
		"termSep":     index.TermSep,
		"termMissing": index.TermMissing,
	}

	f, err := os.Create(*out)
	if err != nil {
		log.Fatal(err)
	}
	e := json.NewEncoder(f)
	e.SetIndent("", "  ")
	if err := e.Encode(consts); err != nil {
		_ = f.Close()
		log.Fatal(err)
	}
	if err := f.Close(); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %d format constants to %s", len(consts), *out)
}

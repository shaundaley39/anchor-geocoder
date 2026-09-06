// Command formatconsts emits the constants that both halves of the system must
// agree on, for the TypeScript side to assert against.
//
// The artifact format is the contract between a Go writer and a TypeScript
// reader, and six values are currently hand-mirrored across that boundary: the
// format version, the coordinate scale, three layer codes, the alternate-name
// separator, and the containment grid's geometry. Every one of them fails
// silently if it drifts — wrong results, not an error. A reader with the wrong
// cell stride simply finds nothing; one with the wrong layer codes labels every
// result incorrectly.
//
// This is the same trick the fold vectors use for the normalizer: make the
// contract executable rather than hoping a comment is enough.
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

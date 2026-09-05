// Command geoindex turns the normalized record stream from geoingest into the
// binary index artifact the TypeScript server loads.
//
// It is a separate stage from extraction on purpose: extraction is bound by pbf
// decoding and is the part that changes when OSM tagging changes, whereas
// indexing is bound by sorting and is the part that changes when ranking or the
// on-disk layout changes. Keeping them apart means retuning the index does not
// mean re-reading 3GB of pbf.
package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"flag"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/index"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
)

func main() {
	in := flag.String("in", "../build/records.ndjson.gz", "record stream from geoingest")
	out := flag.String("out", "../build/index", "output directory for the artifact")
	flag.Parse()
	if err := run(*in, *out); err != nil {
		log.Fatal(err)
	}
}

// scan walks the record stream, invoking fn for every record.
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

	// Two passes over the record stream, because geoingest emits addresses as
	// it streams the pbf but can only emit streets and places after grouping
	// them — so anchors arrive last. A single pass would create a placeholder
	// for every address anchor and then throw away the real street record that
	// arrived behind it. Decompressing 570MB twice costs ~25s and is the
	// cheapest way to get the ordering right.
	//
	// Pass 1: every real anchor.
	nAnchor := 0
	if err := scan(inPath, func(r *model.Record) error {
		countries[r.Country] = true
		if r.Layer == model.LayerAddress {
			return nil
		}
		addAnchor(b, r)
		nAnchor++
		return nil
	}); err != nil {
		return err
	}
	log.Printf("pass 1: %d anchor records -> %d anchors", nAnchor, len(b.Anchors))

	// placesByName lets a place-anchored address find the actual village it
	// belongs to. Keying on the address's own addr:city would miss, because a
	// village record is keyed on its own name while an address in it may be
	// tagged with the surrounding municipality (place=Zboiska, city=Dukla).
	placesByName := map[string][]uint32{}
	for id := range b.Anchors {
		a := &b.Anchors[id]
		if a.Layer == index.LayerPlace {
			nm := b.Strings.Get(a.NameID)
			k := placeNameKey(a.Country, nm)
			placesByName[k] = append(placesByName[k], uint32(id))
		}
	}

	// Pass 2: addresses, resolved onto the anchors from pass 1.
	n := 0
	if err := scan(inPath, func(r *model.Record) error {
		if r.Layer != model.LayerAddress {
			return nil
		}
		n++
		addAddress(b, r, placesByName)
		if n%4_000_000 == 0 {
			log.Printf("  pass 2: %dM addresses", n/1e6)
		}
		return nil
	}); err != nil {
		return err
	}
	log.Printf("pass 2: %d addresses -> %d anchors total", n, len(b.Anchors))

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
	defer mf.Close()
	e := json.NewEncoder(mf)
	e.SetIndent("", "  ")
	if err := e.Encode(man); err != nil {
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

func coord(v float64) int32 { return int32(math.Round(v * index.CoordScale)) }

func placeNameKey(country uint8, name string) string {
	return string(rune('0'+country)) + "|" + strings.Join(norm.Tokens(name), " ")
}

func addAnchor(b *index.Builder, r *model.Record) {
	name := r.Name
	if name == "" {
		name = r.Street
	}
	if name == "" {
		return
	}
	layer := index.LayerStreet
	switch r.Layer {
	case model.LayerPlace:
		layer = index.LayerPlace
	case model.LayerPOI:
		layer = index.LayerPOI
	}
	var key string
	switch layer {
	case index.LayerPlace:
		key = index.PlaceKey(r.Country, norm.Tokens(name), r.Lat, r.Lon)
	case index.LayerPOI:
		key = index.POIKey(r.ID)
	default:
		key = index.AnchorKey(r.Country, layer, norm.Tokens(name), norm.Tokens(r.City))
	}
	id, _ := b.AnchorID(key)
	a := &b.Anchors[id]

	// Two real records with the same key: geoingest already deduplicated within
	// a layer, so this is rare. Keep the higher-scoring one.
	if a.Real {
		b.Counts["anchor_duplicate_key"]++
		if placeScore(r) <= a.Score {
			return
		}
	}
	a.Real = true
	a.NameID = b.Strings.Intern(name)
	a.LocalID = b.Strings.Intern(r.City)
	a.Lat, a.Lon = coord(r.Lat), coord(r.Lon)
	a.Country = b.CountryID(r.Country)
	a.Tokens = r.Tokens
	a.Layer = layer
	if len(r.AltNames) > 0 {
		a.AltID = b.Strings.Intern(strings.Join(r.AltNames, index.AltSep))
	}

	switch layer {
	case index.LayerPlace:
		a.Score = placeScore(r)
		b.Counts["anchor_place"]++
	case index.LayerPOI:
		a.Score = poiScore(r)
		a.CatID = b.Strings.Intern(r.Category)
		b.Counts["anchor_poi"]++
	default:
		a.Score = 1
		b.Counts["anchor_street"]++
	}
}

// poiScore is the importance prior for a point of interest, on the same scale
// as placeScore where an ordinary street is 1.
//
// The ordering reflects what people actually search for by name. A railway
// station or an airport is a navigation landmark and should outrank a village;
// a hairdresser should not. Chain retail sits in the middle: "Lidl" is a common
// and reasonable query, but it should never beat a town called Lidl would-be.
func poiScore(r *model.Record) float32 {
	switch r.Category {
	case "aeroway=aerodrome":
		return 7
	case "railway=station", "public_transport=station":
		return 5.5
	case "amenity=hospital", "amenity=university":
		return 5
	case "historic=castle", "tourism=museum", "tourism=zoo", "tourism=theme_park":
		return 4.5
	case "railway=halt", "amenity=bus_station", "amenity=townhall",
		"amenity=college", "tourism=attraction":
		return 4
	case "amenity=theatre", "amenity=cinema", "tourism=gallery",
		"historic=monument", "leisure=stadium", "amenity=library":
		return 3.5
	case "amenity=school", "amenity=place_of_worship", "leisure=park",
		"amenity=police", "amenity=post_office", "railway=tram_stop":
		return 3
	case "tourism=hotel", "amenity=pharmacy", "amenity=fuel",
		"shop=supermarket", "shop=mall", "amenity=marketplace":
		return 2.5
	}
	// Everything else that survived curation: shops, cafes, offices, clinics.
	// Above a plain street, below any settlement.
	return 1.8
}

// placeScore is the importance prior for a settlement, on a scale where an
// ordinary street is 1. Population dominates when it is tagged; the settlement
// class is the fallback, and both are compressed logarithmically so Warsaw does
// not outscore every street in the country by six orders of magnitude.
func placeScore(r *model.Record) float32 {
	if r.Layer != model.LayerPlace {
		return 1
	}
	base := map[string]float64{
		"city": 6, "borough": 4.5, "municipality": 4, "town": 3.5,
		"suburb": 2.5, "quarter": 2, "village": 2,
		"neighbourhood": 1.5, "hamlet": 1.2, "isolated_dwelling": 1,
	}[r.PlaceType]
	if base == 0 {
		base = 1
	}
	if r.Population > 0 {
		base += math.Log10(float64(r.Population)) // +6 for a million-person city
	}
	return float32(base)
}

func addAddress(b *index.Builder, r *model.Record, placesByName map[string][]uint32) {
	anchorName, kind := r.Anchor()
	if anchorName == "" {
		// Neither a street nor a place to hang the number off: 4,460 of 11.6M.
		// Left out of the index rather than indexed unfindably.
		b.Counts["address_no_anchor"]++
		return
	}
	cc := b.CountryID(r.Country)

	var id uint32
	if kind == model.AnchorPlace {
		// Bind to the nearest real place of that name. Candidate lists are
		// tiny (a name repeats a handful of times per country), so a linear
		// scan beats building a spatial index for it.
		cands := placesByName[placeNameKey(cc, anchorName)]
		best, bestD := uint32(0), math.MaxFloat64
		found := false
		for _, c := range cands {
			a := &b.Anchors[c]
			dLat := float64(a.Lat)/index.CoordScale - r.Lat
			dLon := (float64(a.Lon)/index.CoordScale - r.Lon) *
				math.Cos(r.Lat*math.Pi/180)
			if d := dLat*dLat + dLon*dLon; d < bestD {
				best, bestD, found = c, d, true
			}
		}
		if found {
			id = best
			b.Counts["address_bound_to_place"]++
		} else {
			id = b.NewSynthetic(anchorName, r.City, cc, index.LayerPlace,
				b.Strings, append(norm.Tokens(anchorName), norm.Tokens(r.City)...))
			b.Counts["anchor_synthetic_place"]++
		}
	} else {
		key := index.AnchorKey(r.Country, index.LayerStreet,
			norm.Tokens(anchorName), norm.Tokens(r.City))
		var created bool
		id, created = b.AnchorID(key)
		if created {
			// A street name that appears in addr:street but was never mapped
			// as a highway way.
			a := &b.Anchors[id]
			a.NameID = b.Strings.Intern(anchorName)
			a.LocalID = b.Strings.Intern(r.City)
			a.Country = cc
			a.Layer = index.LayerStreet
			a.Score = 1
			a.Tokens = append(norm.Tokens(anchorName), norm.Tokens(r.City)...)
			b.Counts["anchor_synthetic_street"]++
		}
	}

	b.Addrs = append(b.Addrs, index.Address{
		AnchorID: id,
		NumID:    b.Strings.Intern(r.HouseNumber),
		Lat:      coord(r.Lat),
		Lon:      coord(r.Lon),
		SortKey:  index.LeadingInt(r.HouseNumber),
	})
}

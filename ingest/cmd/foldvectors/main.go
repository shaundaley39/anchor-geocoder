// Command foldvectors emits fold/tokenize fixtures for the server to verify
// itself against.
//
// The server re-implements the Go normalizer, and index terms were folded by
// Go. Drift makes queries silently return nothing. Vectors come from real names
// in the built artifact plus hand-picked edge cases.
package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"flag"
	"log"
	"os"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
)

type vector struct {
	In     string   `json:"in"`
	Fold   string   `json:"fold"`
	Tokens []string `json:"tokens"`
}

// Edge cases that must never regress, whatever the current extracts hold.
var handPicked = []string{
	"Plzeň", "Náměstí Míru", "Český Krumlov", "Dlouhá třída", "U Půjčovny 2/953",
	"Łódź", "Marszałkowska", "Świętokrzyska", "Gdańsk", "Zażółć gęślą jaźń",
	"ul. Marszałkowska", "ulica Marszałkowska", "al. Jerozolimskie", "Aleje Jerozolimskie",
	"nám. Míru", "tř. Svobody", "Rynek", "Plac", "Ulice",
	"Đakovo", "Široki Brijeg", "Бања Лука", "Banja Luka", "Сарајево", "Sarajevo",
	"Мостар", "Tuzla", "Њемачка", "Џамија",
	"248/39", "ev.38", "12A", "2410/8a", "",
	"  spaced   out  ", "ß straße", "Ø", "ﬁ ligature", "ĂǍÂ", "1/2/3",
}

func main() {
	in := flag.String("in", "../build/records.ndjson.gz", "record stream")
	out := flag.String("out", "../server/test/fold-vectors.json", "fixture output")
	n := flag.Int("n", 4000, "how many real names to sample")
	flag.Parse()

	seen := map[string]bool{}
	var names []string
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			names = append(names, s)
		}
	}
	for _, s := range handPicked {
		seen[s] = true
		names = append(names, s)
	}

	// Across the corpus, not the first N — that would cover one country and one
	// import batch.
	f, err := os.Open(*in)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		log.Fatal(err)
	}
	defer gz.Close()
	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	i := 0
	for sc.Scan() && len(names) < *n {
		i++
		if i%997 != 0 { // stride through the file
			continue
		}
		var r model.Record
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			continue
		}
		add(r.Name)
		add(r.Street)
		add(r.City)
		add(r.Place)
		add(r.HouseNumber)
	}

	vecs := make([]vector, 0, len(names))
	for _, s := range names {
		t := norm.Tokens(s)
		if t == nil {
			t = []string{}
		}
		vecs = append(vecs, vector{In: s, Fold: norm.Fold(s), Tokens: t})
	}

	of, err := os.Create(*out)
	if err != nil {
		log.Fatal(err)
	}
	e := json.NewEncoder(of)
	e.SetIndent("", " ")
	if err := e.Encode(vecs); err != nil {
		_ = of.Close() // already failing; this error adds nothing
		log.Fatal(err)
	}
	// Checked, not deferred: a failed Close on a writer means unflushed data,
	// and silently reporting a truncated file as success is worse than a crash.
	if err := of.Close(); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %d fold vectors to %s", len(vecs), *out)
}

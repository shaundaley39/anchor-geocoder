package index

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// Assembles the artifact.
type Builder struct {
	Strings   *StringTable
	Anchors   []Anchor
	Addrs     []Address
	byKey     map[string]uint32
	Counts    map[string]int
	Countries map[string]int
}

func NewBuilder() *Builder {
	return &Builder{
		Strings:   NewStringTable(),
		byKey:     map[string]uint32{},
		Counts:    map[string]int{},
		Countries: map[string]int{},
	}
}

func (b *Builder) CountryID(cc string) uint8 {
	if id, ok := b.Countries[cc]; ok {
		return uint8(id)
	}
	id := len(b.Countries)
	b.Countries[cc] = id
	return uint8(id)
}

// The id for an anchor key, creating a placeholder if unseen: 141,524 anchors
// are referenced only by addresses, never mapped in their own right.
func (b *Builder) AnchorID(key string) (uint32, bool) {
	if id, ok := b.byKey[key]; ok {
		return id, false
	}
	id := uint32(len(b.Anchors))
	b.byKey[key] = id
	b.Anchors = append(b.Anchors, Anchor{Key: key})
	return id, true
}

// An anchor for a name referenced only by address points.
func (b *Builder) NewSynthetic(name, locality string, country, layer uint8,
	st *StringTable, tokens []string, lat, lon int32) uint32 {
	id := uint32(len(b.Anchors))
	b.Anchors = append(b.Anchors, Anchor{
		NameID:  st.Intern(name),
		LocalID: st.Intern(locality),
		Country: country,
		Layer:   layer,
		Score:   1,
		Tokens:  tokens,
		MinLat:  lat, MaxLat: lat, MinLon: lon, MaxLon: lon,
		NameTokens: 1,
	})
	return id
}

// Sorts address runs, links them to anchors, builds the inverted index, writes.
func (b *Builder) Finish(dir string, man *Manifest) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	// By anchor, then house number. SortKey then raw string keeps "12", "12A",
	// "12B" adjacent and ordered.
	sort.Slice(b.Addrs, func(i, j int) bool {
		a, c := b.Addrs[i], b.Addrs[j]
		if a.AnchorID != c.AnchorID {
			return a.AnchorID < c.AnchorID
		}
		if a.SortKey != c.SortKey {
			return a.SortKey < c.SortKey
		}
		return b.Strings.list[a.NumID] < b.Strings.list[c.NumID]
	})

	// A proper CSR offset array: an anchor with no addresses takes the offset
	// of the next run, not zero. The server recovers an address's anchor by
	// binary-searching this (244MB saved), which needs it non-decreasing —
	// zeroes would break it for every POI, and POIs are most anchors.
	counts := make([]uint32, len(b.Anchors))
	for _, ad := range b.Addrs {
		counts[ad.AnchorID]++
	}
	var running uint32
	for i := range b.Anchors {
		b.Anchors[i].AddrStart = running
		b.Anchors[i].AddrCount = counts[i]
		running += counts[i]
	}
	if int(running) != len(b.Addrs) {
		return fmt.Errorf("address range accounting: %d != %d", running, len(b.Addrs))
	}

	// A placeholder borrows the centroid of its address run, so it is still a
	// usable standalone result.
	for i := range b.Anchors {
		a := &b.Anchors[i]
		if a.Lat != 0 || a.Lon != 0 || a.AddrCount == 0 {
			continue
		}
		var sLat, sLon float64
		run := b.Addrs[a.AddrStart : a.AddrStart+a.AddrCount]
		for _, ad := range run {
			sLat += float64(ad.Lat)
			sLon += float64(ad.Lon)
		}
		a.Lat = int32(sLat / float64(len(run)))
		a.Lon = int32(sLon / float64(len(run)))
		b.Counts["anchor_centroid_from_addresses"]++
	}

	// Degenerate to the anchor's own point when there is no extent. Done here
	// because the k-d tree and the containment grid both read it.
	for i := range b.Anchors {
		a := &b.Anchors[i]
		if a.MinLat == 0 && a.MaxLat == 0 {
			a.MinLat, a.MaxLat = a.Lat, a.Lat
			a.MinLon, a.MaxLon = a.Lon, a.Lon
		}
	}

	if err := b.writeAnchors(dir, man); err != nil {
		return err
	}
	if err := b.writeSpatial(dir, man); err != nil {
		return err
	}
	if err := b.writeAddrs(dir, man); err != nil {
		return err
	}
	if err := b.writeIndex(dir, man); err != nil {
		return err
	}

	n, err := b.Strings.Write(dir, "strings")
	if err != nil {
		return err
	}
	man.Bytes["strings"] = n
	man.NumStrings = b.Strings.Len()
	man.NumAnchors = len(b.Anchors)
	man.NumAddrs = len(b.Addrs)
	man.Version = Version
	man.Counts = b.Counts
	man.NumPOIs = b.Counts["anchor_poi"]
	man.CountryIDs = b.Countries

	mf, err := os.Create(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return err
	}
	e := json.NewEncoder(mf)
	e.SetIndent("", "  ")
	if err := e.Encode(man); err != nil {
		_ = mf.Close() // already failing; this error adds nothing
		return err
	}
	// Checked, not deferred: a failed Close on a writer means unflushed data,
	// and reporting a truncated manifest as a successful build is worse than
	// failing loudly.
	return mf.Close()
}

func (b *Builder) writeAnchors(dir string, man *Manifest) error {
	n := len(b.Anchors)
	name := make([]uint32, n)
	local := make([]uint32, n)
	lat := make([]int32, n)
	lon := make([]int32, n)
	flags := make([]byte, n)
	country := make([]byte, n)
	minLat := make([]int32, n)
	minLon := make([]int32, n)
	maxLat := make([]int32, n)
	maxLon := make([]int32, n)
	geomOff := make([]uint32, n+1)
	closed := make([]byte, n)
	var geomFlat []int32
	score := make([]float32, n)
	cat := make([]uint32, n)
	alt := make([]uint32, n)
	ntok := make([]byte, n)
	start := make([]uint32, n)
	count := make([]uint32, n)

	for i, a := range b.Anchors {
		name[i], local[i] = a.NameID, a.LocalID
		lat[i], lon[i] = a.Lat, a.Lon
		flags[i] = a.Layer
		country[i] = a.Country
		score[i] = a.Score
		cat[i] = a.CatID
		alt[i] = a.AltID
		ntok[i] = a.NameTokens

		minLat[i], minLon[i] = a.MinLat, a.MinLon
		maxLat[i], maxLon[i] = a.MaxLat, a.MaxLon

		geomOff[i] = uint32(len(geomFlat) / 2)
		geomFlat = append(geomFlat, a.Shape...)
		if a.Closed {
			closed[i] = 1
		}
		start[i], count[i] = a.AddrStart, a.AddrCount
	}
	w := map[string]any{
		"anchor_name": name, "anchor_local": local,
		"anchor_lat": lat, "anchor_lon": lon,
		"anchor_flags": flags, "anchor_country": country,
		"anchor_score": score, "anchor_cat": cat,
		"anchor_alt": alt, "anchor_ntok": ntok,
		"anchor_minlat": minLat, "anchor_minlon": minLon,
		"anchor_maxlat": maxLat, "anchor_maxlon": maxLon,
		"anchor_addr_start": start, "anchor_addr_count": count,
		"geom": geomFlat, "geom_off": geomOff, "geom_closed": closed,
	}
	man.NumShapes = 0
	for i := 0; i < n; i++ {
		if geomOff[i+1] > geomOff[i] {
			man.NumShapes++
		}
	}
	man.NumVertices = len(geomFlat) / 2
	return writeAll(dir, w, man)
}

// The two structures the server used to build at boot: the k-d permutation and
// the containment grid. Together ~5.4s of startup, paid by every replica on
// every deploy.
func (b *Builder) writeSpatial(dir string, man *Manifest) error {
	nAddr := len(b.Addrs)
	n := nAddr + len(b.Anchors)

	// Ids below nAddr index addresses, at or above them anchors; the server
	// resolves them the same way.
	getY := func(i int) int32 {
		if i < nAddr {
			return b.Addrs[i].Lat
		}
		return b.Anchors[i-nAddr].Lat
	}
	getX := func(i int) int32 {
		if i < nAddr {
			return b.Addrs[i].Lon
		}
		return b.Anchors[i-nAddr].Lon
	}

	perm := BuildKDPermutation(n, getX, getY, KDNodeSize)
	grid := BuildCellGrid(b.Anchors)

	man.KDNodeSize = KDNodeSize
	man.NumCells = len(grid.Keys)
	return writeAll(dir, map[string]any{
		"kd_perm":    perm,
		"cell_key":   grid.Keys,
		"cell_start": grid.Starts,
		"cell_count": grid.Counts,
		"cell_items": grid.Items,
	}, man)
}

func (b *Builder) writeAddrs(dir string, man *Manifest) error {
	n := len(b.Addrs)
	num := make([]uint32, n)
	lat := make([]int32, n)
	lon := make([]int32, n)
	key := make([]uint32, n)
	for i, a := range b.Addrs {
		num[i], lat[i], lon[i], key[i] = a.NumID, a.Lat, a.Lon, a.SortKey
	}
	// No addr_anchor: addresses are stored grouped by anchor, so the owning
	// anchor is a binary search over anchor_addr_start. 4 bytes per address is
	// 244MB across fourteen countries, for ~23 comparisons on the reverse path.
	w := map[string]any{
		"addr_num": num, "addr_lat": lat, "addr_lon": lon,
		"addr_sortkey": key,
	}
	return writeAll(dir, w, man)
}

// The inverted index over anchor tokens. Terms are sorted so a prefix range is
// two binary searches rather than a scan; posting lists hold ascending anchor
// ids, so multi-token queries are a linear intersection.
func (b *Builder) writeIndex(dir string, man *Manifest) error {
	postings := map[string][]uint32{}
	for id, a := range b.Anchors {
		seen := map[string]bool{}
		for _, t := range a.Tokens {
			if t == "" || seen[t] {
				continue
			}
			seen[t] = true
			postings[t] = append(postings[t], uint32(id))
		}
	}

	terms := make([]string, 0, len(postings))
	for t := range postings {
		terms = append(terms, t)
	}
	sort.Strings(terms)

	tt := NewStringTable()
	tt.list = tt.list[:0] // the term table has no empty-string sentinel
	tt.ids = map[string]uint32{}
	for _, t := range terms {
		tt.Intern(t)
	}

	offs := make([]uint32, len(terms)+1)
	var flat []uint32
	for i, t := range terms {
		offs[i] = uint32(len(flat))
		p := postings[t]
		sort.Slice(p, func(a, c int) bool { return p[a] < p[c] })
		flat = append(flat, p...)
	}
	offs[len(terms)] = uint32(len(flat))

	n, err := tt.Write(dir, "terms")
	if err != nil {
		return err
	}
	man.Bytes["terms"] = n

	// The same dictionary over reversed terms, which is what lets the server
	// find a typo in the *first* half of a token: a single edit lies wholly in
	// one half of the query, so either its prefix or its suffix survives intact,
	// and a suffix search is a prefix search on reversed strings.
	revOrder := make([]uint32, len(terms))
	for i := range revOrder {
		revOrder[i] = uint32(i)
	}
	reversed := make([]string, len(terms))
	for i, t := range terms {
		reversed[i] = reverseRunes(t)
	}
	sort.Slice(revOrder, func(a, c int) bool {
		return reversed[revOrder[a]] < reversed[revOrder[c]]
	})
	rt := NewStringTable()
	rt.list = rt.list[:0]
	rt.ids = map[string]uint32{}
	for _, o := range revOrder {
		rt.Intern(reversed[o])
	}
	nr, err := rt.Write(dir, "terms_rev")
	if err != nil {
		return err
	}
	man.Bytes["terms_rev"] = nr

	man.NumTerms = len(terms)
	man.NumPosting = len(flat)
	return writeAll(dir, map[string]any{
		"post_off": offs, "post": flat, "term_rev_id": revOrder,
	}, man)
}

// By rune, not byte: folding leaves Greek in place, and reversing its bytes
// would produce a string the server could never match.
func reverseRunes(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

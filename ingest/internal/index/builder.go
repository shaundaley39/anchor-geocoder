package index

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Interns strings, assigning each a stable id.
type StringTable struct {
	ids  map[string]uint32
	list []string
}

func NewStringTable() *StringTable {
	t := &StringTable{ids: map[string]uint32{}}
	t.Intern("") // id 0 is always the empty string, so 0 reads as "absent"
	return t
}

func (t *StringTable) Intern(s string) uint32 {
	if id, ok := t.ids[s]; ok {
		return id
	}
	id := uint32(len(t.list))
	t.ids[s] = id
	t.list = append(t.list, s)
	return id
}

func (t *StringTable) Len() int { return len(t.list) }

// Emits the blob and its offset table.
func (t *StringTable) Write(dir, base string) (int, error) {
	var blob []byte
	offs := make([]uint32, len(t.list)+1)
	for i, s := range t.list {
		offs[i] = uint32(len(blob))
		blob = append(blob, s...)
	}
	offs[len(t.list)] = uint32(len(blob))

	if err := os.WriteFile(filepath.Join(dir, base+".bin"), blob, 0o644); err != nil {
		return 0, err
	}
	if err := writeU32(dir, base+".idx", offs); err != nil {
		return 0, err
	}
	return len(blob) + 4*len(offs), nil
}

// A searchable street, place or POI: what text queries match against.
type Anchor struct {
	Key      string // country|folded name|folded locality — dedup key only
	NameID   uint32
	LocalID  uint32 // locality (city) string id
	Lat, Lon int32
	Layer    uint8
	Country  uint8
	Score    float32 // importance prior, pre-multiplied at build time
	CatID    uint32  // POI category string id; 0 for non-POI anchors
	// AltID is a string id whose value is the anchor's alternate names joined
	// by AltSep. Stored rather than discarded after tokenizing because ranking
	// has to know that "Prague" is a *name* of Praha, not incidental context.
	AltID     uint32
	Tokens    []string
	AddrStart uint32
	AddrCount uint32
	// Real distinguishes an anchor built from an actual street or place record
	// from a placeholder synthesised because an address referenced a name that
	// was never mapped in its own right.
	Real bool

	// BBox in fixed point. Degenerate to the representative point when the
	// feature has no extent, so every anchor can live in one spatial index.
	MinLat, MinLon, MaxLat, MaxLon int32
	// Shape is the simplified outline as fixed-point lat/lon pairs, empty when
	// the feature is small enough that its representative point suffices.
	Shape []int32
	// Closed marks a ring, which can contain a click, as against a street's
	// sampled points, which can only be measured to.
	Closed bool
	// NameTokens is the token count of the *shortest* name this anchor is known
	// by. The server bounds relevance with it: a query of q tokens can use at
	// most min(q, n)/n of an n-token name, and only an equal-length name can be
	// an exact match. Shortest, because relevance takes the best variant.
	NameTokens uint8
}

// One address point, in a run belonging to a single anchor.
type Address struct {
	AnchorID uint32
	NumID    uint32 // house number string id
	Lat, Lon int32
	// Leading integer of the house number. Runs sort by it, so a numeric lookup
	// is a binary search and results come back in street order.
	SortKey uint32
}

// The first run of digits: Czech numbers are "conscription/orientation" and
// Polish ones carry letter suffixes, so it is the only comparable part.
func LeadingInt(s string) uint32 {
	start := -1
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			start = i
			break
		}
	}
	if start < 0 {
		return 0
	}
	end := start
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	// Capped, so an absurd OSM value cannot wrap and sort first.
	n, err := strconv.ParseUint(s[start:end], 10, 32)
	if err != nil {
		return 0
	}
	if n > 1<<31 {
		return 1 << 31
	}
	return uint32(n)
}

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
	man.NumTerms = len(terms)
	man.NumPosting = len(flat)
	return writeAll(dir, map[string]any{"post_off": offs, "post": flat}, man)
}

func writeAll(dir string, files map[string]any, man *Manifest) error {
	names := make([]string, 0, len(files))
	for k := range files {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		var err error
		var n int
		switch v := files[name].(type) {
		case []uint32:
			n, err = 4*len(v), writeU32(dir, name+".bin", v)
		case []int32:
			n, err = 4*len(v), writeI32(dir, name+".bin", v)
		case []float32:
			n, err = 4*len(v), writeF32(dir, name+".bin", v)
		case []byte:
			n, err = len(v), os.WriteFile(filepath.Join(dir, name+".bin"), v, 0o644)
		}
		if err != nil {
			return err
		}
		man.Bytes[name] = n
	}
	return nil
}

func writeU32(dir, name string, v []uint32) error {
	buf := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[4*i:], x)
	}
	return os.WriteFile(filepath.Join(dir, name), buf, 0o644)
}
func writeI32(dir, name string, v []int32) error {
	buf := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[4*i:], uint32(x))
	}
	return os.WriteFile(filepath.Join(dir, name), buf, 0o644)
}
func writeF32(dir, name string, v []float32) error {
	buf := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[4*i:], math.Float32bits(x))
	}
	return os.WriteFile(filepath.Join(dir, name), buf, 0o644)
}

// The dedup key joining addresses to their anchor, computed identically for
// street records, place records and addresses.
//
// Layer is part of it: without that a street named after the village it runs
// through collides with the village, and one silently overwrites the other.
func AnchorKey(country string, layer uint8, foldedName, foldedLocality []string) string {
	l := "s"
	if layer == LayerPlace {
		l = "p"
	}
	return country + "|" + l + "|" + strings.Join(foldedName, " ") +
		"|" + strings.Join(foldedLocality, " ")
}

// geoingest already collapsed node-and-way duplicates, so this only keeps
// genuinely distinct POIs apart — hence the OSM id.
func POIKey(id string) string { return "poi|" + id }

// Dedup key for a settlement. A place's locality is its own name, so AnchorKey
// alone merges every same-named village — and "Nowa Wies" names hundreds. A
// ~28km cell keeps them apart while still collapsing node-and-area pairs.
//
// Addresses bind by nearest matching name instead, so a village near a cell
// boundary still gathers its own.
func PlaceKey(country string, foldedName []string, lat, lon float64) string {
	const cellDeg = 0.25
	return country + "|p|" + strings.Join(foldedName, " ") + "|" +
		strconv.Itoa(int(math.Floor(lat/cellDeg))) + "," +
		strconv.Itoa(int(math.Floor(lon/cellDeg)))
}

// Joins alternate names inside one interned string; U+001F cannot occur in an
// OSM name.
const AltSep = "\x1f"

// The interned string for an id.
func (t *StringTable) Get(id uint32) string {
	if int(id) >= len(t.list) {
		return ""
	}
	return t.list[id]
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

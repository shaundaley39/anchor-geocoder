package index

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// StringTable interns strings and assigns each a stable id.
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

// Write emits the blob and its offset table.
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

// Anchor is a searchable street or place: the unit text queries match against.
type Anchor struct {
	Key       string // country|folded name|folded locality — dedup key only
	NameID    uint32
	LocalID   uint32 // locality (city) string id
	Lat, Lon  int32
	Layer     uint8
	Country   uint8
	Score     float32 // importance prior, pre-multiplied at build time
	CatID     uint32  // POI category string id; 0 for non-POI anchors
	Tokens    []string
	AddrStart uint32
	AddrCount uint32
	// Real distinguishes an anchor built from an actual street or place record
	// from a placeholder synthesised because an address referenced a name that
	// was never mapped in its own right.
	Real bool
}

// Address is one address point, stored in a run belonging to a single anchor.
type Address struct {
	AnchorID uint32
	NumID    uint32 // house number string id
	Lat, Lon int32
	// SortKey is the leading integer of the house number ("248/39" -> 248,
	// "12A" -> 12, "ev.38" -> 38). Address runs are sorted by it so a numeric
	// lookup is a binary search, and so results come back in street order
	// rather than in whatever order OSM happened to store them.
	SortKey uint32
}

// LeadingInt extracts the first run of digits in a house number. Czech numbers
// are written "conscription/orientation" and Polish ones often carry a letter
// suffix, so the leading integer is the only reliably comparable part.
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
	// Cap at a value that still fits comfortably in uint32; absurd numbers in
	// OSM data should not wrap around and sort first.
	n, err := strconv.ParseUint(s[start:end], 10, 32)
	if err != nil {
		return 0
	}
	if n > 1<<31 {
		return 1 << 31
	}
	return uint32(n)
}

// Builder assembles the artifact.
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

// AnchorID returns the id for an anchor key, creating a placeholder if the key
// has not been seen. Placeholders exist because 141,524 anchors are referenced
// only by address points and have no street or place record of their own —
// a street name that appears in addr:street but was never mapped as a highway.
func (b *Builder) AnchorID(key string) (uint32, bool) {
	if id, ok := b.byKey[key]; ok {
		return id, false
	}
	id := uint32(len(b.Anchors))
	b.byKey[key] = id
	b.Anchors = append(b.Anchors, Anchor{Key: key})
	return id, true
}

// Finish sorts address runs, links them to anchors, builds the inverted index
// and writes every file.
func (b *Builder) Finish(dir string, man *Manifest) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	// Group addresses by anchor, then by house number. Sorting by SortKey then
	// by the raw string keeps "12", "12A", "12B" adjacent and in order.
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

	for i := range b.Anchors {
		b.Anchors[i].AddrStart = 0
		b.Anchors[i].AddrCount = 0
	}
	for i := 0; i < len(b.Addrs); {
		j := i
		aid := b.Addrs[i].AnchorID
		for j < len(b.Addrs) && b.Addrs[j].AnchorID == aid {
			j++
		}
		b.Anchors[aid].AddrStart = uint32(i)
		b.Anchors[aid].AddrCount = uint32(j - i)
		i = j
	}

	// An anchor with no coordinates of its own (a placeholder) borrows the
	// centroid of its address run, so it is still a usable standalone result.
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

	if err := b.writeAnchors(dir, man); err != nil {
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
	defer mf.Close()
	e := json.NewEncoder(mf)
	e.SetIndent("", "  ")
	return e.Encode(man)
}

func (b *Builder) writeAnchors(dir string, man *Manifest) error {
	n := len(b.Anchors)
	name := make([]uint32, n)
	local := make([]uint32, n)
	lat := make([]int32, n)
	lon := make([]int32, n)
	flags := make([]byte, n)
	score := make([]float32, n)
	cat := make([]uint32, n)
	start := make([]uint32, n)
	count := make([]uint32, n)

	for i, a := range b.Anchors {
		name[i], local[i] = a.NameID, a.LocalID
		lat[i], lon[i] = a.Lat, a.Lon
		flags[i] = a.Layer | a.Country<<4
		score[i] = a.Score
		cat[i] = a.CatID
		start[i], count[i] = a.AddrStart, a.AddrCount
	}
	w := map[string]any{
		"anchor_name": name, "anchor_local": local,
		"anchor_lat": lat, "anchor_lon": lon,
		"anchor_flags": flags, "anchor_score": score, "anchor_cat": cat,
		"anchor_addr_start": start, "anchor_addr_count": count,
	}
	return writeAll(dir, w, man)
}

func (b *Builder) writeAddrs(dir string, man *Manifest) error {
	n := len(b.Addrs)
	num := make([]uint32, n)
	lat := make([]int32, n)
	lon := make([]int32, n)
	anc := make([]uint32, n)
	key := make([]uint32, n)
	for i, a := range b.Addrs {
		num[i], lat[i], lon[i], anc[i], key[i] = a.NumID, a.Lat, a.Lon, a.AnchorID, a.SortKey
	}
	w := map[string]any{
		"addr_num": num, "addr_lat": lat, "addr_lon": lon,
		"addr_anchor": anc, "addr_sortkey": key,
	}
	return writeAll(dir, w, man)
}

// writeIndex builds the inverted index over anchor tokens.
//
// Terms are stored as a sorted string table so the server can binary-search a
// prefix range: the last token of an autocomplete query matches every term in
// [prefix, prefix+0xFF), which is a pair of binary searches rather than a scan.
// Posting lists hold ascending anchor ids, which makes multi-token queries a
// linear intersection.
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

// AnchorKey is the dedup key joining address points to their anchor. It must be
// computed identically for street records, place records and addresses.
//
// The layer is part of the key. Without it a street named after the village it
// runs through ("Adamov" in Adamov) collides with the village itself, and one
// silently overwrites the other.
func AnchorKey(country string, layer uint8, foldedName, foldedLocality []string) string {
	l := "s"
	if layer == LayerPlace {
		l = "p"
	}
	return country + "|" + l + "|" + strings.Join(foldedName, " ") +
		"|" + strings.Join(foldedLocality, " ")
}

// POIKey is the dedup key for a point of interest. geoingest has already
// collapsed node-and-way duplicates of one POI, so this only needs to keep
// genuinely distinct POIs apart — hence the OSM id rather than a name.
func POIKey(id string) string { return "poi|" + id }

// PlaceKey is the dedup key for a settlement. A place record's locality is its
// own name, so AnchorKey alone merges every same-named village in a country —
// and "Nowa Wies" names several hundred distinct Polish villages. Quantising
// the position to a ~28km cell keeps them apart while still collapsing the
// node-and-area mappings of a single settlement.
//
// Addresses do not use this key: they bind to the nearest place of a matching
// name, so a village sitting near a cell boundary still gathers its own
// addresses.
func PlaceKey(country string, foldedName []string, lat, lon float64) string {
	const cellDeg = 0.25
	return country + "|p|" + strings.Join(foldedName, " ") + "|" +
		strconv.Itoa(int(math.Floor(lat/cellDeg))) + "," +
		strconv.Itoa(int(math.Floor(lon/cellDeg)))
}

// Get returns the interned string for an id.
func (t *StringTable) Get(id uint32) string {
	if int(id) >= len(t.list) {
		return ""
	}
	return t.list[id]
}

// NewSynthetic appends an anchor that has no corresponding OSM street or place
// record, for a name referenced only by address points.
func (b *Builder) NewSynthetic(name, locality string, country, layer uint8,
	st *StringTable, tokens []string) uint32 {
	id := uint32(len(b.Anchors))
	b.Anchors = append(b.Anchors, Anchor{
		NameID:  st.Intern(name),
		LocalID: st.Intern(locality),
		Country: country,
		Layer:   layer,
		Score:   1,
		Tokens:  tokens,
	})
	return id
}

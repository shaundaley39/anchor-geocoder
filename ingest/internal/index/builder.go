package index

import (
	"encoding/json"
	"fmt"
	"hash/maphash"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/buildmem"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
)

// Builder assembles the artifact.
type Builder struct {
	Strings *StringTable
	// Terms interns search tokens in the order they are met, so an anchor can
	// hold ids rather than strings. Re-sorted into the dictionary's own order at
	// write time, which is the first moment the full set is known.
	Terms     *StringTable
	Anchors   []Anchor
	Addrs     []Address
	byKey     map[anchorKey]uint32
	Counts    map[string]int
	Countries map[string]int
}

func NewBuilder() *Builder {
	return &Builder{
		Strings:   NewStringTable(),
		Terms:     NewStringTable(),
		byKey:     map[anchorKey]uint32{},
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

// The dedup key, hashed rather than kept.
//
// The key is "country|folded name|folded locality", built to be compared and
// then never read: keeping 23.3M of them cost ~1.6GB in strings the build has
// no other use for. Two independent 64-bit hashes instead, so a collision — two
// distinct anchors silently merged — needs a 128-bit coincidence: about 5e-24
// at sixty million keys, against a one-in-65,000 chance at 64 bits, which is
// too likely a thing to be wrong about quietly.
//
// Ids come from insertion order, not from the hash, so builds stay reproducible
// even though the seeds do not.
type anchorKey struct{ a, b uint64 }

var (
	keySeedA = maphash.MakeSeed()
	keySeedB = maphash.MakeSeed()
)

func hashKey(key string) anchorKey {
	return anchorKey{maphash.String(keySeedA, key), maphash.String(keySeedB, key)}
}

// AnchorID returns the id for an anchor key, creating a placeholder if unseen:
// 141,524 anchors are referenced only by addresses, never mapped in their own
// right.
func (b *Builder) AnchorID(key string) (uint32, bool) {
	h := hashKey(key)
	if id, ok := b.byKey[h]; ok {
		return id, false
	}
	id := uint32(len(b.Anchors))
	b.byKey[h] = id
	b.Anchors = append(b.Anchors, Anchor{})
	return id, true
}

// InternTokens turns a token list into ids, dropping the empties and the
// repeats — a posting list holds an anchor once however often it says the word.
func (b *Builder) InternTokens(toks []string) []uint32 {
	if len(toks) == 0 {
		return nil
	}
	out := make([]uint32, 0, len(toks))
	for _, t := range toks {
		if t == "" {
			continue
		}
		id := b.Terms.Intern(t)
		dup := false
		for _, prev := range out {
			if prev == id {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, id)
		}
	}
	return out
}

// NewSynthetic makes an anchor for a name referenced only by address points.
func (b *Builder) NewSynthetic(name, locality string, country, layer uint8,
	st *StringTable, tokens []uint32, lat, lon int32) uint32 {
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

// Finish sorts address runs, links them to anchors, builds the inverted index,
// writes.
func (b *Builder) Finish(dir string, man *Manifest) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	buildmem.Log("entering Finish")

	// The dedup map has done its work: nothing past this point looks an anchor up
	// by name, and it holds 23.3M keys built by concatenating a country, a folded
	// name and a folded locality. Dropped, and collected now rather than whenever
	// the next allocation happens to trigger it, because everything below is
	// about to want the room.
	b.byKey = nil
	runtime.GC()
	buildmem.Log("dedup map freed")

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

	// A proper CSR offset array: an anchor with no addresses takes the offset of
	// the next run, not zero. The server recovers an address's anchor by binary-
	// searching this (244MB saved), which needs it non-decreasing — zeroes would
	// break it for every POI, and POIs are most anchors.
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

	buildmem.Log("before writeAnchors")
	if err := b.writeAnchors(dir, man); err != nil {
		return err
	}
	buildmem.Log("before writeSpatial")
	if err := b.writeSpatial(dir, man); err != nil {
		return err
	}
	buildmem.Log("before writeAddrs")
	if err := b.writeAddrs(dir, man); err != nil {
		return err
	}
	buildmem.Log("before writeIndex")
	if err := b.writeIndex(dir, man); err != nil {
		return err
	}
	buildmem.Log("after writeIndex")

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
	// Checked, not deferred: a failed Close on a writer means unflushed data, and
	// reporting a truncated manifest as a successful build is worse than failing
	// loudly.
	return mf.Close()
}

func (b *Builder) writeAnchors(dir string, man *Manifest) error {
	n := len(b.Anchors)
	A := b.Anchors

	// One column at a time, straight to disk. Built as slices this was nineteen
	// arrays of 23.3M entries live at once — 1.5GB, to write them one after
	// another anyway.
	cols := []struct {
		name string
		fill func(c *col, i int)
	}{
		{"anchor_name", func(c *col, i int) { c.u32(A[i].NameID) }},
		{"anchor_local", func(c *col, i int) { c.u32(A[i].LocalID) }},
		{"anchor_lat", func(c *col, i int) { c.i32(A[i].Lat) }},
		{"anchor_lon", func(c *col, i int) { c.i32(A[i].Lon) }},
		{"anchor_flags", func(c *col, i int) { c.u8(A[i].Layer) }},
		{"anchor_country", func(c *col, i int) { c.u8(A[i].Country) }},
		{"anchor_score", func(c *col, i int) { c.f32(A[i].Score) }},
		{"anchor_cat", func(c *col, i int) { c.u32(A[i].CatID) }},
		{"anchor_alt", func(c *col, i int) { c.u32(A[i].AltID) }},
		{"anchor_ntok", func(c *col, i int) { c.u8(A[i].NameTokens) }},
		{"anchor_minlat", func(c *col, i int) { c.i32(A[i].MinLat) }},
		{"anchor_minlon", func(c *col, i int) { c.i32(A[i].MinLon) }},
		{"anchor_maxlat", func(c *col, i int) { c.i32(A[i].MaxLat) }},
		{"anchor_maxlon", func(c *col, i int) { c.i32(A[i].MaxLon) }},
		{"anchor_addr_start", func(c *col, i int) { c.u32(A[i].AddrStart) }},
		{"anchor_addr_count", func(c *col, i int) { c.u32(A[i].AddrCount) }},
		{"geom_closed", func(c *col, i int) {
			if A[i].Closed {
				c.u8(1)
			} else {
				c.u8(0)
			}
		}},
	}
	for _, cl := range cols {
		if err := writeCol(dir, cl.name, man, n, cl.fill); err != nil {
			return err
		}
	}

	// Vertex offsets and the vertices themselves, in two passes over the same
	// shapes rather than one flat 212MB slice.
	man.NumShapes = 0
	var vertices int
	if err := writeCol(dir, "geom_off", man, n+1, func(c *col, i int) {
		c.u32(uint32(vertices))
		if i < n {
			if len(A[i].Shape) > 0 {
				man.NumShapes++
			}
			vertices += len(A[i].Shape) / 2
		}
	}); err != nil {
		return err
	}
	gc, err := newCol(dir, "geom")
	if err != nil {
		return err
	}
	for i := range A {
		for _, v := range A[i].Shape {
			gc.i32(v)
		}
	}
	written, err := gc.close()
	if err != nil {
		return fmt.Errorf("geom: %w", err)
	}
	man.Bytes["geom"] = written
	man.NumVertices = vertices
	return nil
}

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
	D := b.Addrs

	// No addr_anchor: addresses are stored grouped by anchor, so the owning anchor
	// is a binary search over anchor_addr_start. 4 bytes per address is 244MB
	// across fourteen countries, for ~23 comparisons on the reverse path.
	//
	// Streamed for the same reason the anchor columns are: four arrays of 90M
	// entries is 1.4GB held to write it sequentially.
	cols := []struct {
		name string
		fill func(c *col, i int)
	}{
		{"addr_num", func(c *col, i int) { c.u32(D[i].NumID) }},
		{"addr_lat", func(c *col, i int) { c.i32(D[i].Lat) }},
		{"addr_lon", func(c *col, i int) { c.i32(D[i].Lon) }},
		{"addr_sortkey", func(c *col, i int) { c.u32(D[i].SortKey) }},
	}
	for _, cl := range cols {
		if err := writeCol(dir, cl.name, man, n, cl.fill); err != nil {
			return err
		}
	}
	return nil
}

// The inverted index over anchor tokens. Terms are sorted so a prefix range is
// two binary searches rather than a scan; posting lists hold ascending anchor
// ids, so multi-token queries are a linear intersection.
func (b *Builder) writeIndex(dir string, man *Manifest) error {
	// Postings by interned id, so this is an indexed slice rather than a map of
	// 4.8M string keys. Anchors are visited in ascending id, so each list comes
	// out sorted without a sort.
	postings := make([][]uint32, b.Terms.Len())
	for id := range b.Anchors {
		for _, t := range b.Anchors[id].Tokens {
			postings[t] = append(postings[t], uint32(id))
		}
	}

	// The dictionary's own order, which is not the order tokens were met in.
	order := make([]uint32, 0, len(postings))
	for t := 1; t < len(postings); t++ { // id 0 is the empty-string sentinel
		if len(postings[t]) > 0 {
			order = append(order, uint32(t))
		}
	}
	sort.Slice(order, func(i, j int) bool {
		return lessUTF16(b.Terms.Get(order[i]), b.Terms.Get(order[j]))
	})

	terms := make([]string, len(order))
	tt := NewStringTable()
	tt.list = tt.list[:0] // the term table has no empty-string sentinel
	tt.ids = map[string]uint32{}
	for i, o := range order {
		terms[i] = b.Terms.Get(o)
		tt.Intern(terms[i])
	}

	// Posting lists straight to disk, and each one released as it goes. Held as
	// one flat slice this was 414MB on top of the map it was copied out of, and
	// the map's 4.8M slices stayed live behind it for no reason.
	//
	// Anchors are visited in ascending id above, so each list is already sorted.
	offs := make([]uint32, len(terms)+1)
	pc, err := newCol(dir, "post")
	if err != nil {
		return err
	}
	var total uint32
	for i, o := range order {
		offs[i] = total
		for _, id := range postings[o] {
			pc.u32(id)
		}
		total += uint32(len(postings[o]))
		postings[o] = nil // released as it goes, not held to the end
	}
	offs[len(terms)] = total
	written, err := pc.close()
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	man.Bytes["post"] = written

	n, err := tt.Write(dir, "terms")
	if err != nil {
		return err
	}
	man.Bytes["terms"] = n

	// The same dictionary over reversed terms, so the server can catch a typo in
	// the first half of a token. A single edit lies wholly in one half of the
	// query, so either its prefix or its suffix survives intact, and a suffix
	// search is a prefix search on reversed strings.
	revOrder := make([]uint32, len(terms))
	for i := range revOrder {
		revOrder[i] = uint32(i)
	}
	reversed := make([]string, len(terms))
	for i, t := range terms {
		reversed[i] = reverseRunes(t)
	}
	sort.Slice(revOrder, func(a, c int) bool {
		return lessUTF16(reversed[revOrder[a]], reversed[revOrder[c]])
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
	man.NumPosting = int(total)

	if err := writeAll(dir, map[string]any{
		"post_off": offs, "term_rev_id": revOrder,
	}, man); err != nil {
		return err
	}
	return b.writeAnchorTerms(dir, man, tt)
}

// Each anchor's own name and locality as term ids, so the server can score
// without folding a string.
//
// Folding an anchor's names is the most expensive thing the ranking does, and
// it does it per candidate: it was cached per request thread, which cost both
// the work on a cold cache and ~140MB a thread to keep. The fold is the same
// every time and the dictionary already holds the answer, so it belongs here —
// ~500MB in the artifact, shared by every thread, against caches that were not.
//
// Written after the dictionary is sorted, because that is when a token has an
// id at all, and streamed rather than accumulated: 123M ids is 500MB of slice
// before the append slack that doubles it.
func (b *Builder) writeAnchorTerms(dir string, man *Manifest, tt *StringTable) error {
	offs := make([]uint32, len(b.Anchors)+1)
	c, err := newCol(dir, "anchor_terms")
	if err != nil {
		return err
	}
	var at uint32

	// Localities repeat across thousands of anchors and re-folding them is the
	// bulk of the work here; names mostly do not, and memoizing 13.9M of them
	// would cost more than it saves.
	locCache := map[uint32][]uint32{}
	ids := func(s string) []uint32 {
		toks := norm.Tokens(s)
		if len(toks) == 0 {
			return nil
		}
		v := make([]uint32, 0, len(toks))
		for _, t := range toks {
			if id, ok := tt.ids[t]; ok {
				v = append(v, id)
			} else {
				// Should not happen: an anchor's name tokens are a subset of the
				// tokens it was indexed under. Counted rather than assumed away.
				b.Counts["anchor_term_not_in_dictionary"]++
				v = append(v, TermMissing)
			}
		}
		return v
	}
	put := func(v []uint32) {
		for _, id := range v {
			c.u32(id)
		}
		at += uint32(len(v))
	}

	for id := range b.Anchors {
		a := &b.Anchors[id]
		offs[id] = at

		loc, ok := locCache[a.LocalID]
		if !ok {
			loc = ids(b.Strings.Get(a.LocalID))
			locCache[a.LocalID] = loc
		}
		put(loc)

		// The canonical name is emitted even when it folds to nothing, so that
		// variant 0 is always the canonical one.
		c.u32(TermSep)
		at++
		put(ids(b.Strings.Get(a.NameID)))
		if a.AltID != 0 {
			for _, alt := range strings.Split(b.Strings.Get(a.AltID), AltSep) {
				v := ids(alt)
				if len(v) == 0 {
					continue // an alternate that folds away is not a name variant
				}
				c.u32(TermSep)
				at++
				put(v)
			}
		}
	}
	offs[len(b.Anchors)] = at

	written, err := c.close()
	if err != nil {
		return fmt.Errorf("anchor_terms: %w", err)
	}
	man.Bytes["anchor_terms"] = written
	man.NumAnchorTerms = int(at)
	return writeAll(dir, map[string]any{"anchor_terms_off": offs}, man)
}

// sortUTF16 orders the dictionary the way the server compares it.
//
// Go sorts strings by UTF-8 byte, which is code point order. JavaScript's `<`
// compares UTF-16 code units, and the two disagree above the BMP: a surrogate
// pair starts 0xD800, which sorts below every character from U+E000 up, while
// its code point sorts above them. The server binary-searches this dictionary
// with `<`, so a dictionary in Go's order is one the server can walk off — and
// not only for the astral terms themselves. Any lookup whose path crosses the
// disagreement can take the wrong branch, which is how 28 ordinary Japanese and
// Brahmi names came back unfound.
//
// Sorted here rather than compared differently there, because the comparison is
// the server's inner loop and the sort happens once.
func sortUTF16(terms []string) {
	sort.Slice(terms, func(i, j int) bool { return lessUTF16(terms[i], terms[j]) })
}

// lessUTF16 reports whether a sorts before b by UTF-16 code unit, without
// encoding either: runes below U+10000 are their own code unit, and above it
// the high surrogate decides unless both share one.
func lessUTF16(a, b string) bool {
	for len(a) > 0 && len(b) > 0 {
		ra, sa := utf8.DecodeRuneInString(a)
		rb, sb := utf8.DecodeRuneInString(b)
		if ra != rb {
			ua, ub := highUnit(ra), highUnit(rb)
			if ua != ub {
				return ua < ub
			}
			return ra < rb // same high surrogate, so code point order decides
		}
		a, b = a[sa:], b[sb:]
	}
	return len(a) < len(b)
}

func highUnit(r rune) rune {
	if r > 0xFFFF {
		return 0xD800 + ((r - 0x10000) >> 10)
	}
	return r
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

// Package index defines the on-disk artifact: the contract between the Go build
// and the TypeScript server.
//
// A directory of flat little-endian arrays plus a JSON manifest, each file
// mapping one-to-one onto a JavaScript typed array — so the server loads it
// with a read and a view rather than parsing anything.
//
// Text search runs over anchors, not addresses: 11.6M address points resolve to
// 430k distinct (street-or-place, locality) anchors, a 21x smaller index, and a
// house number is a binary search within the matched anchor's run. That is also
// what keeps the artifact small — a rendered display string per address would
// cost ~370MB against 3.7MB for the dictionary.
//
// # Files
//
//	manifest.json    counts, version, provenance
//	strings.bin      concatenated UTF-8, no separators
//	strings.idx      uint32[n+1] byte offsets into strings.bin
//	anchor_*.bin     struct-of-arrays, one file per field, n_anchors entries
//	                 anchor_alt holds a string id whose value is the feature's
//	                 alternate names joined by U+001F
//	                 anchor_{min,max}{lat,lon} give the bounding box, degenerate
//	                 to the representative point for features with no extent
//	geom.bin         int32 lat/lon pairs, fixed point, all shapes concatenated
//	geom_off.bin     uint32[n_anchors+1] vertex offsets into geom.bin
//	geom_closed.bin  uint8 per anchor: 1 = ring that can contain a point,
//	                 0 = open point set (a street), only distances apply
//	terms_rev.bin    the term dictionary again, each term reversed and the whole
//	                 re-sorted, so a suffix search is a prefix search
//	term_rev_id.bin  uint32 reversed-dictionary position -> term id
//	anchor_ntok.bin  uint8 shortest name-variant token count, which lets the
//	                 server bound relevance without folding the name
//	anchor_terms.bin uint32 term ids of an anchor's own name and locality, so
//	                 scoring compares integers instead of folding strings at
//	                 query time. Per anchor: the locality's tokens, then each
//	                 name variant's, canonical first, sections separated by
//	                 TermSep. A token absent from the dictionary is TermMissing,
//	                 which occupies its place in the name — and so still counts
//	                 against how much of the name a query used — but matches
//	                 nothing. Rare enough to be a curiosity — 135 across Europe
//	                 — and harmless, since a token the dictionary lacks could
//	                 never have been matched by a query term either
//	anchor_terms_off.bin  uint32[n_anchors+1] offsets into anchor_terms.bin
//	kd_perm.bin      uint32 point ids in k-d tree order: ids below n_addresses
//	                 index the address arrays, at or above them the anchors
//	cell_*.bin       containment grid, sorted cell keys with a CSR of anchor ids
//	addr_*.bin       struct-of-arrays, n_addresses entries, grouped by anchor.
//	                 There is deliberately no addr_anchor: an address's owning
//	                 anchor is recovered by binary-searching anchor_addr_start,
//	                 which costs ~23 comparisons and saves 4 bytes per address —
//	                 244MB across fourteen countries.
//	terms.bin/.idx   sorted distinct search terms (same string-table encoding)
//	post_off.bin     uint32[n_terms+1] offsets into post.bin
//	post.bin         uint32 anchor ids, ascending within each term
package index

// Version is bumped whenever the layout changes; the server refuses an artifact
// it does not recognise rather than misreading it.
const Version = 9

// Sentinels in anchor_terms.bin. Both are above any possible term id, since a
// dictionary of 2^32-2 terms would need more anchors than there are streets.
const (
	// TermSep ends a section: the locality, then each name variant.
	TermSep uint32 = 0xFFFFFFFF
	// TermMissing stands for a token the dictionary does not hold. Counted in
	// anchor_term_not_in_dictionary rather than assumed away, because it is the
	// one way this file can disagree with the name it was folded from.
	TermMissing uint32 = 0xFFFFFFFE
)

// Layer codes, packed into the low nibble of anchor_flags.
const (
	LayerStreet uint8 = 0
	LayerPlace  uint8 = 1
	LayerPOI    uint8 = 2
)

// CoordScale is the fixed-point factor for coordinates: ~1.1cm resolution, and
// an int32 rather than a float64 halves the largest arrays.
const CoordScale = 1e7

// Manifest describes an artifact. It is written as manifest.json.
type Manifest struct {
	Version    int      `json:"version"`
	BuiltAt    string   `json:"built_at"`
	Countries  []string `json:"countries"`
	NumStrings int      `json:"num_strings"`
	NumAnchors int      `json:"num_anchors"`
	NumAddrs   int      `json:"num_addresses"`
	NumTerms   int      `json:"num_terms"`
	NumPOIs    int      `json:"num_pois"`
	NumShapes  int      `json:"num_shapes"`
	// Written because the k-d traversal is implicit: the reader must partition
	// exactly as the writer did, and a mismatch returns subtly wrong neighbours
	// rather than an error.
	KDNodeSize  int `json:"kd_node_size"`
	NumCells    int `json:"num_cells"`
	NumVertices int `json:"num_vertices"`
	NumPosting  int `json:"num_postings"`
	// NumAnchorTerms is the length of anchor_terms.bin in entries, separators
	// included, so the server can check the file against the manifest.
	NumAnchorTerms int            `json:"num_anchor_terms"`
	CountryIDs     map[string]int `json:"country_ids"`
	Counts         map[string]int `json:"counts"`
	Bytes          map[string]int `json:"bytes"`
	Duration       string         `json:"duration"`
}

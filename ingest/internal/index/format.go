// Package index defines the on-disk index artifact: the contract between the Go
// build stage and the TypeScript server.
//
// # Shape
//
// The artifact is a directory of flat little-endian arrays plus a JSON
// manifest. Each file maps one-to-one onto a JavaScript typed array, so the
// server loads it with a read and a view — no parsing, no per-record objects,
// and a boot cost that scales with disk speed rather than record count.
//
// # Why anchors
//
// Measured over the built corpus: 11,637,055 address points resolve to just
// 430,551 distinct (street-or-place, locality) anchors. Text search therefore
// runs over ~572k anchor documents rather than 12M address documents — a 21x
// reduction — and a house number is resolved afterwards by binary search within
// the matched anchor's contiguous run of addresses.
//
// That is also what keeps the artifact small. Storing a rendered display string
// per address would cost ~370MB; dictionary-encoding the 156,578 distinct names
// and 262,313 distinct house numbers costs 3.7MB.
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
//	addr_*.bin       struct-of-arrays, n_addresses entries, grouped by anchor.
//	                 There is deliberately no addr_anchor: an address's owning
//	                 anchor is recovered by binary-searching anchor_addr_start,
//	                 which costs ~23 comparisons and saves 4 bytes per address —
//	                 244MB across fourteen countries.
//	terms.bin/.idx   sorted distinct search terms (same string-table encoding)
//	post_off.bin     uint32[n_terms+1] offsets into post.bin
//	post.bin         uint32 anchor ids, ascending within each term
package index

// Version is bumped whenever the binary layout changes. The server refuses to
// load an artifact it does not recognise rather than misreading it.
const Version = 5

// Layer codes, packed into the low nibble of anchor_flags.
const (
	LayerStreet uint8 = 0
	LayerPlace  uint8 = 1
	LayerPOI    uint8 = 2
)

// CoordScale is the fixed-point factor for latitude and longitude. 1e7 gives
// ~1.1cm resolution and keeps coordinates in an int32 instead of a float64,
// halving the largest arrays in the artifact.
const CoordScale = 1e7

// Manifest describes an artifact. It is written as manifest.json.
type Manifest struct {
	Version     int            `json:"version"`
	BuiltAt     string         `json:"built_at"`
	Countries   []string       `json:"countries"`
	NumStrings  int            `json:"num_strings"`
	NumAnchors  int            `json:"num_anchors"`
	NumAddrs    int            `json:"num_addresses"`
	NumTerms    int            `json:"num_terms"`
	NumPOIs     int            `json:"num_pois"`
	NumShapes   int            `json:"num_shapes"`
	NumVertices int            `json:"num_vertices"`
	NumPosting  int            `json:"num_postings"`
	CountryIDs  map[string]int `json:"country_ids"`
	Counts      map[string]int `json:"counts"`
	Bytes       map[string]int `json:"bytes"`
	Duration    string         `json:"duration"`
}

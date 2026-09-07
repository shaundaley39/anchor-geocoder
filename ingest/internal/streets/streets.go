// Package streets turns the many way segments OSM splits a street into back
// into one searchable street, and works out which settlement each belongs to.
//
// It lives here rather than in the command because it is the most consequential
// guess the pipeline makes: OSM tags localities on addresses but not on roads,
// so the settlement has to be inferred spatially, and getting it wrong
// collapses every same-named street in a country into one result.
package streets

import (
	"math"
	"sort"
	"strings"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
)

// Segment is one way of a named street, buffered until the places layer can say
// which settlement it is in.
type Segment struct {
	Rec      *model.Record
	Lat, Lon float64
	Country  string
}

// Aggregate accumulates the many way segments of one named street into a single
// record.
//
// A street is split at every junction and attribute change, so one result per
// segment would bury everything else. Segments group by (name, locality) and
// reduce to the sampled midpoint nearest their mean — the mean itself can fall
// off an L-shaped street, a midpoint cannot.
type Aggregate struct {
	Rec     *model.Record
	sumLat  float64
	sumLon  float64
	n       int
	samples [][2]float64
}

// Segments reports how many way segments merged into this street.
func (s *Aggregate) Segments() int { return s.n }

const maxSamples = 16

func (s *Aggregate) Add(lat, lon float64) {
	s.sumLat += lat
	s.sumLon += lon
	s.n++
	if len(s.samples) < maxSamples {
		s.samples = append(s.samples, [2]float64{lat, lon})
	}
}

func (s *Aggregate) Finalize() {
	if s.n == 0 {
		return
	}
	mLat, mLon := s.sumLat/float64(s.n), s.sumLon/float64(s.n)
	best, bestD := s.samples[0], math.MaxFloat64
	for _, p := range s.samples {
		// Planar distance is ample for choosing between points on one street.
		dy := p[0] - mLat
		dx := (p[1] - mLon) * math.Cos(mLat*math.Pi/180)
		if d := dy*dy + dx*dx; d < bestD {
			best, bestD = p, d
		}
	}
	s.Rec.Lat, s.Rec.Lon = best[0], best[1]

	// A street is linear, so one point misdescribes it. Keep the sampled midpoints
	// as an open shape; an unordered set suffices, since only the minimum distance
	// to any of them is needed.
	if len(s.samples) > 1 {
		pts := make([]geom.Point, len(s.samples))
		for i, p := range s.samples {
			pts[i] = geom.Point{Lat: p[0], Lon: p[1]}
		}
		if geom.Bounds(pts).DiagonalMetres() >= minShapeMetres {
			s.Rec.Shape = make([]float64, 0, 2*len(pts))
			for _, p := range pts {
				s.Rec.Shape = append(s.Rec.Shape, p.Lat, p.Lon)
			}
			s.Rec.Closed = false
		}
	}
}

// Below this a street's single point is within clicking tolerance. Most
// residential streets fall under it.
const minShapeMetres = 150

// catchmentKm is how far a settlement of each class is allowed to "claim" a
// street, and is the mechanism that stops a street on the edge of Prague being
// assigned to whichever village sits just outside the city limit.
//
// Candidates are scored distance / catchment, so a city wins out to ~15km while
// a hamlet only wins within ~1.2km — the intuition being that a large
// settlement's streets genuinely are far from its centroid, and a hamlet's are
// not.
var catchmentKm = map[string]float64{
	"city": 15, "borough": 10, "municipality": 8, "town": 6,
	"village": 2.5, "suburb": 2.5, "quarter": 1.5,
	"neighbourhood": 1.2, "hamlet": 1.2, "isolated_dwelling": 0.4,
}

// Bounds the lookup: anything beyond the largest catchment is fetched only to
// be discarded. Scanning 30km examined four times the area for no change.
const searchRadiusKm = 15

// Group assigns each buffered segment to a settlement, then merges segments
// sharing a (country, name, locality) key.
//
// OSM tags localities on addresses but not roads — four of 241,815 named Czech
// street ways carry addr:city — so grouping on the tag alone collapsed every
// "Nadrazni" in the country into one result.
func Group(segs []Segment, cat *Catchment, counts map[string]int) map[string]*Aggregate {
	out := map[string]*Aggregate{}
	var unassigned int

	for i := range segs {
		seg := &segs[i]
		locality := seg.Rec.City // honour an explicit tag when there is one
		if locality == "" {
			if best := cat.Nearest(seg.Country, seg.Lat, seg.Lon); best != nil {
				locality = best.Name
			}
		}
		if locality == "" {
			unassigned++
		}

		seg.Rec.City = locality
		if locality != "" {
			seg.Rec.Display = seg.Rec.Name + ", " + locality
		} else {
			seg.Rec.Display = seg.Rec.Name
		}

		k := seg.Country + "|" + strings.Join(norm.Tokens(seg.Rec.Street), " ") +
			"|" + strings.Join(norm.Tokens(locality), " ")
		agg, ok := out[k]
		if !ok {
			seg.Rec.Tokens = rebuildTokens(seg.Rec)
			agg = &Aggregate{Rec: seg.Rec}
			out[k] = agg
		}
		agg.Add(seg.Lat, seg.Lon)
	}

	// Accumulated, not assigned: Group runs once per country now, so an
	// assignment leaves the last country's figure — Malta's zero standing in for
	// Europe's.
	counts["street_unassigned_locality"] += unassigned
	return out
}

// Refreshes tokens after a locality is attached; the record was tokenized
// before it had one.
func rebuildTokens(r *model.Record) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range []string{r.Name, r.Street, r.City, r.Place} {
		for _, tok := range norm.Tokens(s) {
			if tok != "" && !seen[tok] {
				seen[tok] = true
				out = append(out, tok)
			}
		}
	}
	for _, v := range r.AltNames {
		for _, tok := range norm.Tokens(v) {
			if tok != "" && !seen[tok] {
				seen[tok] = true
				out = append(out, tok)
			}
		}
	}
	return out
}

// ResolveOrphanAddresses attaches a locality to addresses carrying neither
// addr:city nor addr:place. 3.6% of Czechia. Without it they render as a bare
// "Prazska 248/39", with no way to tell which of 300-odd Prazska streets is
// meant.
// ResolveOrphanAddresses attaches a locality to addresses carrying neither
// addr:city nor addr:place. 3.6% of Czechia, 25.2M across Europe. Without it
// they render as a bare "Prazska 248/39", with no way to tell which of 300-odd
// Prazska streets is meant.
func ResolveOrphanAddresses(orphans []Segment, cat *Catchment, counts map[string]int) {
	resolved := 0
	for i := range orphans {
		o := &orphans[i]
		best := cat.Nearest(o.Country, o.Lat, o.Lon)
		if best == nil {
			continue
		}
		o.Rec.City = best.Name
		o.Rec.Display = model.BuildAddressDisplay(o.Rec)
		o.Rec.Tokens = model.SearchTokens(o.Rec)
		resolved++
	}
	counts["address_locality_resolved"] += resolved
	counts["address_locality_unresolved"] += len(orphans) - resolved
}

// ResolvePOILocalities does the same for points of interest, which had been
// left out entirely.
//
// A POI got a locality only from its own addr:city, which 41.3% carry. The
// other 58.7% had none, so the locality prior could not break ties between
// same-named features and sometimes inverted them: "Sagrada Familia" returned a
// railway halt in Ortuella, which had a locality, above Barcelona's station,
// which did not.
func ResolvePOILocalities(pois map[string]*model.Record, cat *Catchment, counts map[string]int) {
	resolved := 0
	for _, k := range SortedKeysRec(pois) {
		r := pois[k]
		if r.City != "" {
			continue
		}
		best := cat.Nearest(r.Country, r.Lat, r.Lon)
		if best == nil || strings.EqualFold(best.Name, r.Name) {
			continue
		}
		r.City = best.Name
		r.Display = r.Display + ", " + best.Name
		r.Tokens = model.SearchTokens(r)
		resolved++
	}
	counts["poi_locality_resolved"] += resolved
}

func SortedKeys(m map[string]*Aggregate) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}

func SortedKeysRec(m map[string]*model.Record) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}

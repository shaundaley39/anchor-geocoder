// Package streets turns the many way segments OSM splits a street into back
// into one searchable street, and works out which settlement each belongs to.
//
// It lives here rather than in the command because it is the most consequential
// guess the pipeline makes: OSM tags localities on addresses but not on roads,
// so the settlement has to be inferred spatially, and getting it wrong collapses
// every same-named street in a country into one result.
package streets

import (
	"log"
	"math"
	"sort"
	"strings"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/geom"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/spatial"
)

// One way of a named street, buffered until the places layer can say which
// settlement it is in.
type Segment struct {
	Rec      *model.Record
	Lat, Lon float64
	Country  string
}

// Accumulates the many way segments of one named street into a single record.
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

	// A street is linear, so one point misdescribes it. Keep the sampled
	// midpoints as an open shape; an unordered set suffices, since only the
	// minimum distance to any of them is needed.
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
// settlement's streets genuinely are far from its centroid, and a hamlet's
// are not.
var catchmentKm = map[string]float64{
	"city": 15, "borough": 10, "municipality": 8, "town": 6,
	"village": 2.5, "suburb": 2.5, "quarter": 1.5,
	"neighbourhood": 1.2, "hamlet": 1.2, "isolated_dwelling": 0.4,
}

// Bounds the lookup: anything beyond the largest catchment is fetched only to
// be discarded. Scanning 30km examined four times the area for no change.
const searchRadiusKm = 15

// Assigns each buffered segment to a settlement, then merges segments sharing a
// (country, name, locality) key.
//
// OSM tags localities on addresses but not roads — four of 241,815 named Czech
// street ways carry addr:city — so grouping on the tag alone collapsed every
// "Nadrazni" in the country into one result.
func Group(segs []Segment, places map[string]*model.Record, counts map[string]int) map[string]*Aggregate {
	// Sub-city divisions are indexed too, but their small catchments mean they
	// only win when a street is right on top of them.
	grids := map[string]*spatial.Grid{}
	names := map[string][]*model.Record{}
	for _, k := range SortedKeysRec(places) {
		p := places[k]
		if catchmentKm[p.PlaceType] == 0 {
			continue
		}
		g, ok := grids[p.Country]
		if !ok {
			g = spatial.NewGrid(0.05)
			grids[p.Country] = g
		}
		g.Add(p.Lat, p.Lon)
		names[p.Country] = append(names[p.Country], p)
	}
	for c, g := range grids {
		log.Printf("[%s] settlement index: %d places", c, g.Len())
	}

	out := map[string]*Aggregate{}
	var unassigned int
	var buf []spatial.Neighbour

	for i := range segs {
		seg := &segs[i]
		locality := seg.Rec.City // honour an explicit tag when there is one

		if locality == "" {
			if g := grids[seg.Country]; g != nil {
				best, bestScore := (*model.Record)(nil), 0.0
				buf = g.Within(seg.Lat, seg.Lon, searchRadiusKm, buf[:0])
				for _, n := range buf {
					cand := names[seg.Country][n.ID]
					// Lower is better; skip anything outside its catchment.
					score := n.DistKm / catchmentKm[cand.PlaceType]
					if score > 1 {
						continue
					}
					if best == nil || score < bestScore {
						best, bestScore = cand, score
					}
				}
				if best != nil {
					locality = best.Name
				}
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

	counts["street_unassigned_locality"] = unassigned
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

// Attaches a locality to addresses carrying neither addr:city nor addr:place —
// 3.6% of Czechia. Without it they render as a bare "Prazska 248/39", with no
// way to tell which of 300-odd Prazska streets is meant.
func ResolveOrphanAddresses(orphans []Segment, places map[string]*model.Record, counts map[string]int) {
	if len(orphans) == 0 {
		return
	}
	grids := map[string]*spatial.Grid{}
	names := map[string][]*model.Record{}
	for _, k := range SortedKeysRec(places) {
		p := places[k]
		if catchmentKm[p.PlaceType] == 0 {
			continue
		}
		g, ok := grids[p.Country]
		if !ok {
			g = spatial.NewGrid(0.05)
			grids[p.Country] = g
		}
		g.Add(p.Lat, p.Lon)
		names[p.Country] = append(names[p.Country], p)
	}

	resolved := 0
	var buf []spatial.Neighbour
	for i := range orphans {
		o := &orphans[i]
		g := grids[o.Country]
		if g == nil {
			continue
		}
		var best *model.Record
		bestScore := 0.0
		buf = g.Within(o.Lat, o.Lon, searchRadiusKm, buf[:0])
		for _, n := range buf {
			cand := names[o.Country][n.ID]
			score := n.DistKm / catchmentKm[cand.PlaceType]
			if score > 1 {
				continue
			}
			if best == nil || score < bestScore {
				best, bestScore = cand, score
			}
		}
		if best == nil {
			continue
		}
		o.Rec.City = best.Name
		o.Rec.Display = model.BuildAddressDisplay(o.Rec)
		o.Rec.Tokens = model.SearchTokens(o.Rec)
		resolved++
	}
	counts["address_locality_resolved"] = resolved
	counts["address_locality_unresolved"] = len(orphans) - resolved
	log.Printf("resolved locality for %d/%d orphan addresses", resolved, len(orphans))
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

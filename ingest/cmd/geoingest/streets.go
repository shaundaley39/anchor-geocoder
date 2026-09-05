package main

import (
	"log"
	"strings"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/norm"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/spatial"
)

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

// searchRadiusKm bounds the candidate lookup. A candidate is rejected outright
// once distance exceeds its catchment, and the largest catchment is a city's
// 15km, so anything fetched beyond that is fetched only to be thrown away.
// Scanning 30km examined roughly four times the area for no change in result.
const searchRadiusKm = 15

// groupStreets assigns each buffered street segment to a settlement and merges
// segments sharing a (country, name, locality) key into one record.
//
// This step exists because OSM tags localities on addresses but not on roads:
// of 241,815 named Czech street ways, four carry addr:city. Grouping on the tag
// alone collapsed every "Nadrazni" in the country into a single result.
func groupStreets(segs []streetSeg, places map[string]*model.Record, counts map[string]int) map[string]*streetAgg {
	// Build a per-country grid of settlements. Sub-city divisions (quarter,
	// neighbourhood) are indexed too but their small catchments mean they only
	// win when a street is right on top of them.
	grids := map[string]*spatial.Grid{}
	names := map[string][]*model.Record{}
	for _, k := range sortedKeysRec(places) {
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

	out := map[string]*streetAgg{}
	var unassigned int
	// One reusable buffer across millions of lookups.
	var buf []spatial.Neighbour

	for i := range segs {
		seg := &segs[i]
		locality := seg.rec.City // honour an explicit tag when there is one

		if locality == "" {
			if g := grids[seg.country]; g != nil {
				best, bestScore := (*model.Record)(nil), 0.0
				buf = g.Within(seg.lat, seg.lon, searchRadiusKm, buf[:0])
				for _, n := range buf {
					cand := names[seg.country][n.ID]
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

		seg.rec.City = locality
		if locality != "" {
			seg.rec.Display = seg.rec.Name + ", " + locality
		} else {
			seg.rec.Display = seg.rec.Name
		}

		k := seg.country + "|" + strings.Join(norm.Tokens(seg.rec.Street), " ") +
			"|" + strings.Join(norm.Tokens(locality), " ")
		agg, ok := out[k]
		if !ok {
			seg.rec.Tokens = rebuildTokens(seg.rec)
			agg = &streetAgg{rec: seg.rec}
			out[k] = agg
		}
		agg.add(seg.lat, seg.lon)
	}

	counts["street_unassigned_locality"] = unassigned
	return out
}

// rebuildTokens refreshes the search tokens after a locality has been attached,
// since the record was tokenized before it had one.
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

// resolveOrphanAddresses attaches a locality to address points that carry
// neither addr:city nor addr:place — 3.6% of Czechia, where a street name and a
// house number are all that was mapped. Without this they render as a bare
// "Prazska 248/39" with no way to tell which of the country's 300-odd Prazska
// streets is meant, and they cannot be found by a query naming the town.
func resolveOrphanAddresses(orphans []streetSeg, places map[string]*model.Record, counts map[string]int) {
	if len(orphans) == 0 {
		return
	}
	grids := map[string]*spatial.Grid{}
	names := map[string][]*model.Record{}
	for _, k := range sortedKeysRec(places) {
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
		g := grids[o.country]
		if g == nil {
			continue
		}
		var best *model.Record
		bestScore := 0.0
		buf = g.Within(o.lat, o.lon, searchRadiusKm, buf[:0])
		for _, n := range buf {
			cand := names[o.country][n.ID]
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
		o.rec.City = best.Name
		o.rec.Display = model.BuildAddressDisplay(o.rec)
		o.rec.Tokens = model.SearchTokens(o.rec)
		resolved++
	}
	counts["address_locality_resolved"] = resolved
	counts["address_locality_unresolved"] = len(orphans) - resolved
	log.Printf("resolved locality for %d/%d orphan addresses", resolved, len(orphans))
}

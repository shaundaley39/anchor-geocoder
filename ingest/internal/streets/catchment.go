package streets

import (
	"math"
	"sort"

	"github.com/shaundaley39/anchor-geocoder/ingest/internal/model"
	"github.com/shaundaley39/anchor-geocoder/ingest/internal/spatial"
)

// Catchment answers "which settlement is this point in", spatially.
//
// OSM tags a locality on addresses but not on roads, and only sometimes on
// POIs, so for most features it has to be inferred. Candidates are scored
// distance/catchment, which is what stops a street on the edge of Prague being
// claimed by whichever village sits just past the city limit.
//
// Built once and shared by the three callers that need it. It used to be built
// separately inside each, which is why POIs never got one: the third caller was
// simply missing.
type Catchment struct {
	// One grid per (country, catchment radius), not one per country.
	//
	// A hamlet only ever claims a point within 1.2km, but a city reaches 15km,
	// so a single grid has to be searched to 15km for every lookup — a 9x9 block
	// of cells, roughly 2,400 distance checks against France's 556,582 places.
	// Split by class, each grid is searched only as far as its own catchment
	// reaches: the dense classes over a few km², the sparse ones over hundreds.
	// About 35x fewer checks, and France's grouping went from 13 minutes to
	// under one.
	grids map[string]map[float64]*spatial.Grid
	names map[string]map[float64][]*model.Record
	radii []float64 // sorted, so iteration order is fixed
	buf   []spatial.Neighbour
}

func NewCatchment(places map[string]*model.Record) *Catchment {
	c := &Catchment{
		grids: map[string]map[float64]*spatial.Grid{},
		names: map[string]map[float64][]*model.Record{},
	}
	seen := map[float64]bool{}
	for _, k := range SortedKeysRec(places) {
		p := places[k]
		km := catchmentKm[p.PlaceType]
		if km == 0 {
			continue
		}
		if c.grids[p.Country] == nil {
			c.grids[p.Country] = map[float64]*spatial.Grid{}
			c.names[p.Country] = map[float64][]*model.Record{}
		}
		g, ok := c.grids[p.Country][km]
		if !ok {
			// Cell size tracks the catchment: a 5.5km cell is wasteful when the
			// search radius is 1.2km, since one cell then dwarfs the query.
			g = spatial.NewGrid(math.Max(km/111.32, 0.005))
			c.grids[p.Country][km] = g
		}
		g.Add(p.Lat, p.Lon)
		c.names[p.Country][km] = append(c.names[p.Country][km], p)
		seen[km] = true
	}
	for km := range seen {
		c.radii = append(c.radii, km)
	}
	sort.Float64s(c.radii)
	return c
}

// Nearest returns the settlement whose catchment best covers the point, or nil
// when the point is outside every one of them.
func (c *Catchment) Nearest(country string, lat, lon float64) *model.Record {
	byRadius := c.grids[country]
	if byRadius == nil {
		return nil
	}
	var best *model.Record
	bestScore := 0.0
	// Largest catchment first, so an exact tie between a city and a hamlet goes
	// to the city, and the result does not depend on map iteration order.
	for i := len(c.radii) - 1; i >= 0; i-- {
		km := c.radii[i]
		g := byRadius[km]
		if g == nil {
			continue
		}
		// Only as far as this class can reach: beyond its own catchment a place
		// scores above 1 and could never win.
		c.buf = g.Within(lat, lon, km, c.buf[:0])
		for _, n := range c.buf {
			score := n.DistKm / km
			if score > 1 {
				continue
			}
			if best == nil || score < bestScore {
				best, bestScore = c.names[country][km][n.ID], score
			}
		}
	}
	return best
}

// Len reports how many places are indexed for a country, across all classes.
func (c *Catchment) Len(country string) int {
	n := 0
	for _, g := range c.grids[country] {
		n += g.Len()
	}
	return n
}

// Countries the catchment holds places for, for logging.
func (c *Catchment) Countries() []string {
	out := make([]string, 0, len(c.grids))
	for k := range c.grids {
		out = append(out, k)
	}
	return out
}

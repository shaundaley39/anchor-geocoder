package streets

import (
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
	grids map[string]*spatial.Grid
	names map[string][]*model.Record
	buf   []spatial.Neighbour
}

func NewCatchment(places map[string]*model.Record) *Catchment {
	c := &Catchment{grids: map[string]*spatial.Grid{}, names: map[string][]*model.Record{}}
	for _, k := range SortedKeysRec(places) {
		p := places[k]
		if catchmentKm[p.PlaceType] == 0 {
			continue
		}
		g, ok := c.grids[p.Country]
		if !ok {
			g = spatial.NewGrid(0.05)
			c.grids[p.Country] = g
		}
		g.Add(p.Lat, p.Lon)
		c.names[p.Country] = append(c.names[p.Country], p)
	}
	return c
}

// Nearest returns the settlement whose catchment best covers the point, or nil
// when the point is outside every one of them.
func (c *Catchment) Nearest(country string, lat, lon float64) *model.Record {
	g := c.grids[country]
	if g == nil {
		return nil
	}
	var best *model.Record
	bestScore := 0.0
	c.buf = g.Within(lat, lon, searchRadiusKm, c.buf[:0])
	for _, n := range c.buf {
		cand := c.names[country][n.ID]
		// Lower is better; anything outside its catchment does not count.
		score := n.DistKm / catchmentKm[cand.PlaceType]
		if score > 1 {
			continue
		}
		if best == nil || score < bestScore {
			best, bestScore = cand, score
		}
	}
	return best
}

func (c *Catchment) Len(country string) int {
	if g := c.grids[country]; g != nil {
		return g.Len()
	}
	return 0
}

// Countries the catchment holds places for, for logging.
func (c *Catchment) Countries() []string {
	out := make([]string, 0, len(c.grids))
	for k := range c.grids {
		out = append(out, k)
	}
	return out
}

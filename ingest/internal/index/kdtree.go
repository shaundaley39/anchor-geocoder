package index

import "sort"

// Precomputed spatial structures.
//
// The server used to build both of these at boot: ~3.0s for the k-d tree
// permutation and ~2.4s for the containment grid on the four-country index,
// scaling to something near a minute at planet size. That is expensive work
// happening in the request path's process, which contradicts the whole premise
// of the build/serve split — and it is paid again by every replica, on every
// deploy and every rollback.
//
// Both are pure functions of data the artifact already holds, so both belong
// here. Boot becomes a read and a cast.

// KDNodeSize is the leaf threshold of the k-d tree. It is written to the
// manifest because the traversal is implicit: the reader must partition the
// permutation exactly as the writer did, and a silent mismatch would return
// subtly wrong neighbours rather than an error.
const KDNodeSize = 64

// BuildKDPermutation returns point ids ordered as an implicit k-d tree:
// recursive median splits on alternating axes, stopping at leaves of nodeSize.
//
// The reader only relies on the *invariant* — at each node everything to the
// left is <= the split on that axis and everything to the right is >= — not on
// a particular tie-break, so a permutation built here and one built by the
// server are both valid even where they differ.
func BuildKDPermutation(n int, getX, getY func(int) int32, nodeSize int) []uint32 {
	ids := make([]uint32, n)
	for i := range ids {
		ids[i] = uint32(i)
	}
	if n == 0 {
		return ids
	}
	// Contiguous scratch, as the partitioning below is the one place that reads
	// coordinates in bulk; it is freed on return.
	xs := make([]int32, n)
	ys := make([]int32, n)
	for i := 0; i < n; i++ {
		xs[i] = getX(i)
		ys[i] = getY(i)
	}
	k := &kdSorter{ids: ids, xs: xs, ys: ys, nodeSize: nodeSize}
	k.sort(0, n-1, 0)
	return ids
}

type kdSorter struct {
	ids      []uint32
	xs, ys   []int32
	nodeSize int
}

func (k *kdSorter) sort(left, right, axis int) {
	if right-left <= k.nodeSize {
		return
	}
	mid := (left + right) >> 1
	k.selectNth(mid, left, right, axis)
	k.sort(left, mid-1, 1-axis)
	k.sort(mid+1, right, 1-axis)
}

func (k *kdSorter) val(i, axis int) int32 {
	if axis == 0 {
		return k.xs[i]
	}
	return k.ys[i]
}

func (k *kdSorter) swap(i, j int) {
	k.xs[i], k.xs[j] = k.xs[j], k.xs[i]
	k.ys[i], k.ys[j] = k.ys[j], k.ys[i]
	k.ids[i], k.ids[j] = k.ids[j], k.ids[i]
}

// selectNth is a Hoare partition loop placing the n-th element at n, with
// everything smaller before it. Sorting outright would be O(n log n) per level
// when only the median position matters.
func (k *kdSorter) selectNth(n, left, right, axis int) {
	for right > left {
		t := k.val(n, axis)
		i, j := left, right

		k.swap(left, n)
		if k.val(right, axis) > t {
			k.swap(left, right)
		}
		for i < j {
			k.swap(i, j)
			i++
			j--
			for k.val(i, axis) < t {
				i++
			}
			for k.val(j, axis) > t {
				j--
			}
		}
		if k.val(left, axis) == t {
			k.swap(left, j)
		} else {
			j++
			k.swap(j, right)
		}

		if j <= n {
			left = j + 1
		}
		if n <= j {
			right = j - 1
		}
	}
}

// Containment grid parameters. These are part of the format: the server looks
// up a cell by computing the same key, so a change here needs a version bump.
const (
	// CellDeg is ~5.5km. A feature is listed in every cell its bounding box
	// touches, so smaller cells multiply large features across many entries
	// while larger ones return too many candidates per lookup.
	CellDeg = 0.05
	// MinExtentM is the size below which a feature is found by the k-d tree
	// anyway and need not be in the containment grid.
	MinExtentM = 30
	// cellOrigin keeps cell coordinates non-negative so the key packs cleanly.
	cellOrigin = 4096
	cellStride = 16384
)

// CellKey packs a cell coordinate pair into one integer. The server computes it
// identically.
func CellKey(lat, lon float64) int32 {
	x := int32(floorDiv(lon, CellDeg)) + cellOrigin
	y := int32(floorDiv(lat, CellDeg)) + cellOrigin
	return y*cellStride + x
}

func floorDiv(v, by float64) float64 {
	q := v / by
	if q < 0 && q != float64(int64(q)) {
		return float64(int64(q) - 1)
	}
	return float64(int64(q))
}

// CellGrid is the containment index in flat form: unique cell keys in ascending
// order, each with a slice of the anchor ids whose bounding box covers it.
type CellGrid struct {
	Keys   []int32
	Starts []uint32
	Counts []uint32
	Items  []uint32
}

// BuildCellGrid indexes every anchor with a closed outline and real extent.
func BuildCellGrid(anchors []Anchor) CellGrid {
	type entry struct {
		key int32
		id  uint32
	}
	var entries []entry

	for id := range anchors {
		a := &anchors[id]
		if len(a.Shape) == 0 || !a.Closed {
			continue
		}
		lo := float64(a.MinLat) / CoordScale
		hi := float64(a.MaxLat) / CoordScale
		lw := float64(a.MinLon) / CoordScale
		hw := float64(a.MaxLon) / CoordScale
		if (hi-lo)*111_320 < MinExtentM && (hw-lw)*111_320 < MinExtentM {
			continue
		}
		for y := int32(floorDiv(lo, CellDeg)); y <= int32(floorDiv(hi, CellDeg)); y++ {
			for x := int32(floorDiv(lw, CellDeg)); x <= int32(floorDiv(hw, CellDeg)); x++ {
				entries = append(entries, entry{
					key: (y+cellOrigin)*cellStride + (x + cellOrigin),
					id:  uint32(id),
				})
			}
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].key != entries[j].key {
			return entries[i].key < entries[j].key
		}
		return entries[i].id < entries[j].id
	})

	g := CellGrid{Items: make([]uint32, len(entries))}
	for i, e := range entries {
		g.Items[i] = e.id
		if i == 0 || e.key != entries[i-1].key {
			g.Keys = append(g.Keys, e.key)
			g.Starts = append(g.Starts, uint32(i))
			g.Counts = append(g.Counts, 0)
		}
		g.Counts[len(g.Counts)-1]++
	}
	return g
}

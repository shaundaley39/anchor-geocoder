package index

import "sort"

// Precomputed spatial structures.
//
// The server built both at boot — ~5.4s on the four-country index, near a
// minute at planet size — repeated by every replica on every deploy. Both are
// pure functions of data the artifact already holds, so both belong here.

// Leaf threshold, written to the manifest because the traversal is implicit:
// a mismatch returns subtly wrong neighbours rather than an error.
const KDNodeSize = 64

// BuildKDPermutation returns point ids as an implicit k-d tree: median splits
// on alternating axes, leaves of nodeSize.
//
// The reader relies only on the invariant at each node, not on a particular
// tie-break, so this permutation and one built by the server can differ and
// both be valid.
func BuildKDPermutation(n int, getX, getY func(int) int32, nodeSize int) []uint32 {
	ids := make([]uint32, n)
	for i := range ids {
		ids[i] = uint32(i)
	}
	if n == 0 {
		return ids
	}
	// Contiguous scratch: the partitioning is the one bulk read. Freed on return.
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

// Hoare partition placing the n-th element at n. Only the median position
// matters, so sorting would be wasteful.
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

// Containment grid parameters. Part of the format — the server recomputes the
// same key — so a change needs a version bump.
const (
	// ~5.5km. A feature is listed in every cell its box touches, so smaller
	// cells multiply large features while larger ones return too many
	// candidates per lookup.
	CellDeg = 0.05
	// Below this a feature is found by the k-d tree anyway.
	MinExtentM = 30
	// CellOrigin keeps cell coordinates non-negative so the key packs cleanly.
	CellOrigin = 4096
	CellStride = 16384
)

// Packs a cell coordinate pair into one integer; the server computes it
// identically.
func CellKey(lat, lon float64) int32 {
	x := int32(floorDiv(lon, CellDeg)) + CellOrigin
	y := int32(floorDiv(lat, CellDeg)) + CellOrigin
	return y*CellStride + x
}

func floorDiv(v, by float64) float64 {
	q := v / by
	if q < 0 && q != float64(int64(q)) {
		return float64(int64(q) - 1)
	}
	return float64(int64(q))
}

// The containment index in flat form: ascending cell keys, each with a slice of
// the anchor ids whose box covers it.
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
					key: (y+CellOrigin)*CellStride + (x + CellOrigin),
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

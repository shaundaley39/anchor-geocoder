# Reverse Geocoding

A point in, ranked places out. Where forward geocoding is a text problem with a
spatial tail, this is a spatial problem with no text in it at all: no folding,
no dictionary, no posting lists. It reads coordinates and outlines.

The shape of the answer follows from the observation that a click asks two
different questions at once. "What am I inside?" and "what is near me?" are not
the same question and cannot be answered by the same structure, so there are two
tiers and two indexes, and the result is the two concatenated in that order.


## 1. What reverse geocoding can return

Everything the index holds is reachable, which is not true of forward search.
Text search runs over anchors only; reverse search covers **both anchors and
addresses**, because the nearest thing to a click is very often a doorway with
no name of its own.

The two are put in one structure by giving them one id space
([`buildReverseIndex`](../server/src/reverse.ts#L139)): ids below
`num_addresses` index the address arrays, ids at or above it index the anchors.
Without the anchors a click could only ever return the nearest doorway, never a
park or a station.

Containment is narrower. A feature can contain a point only if it has a closed
outline, so the containment grid holds only anchors whose geometry is a ring
([`kdtree.go:149`](../ingest/internal/index/kdtree.go#L149)), and only those
whose bounding box is at least 30 m across
([`kdtree.go:117`](../ingest/internal/index/kdtree.go#L117)) - below that the
k-d tree finds them anyway and a grid entry would be waste. Streets are stored
as open point sets and are marked as such
([`geom_closed`](../ingest/internal/index/format.go)), so they can be measured
to but never contain anything.

That is why a click in the middle of a park returns the park, and a click in
the middle of a road returns the road only as a distance.


## 2. The structures it reads

Both spatial structures are precomputed by the build, so boot is a read rather
than a rebuild - building them in-process cost 5.4 s and 3.0 s of startup
respectively, on every replica on every deploy.

Both are built from the same three arrangements the text index uses - a
column, a blob with its bounds, and a *sorted* blob with its bounds - which
[the forward document describes in
full](forward-geocoding.md#the-three-shapes-everything-is-stored-in). Nothing
here is a linked structure either. Figures below are the four-country default
build, which `make all` produces with no arguments.

**The k-d tree** ships as `kd_perm`, a permutation of point ids in k-d order
with the tree's structure implicit in that order
([`BuildKDPermutation`](../ingest/internal/index/kdtree.go#L22), written by
[`writeSpatial`](../ingest/internal/index/builder.go#L328)).

Implicit is the whole trick, so it is worth spelling out. A k-d tree is
normally nodes with two child pointers. Here it is one `Uint32Array` of
15,957,985 point ids - every address and every anchor, 60.9 MiB - arranged so
that the median of any sub-range sits at its midpoint. The root is the element
at `(0 + n-1) / 2`, split on longitude; its children are the midpoints of the
two halves either side, split on latitude; and so on, alternating. A node is
therefore a triple of integers - `left`, `right`, `axis` - and descending is
arithmetic:

```
mid   = (left + right) >> 1        // this node's point
left  half = (left, mid - 1, 1 - axis)
right half = (mid + 1, right, 1 - axis)
```

[`range`](../server/src/pointindex.ts#L142) pushes those triples on an explicit
stack and pops until the range is at most `nodeSize` wide, at which point it
scans the remainder linearly. With `nodeSize` 64 and 16M points that is 18
splits to a leaf. Descent into a half happens only if the query box reaches
across the split, which is the pruning.

The server adopts the permutation and holds nothing else
([`PointIndex.fromPermutation`](../server/src/pointindex.ts#L26)): coordinates
are read back through accessors into `addr_lat`/`addr_lon` and
`anchor_lat`/`anchor_lon` rather than copied, which saves 490 MB on the
fourteen-country build and keeps comparisons on raw fixed-point integers, so
they are exact. `nodeSize` is written into the manifest
([`kdtree.go:14`](../ingest/internal/index/kdtree.go#L14)) because the traversal
is implicit and a reader that partitions differently gets subtly wrong
neighbours rather than an error.

**The containment grid** is a uniform 0.05° grid, about 5.5 km
([`kdtree.go:111`](../ingest/internal/index/kdtree.go#L111)). A feature is listed
in every cell its bounding box touches.

It is a sorted blob and its bounds, with one extra step. `cell_key` is the
sorted array of occupied cells, each packing the cell's x and y into one
integer ([`CellKey`](../ingest/internal/index/kdtree.go#L125)); `cell_start`
and `cell_count` are parallel to it and slice `cell_items`, the concatenated
anchor ids. Only occupied cells are stored, which is why the key has to be
searched for rather than indexed into: 19,254 cells hold 105,732 listings, 5.5
rings per cell, against the 259,200 cells a dense 0.05° grid of the globe
would need. A lookup is therefore a binary search over `cell_key`
([`findCell`](../server/src/reverse.ts#L63)) and then a slice, exactly like a
posting list. The whole grid is 0.7 MiB.

The cell size is the usual trade - smaller cells multiply large features
across more entries, larger ones return too many candidates per lookup.

The key packing is part of the format, since the server recomputes the same key
from a click ([`reverse.ts:57`](../server/src/reverse.ts#L57)) and the two must
agree; a contract test asserts the constants against the Go writer.

**Outlines** are the same arrangement once more: `geom` is every shape's int32
lat/lon pairs concatenated (14.9 MiB, 1,951,739 vertices over 273,861 shapes),
`geom_off` the per-anchor offsets that slice it, and `geom_closed` one byte per
anchor saying whether the slice is a ring or an open point set. An anchor with
no outline has `geom_off[id] == geom_off[id+1]`, so absence needs no flag and
no null.

**Coverage** is scanned once at boot
([`coverage`](../server/src/reverse.ts#L101)) and gives two things: the overall
bounding box the API advertises, and a bounding box per country. The per-country
boxes are built from anchor extents and every address behind them, so they can
never rule out a match the search would have found.


## 3. A query arriving

The route ([`routes.ts:79`](../server/src/routes.ts#L79)) takes `lat` and `lon`,
which are mutually exclusive with `q`, plus an optional `limit` (1 to 50),
`radius` in metres (1 to 50,000) and `country`. An unknown country code is a 400
before any search runs.

[`reverse`](../server/src/reverse.ts#L195) then clamps the radius to 50 km
([`:199`](../server/src/reverse.ts#L199)) and, if a country filter was given,
checks that country's bounding box against the search area before doing anything
else ([`:215`](../server/src/reverse.ts#L215)). That check is worth four
comparisons: a filter nothing nearby can satisfy is the expensive case, because
the radius escalates to its cap looking for a match and the last sweep measures
every point in a 100 km box before discarding it. `country=pt` clicked on Berlin
cost 110 ms against 0.04 ms unfiltered before the check existed.

If the search returns nothing, the route checks whether the coordinates look
transposed ([`looksTransposed`](../server/src/reverse.ts#L167)) - GeoJSON
`center` is `[lon, lat]` while the parameters are named lat and lon, so feeding
one into the other lands a Czech region off Somalia. The hint fires only when
the given point is outside coverage and the swapped one is inside, so a genuine
query is never second-guessed. On a world index it can never fire, because
nothing is outside coverage.


## 4. Tier one: what contains the point

Regions containing the click come first, because being inside something is a
stronger statement than being near it
([`reverse.ts:223`](../server/src/reverse.ts#L223)).

The click's cell key is computed and located by binary search over `cell_key`
([`findCell`](../server/src/reverse.ts#L63)). That gives a candidate list of
every ring whose bounding box touches that cell - typically a handful. Each
candidate is then filtered and refined:

1. `distanceToBBox` ([`geometry.ts:155`](../server/src/geometry.ts#L155)) rejects
   anything whose box does not contain the point. This is a cheap reject on four
   integers.
2. `containsPoint` ([`geometry.ts:30`](../server/src/geometry.ts#L30)) is ray
   casting on the stored integers, which is the expensive step and runs only on
   what survived the box.

Survivors are sorted by ring area, smallest first
([`ringAreaM2`](../server/src/geometry.ts#L130),
[`reverse.ts:243`](../server/src/reverse.ts#L243)), because the smaller of two
nested regions is the more specific answer: a click in a Prague park is inside
the park, the district and the city, and the park is what was clicked.

At most three containing regions take the head of the result
([`MAX_CONTAINING`](../server/src/reverse.ts#L181)). The rest are not discarded -
they join the second tier at distance zero
([`reverse.ts:249`](../server/src/reverse.ts#L249)), so a deeply nested click
still lists its city, just below the things it is nearer to.


## 5. Tier two: what is near the point

Everything else is ranked by distance
([`reverse.ts:246`](../server/src/reverse.ts#L246)).

The radius starts at 150 m and multiplies by four each round until the result is
full or the cap is reached ([`reverse.ts:252`](../server/src/reverse.ts#L252),
[`:285`](../server/src/reverse.ts#L285)). Escalating rather than starting wide is
what keeps a click in a city cheap: in dense areas the first round already has
enough, and the loop never runs again.

Each round is a range query over the k-d tree
([`PointIndex.range`](../server/src/pointindex.ts#L142),
[`reverse.ts:259`](../server/src/reverse.ts#L259)) over a box sized from the
radius, with longitude scaled by the cosine of the latitude
([`:251`](../server/src/reverse.ts#L251)) so the box stays roughly square in
metres. The traversal uses an explicit stack to keep the hot loop
allocation-free.

What the callback does depends on which half of the id space the point is in:

- **An address** is a bare point, so the distance is a haversine to it
  ([`haversineMetres`](../server/src/geometry.ts#L169)), and its owning anchor is
  recovered by binary search over `anchor_addr_start`
  ([`anchorOfAddress`](../server/src/artifact.ts#L437)).
- **An anchor with an outline** is measured to the outline
  ([`distanceToShape`](../server/src/geometry.ts#L78)), not to its centroid. A
  click at one end of a 2 km street is not 1 km from the street.
- **An anchor without an outline** is measured to its representative point.

Candidates further than the current radius are dropped, since the box is square
and the radius is a circle. An anchor already returned by tier one is skipped
([`reverse.ts:273`](../server/src/reverse.ts#L273)).

Each round restarts from scratch rather than accumulating, so the cost is
dominated by the last and widest box. That is the one remaining expensive shape:
`limit=50&radius=50000` from a point in open water near a dense coast really does
have to sweep a 100 km box, and costs about 16 ms of thread time. Clicking on
nothing, by contrast, is the cheapest thing the API does - an empty region is
where a k-d tree prunes hardest, and a mid-Atlantic point costs less than a
click on central Prague.


## 6. Putting the two tiers together

The two lists are concatenated, containing regions first and then everything
else by ascending distance
([`reverse.ts:288`](../server/src/reverse.ts#L288)), and truncated to the limit.

They are not scored on a common scale, because they are not comparable
quantities, and the ordering does not need them to be: the tiers are already in
the order they should appear. What each tier gets is a score that decreases
monotonically within it
([`toResult`](../server/src/reverse.ts#L298)) - `1000 / (1 + area / 1e4)` for a
containing region, so a smaller region scores higher, and `1 / (1 + distance)`
for everything else. The 1000 keeps the two ranges from interleaving in a client
that sorts on score.

Each result carries its `distance` in metres, which is zero for a containing
region, so a caller that wants to distinguish the tiers can.

The whole path is checked against brute force: a test picks random points,
computes the nearest address by scanning every address in the index, and asserts
the k-d tree agrees.


## 7. Two clicks, end to end

On the four-country default build, single-threaded:

**Central Brno (49.1951, 16.6068), 0.92 ms.** The cell key resolves by binary
search over 19,254 keys; the cell's handful of rings are rejected on their
bounding boxes or ray-cast; the first distance round at 150 m already fills
the result, so the escalation loop runs once. Five results, the nearest two
addresses 10 m away.

**The Baltic (55.9, 19.2), 0.07 ms - thirteen times faster.** This is the
shape people assume is the expensive one, and it is the cheapest thing the API
does. The cell key is absent from `cell_key`, so tier one ends at the binary
search. Then the radius escalates 150 m, 600 m, 2.4 km, 9.6 km, 38 km, 50 km
and every round returns nothing, because an empty region is exactly where a
k-d tree prunes hardest: the box fails the split test at the top of the tree
and whole subtrees are never entered. Six rounds of not descending cost less
than one round of descending.

The expensive shape is the opposite one - a wide radius over dense data, which
is why `limit=50&radius=50000` off a populated coast is the row that costs
about 16 ms of thread time in the README's table.

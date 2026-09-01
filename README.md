# Minimal Geocoding API — Czechia & Poland

A geocoding service over OpenStreetMap data for Czechia and Poland (Bosnia and
Herzegovina optional), built as two stages:

| Stage | Language | Status | What it does |
|---|---|---|---|
| **Ingest** | Go | ✅ working | Reads `.osm.pbf` extracts, resolves geometry, normalizes text, emits an immutable index artifact |
| **Serve** | TypeScript | 🚧 next | Loads the artifact at boot, serves one `/v1/geocode` endpoint for both forward and reverse queries |

## Quick start

```bash
make fetch     # ~3 GB of OSM extracts from Geofabrik, checksum-verified
make build     # ~5 min on an M-series laptop -> build/records.ndjson.gz
make test      # Go test suite
```

Requires Go 1.24+. No cgo, no C++ toolchain, no external dependencies —
`CGO_ENABLED=0` throughout, so the ingest binary is fully static.

## Current output

Built from the 2026-08-31 Geofabrik extracts in **4m51s**:

| | records |
|---|---|
| addresses | 11,637,055 |
| streets | 396,723 |
| places | 141,256 |
| **total** | **12,175,034** |

570 MB gzipped NDJSON plus a `manifest.json` recording provenance, counts and
timings. Full numbers in `build/manifest.json`.

---

## Architectural decisions

### Two stages, with the artifact as the contract

Everything expensive happens offline and exactly once: pbf decoding, way
geometry resolution, Unicode folding, street grouping, deduplication. The server
loads the result and never mutates it. This is a common shape
and the point of it is that the
boundary is a **file format, not a language**. The ingest stage is Go here; it
could be Java or Rust tomorrow without the server noticing.

The offline stage also has genuinely different constraints from the serving one
— it is throughput-bound, restartable, and runs on a schedule, whereas the
server is latency-bound and stateless. Those want different languages, different
deploys and different scaling. Keeping them apart is the main structural
decision in this repo.

### The address schema is polymorphic, because the data is

The obvious schema is `{house number, street, city}`. It is wrong for this
region, and quantifiably so. Measured over the full extracts (`make verify`):

| tag | Czechia | Poland |
|---|---|---|
| `addr:housenumber` | 100.0% | 100.0% |
| `addr:street` | **52.9%** | **64.9%** |
| `addr:place` | 84.5% | 35.3% |
| `addr:city` | 24.8% | 64.5% |
| `addr:conscriptionnumber` | 85.0% | 0.3% |

**47% of Czech addresses have no street.** They hang off `addr:place` — the
*část obce*, a municipality part — and are identified by a *číslo popisné*
(conscription number, unique within that part) optionally plus a *číslo
orientační* (sequential along a street), written together as `248/39`. A rural
Czech address is `Velká Úpa 299`, not `<street> <number>`.

So records carry an **addressing anchor** that is a street *or* a place, plus
locality context from either or both of `addr:city` and `addr:place`. In the
finished index that is **4,452,358 addresses — 38.3% of the corpus — that a
street-only schema would silently drop.**

This is also why the tag distribution was measured before the schema was
written. `cmd/tagstat` exists for exactly that, and is kept in the repo because
the answer will drift as OSM changes.

### Three passes over each extract

A pbf file is ordered nodes, then ways, then relations, and ways reference nodes
by bare ID. Resolving way geometry therefore needs locations already streamed
past. This is not a corner case: **5.37M of Poland's 8.58M addressed features
are tagged on building ways, not nodes**, so a node-only ingest drops 63% of
Polish addresses.

Holding every node location is not viable — the Poland extract has 241M nodes,
and a hash map keyed by int64 OSM IDs runs to tens of gigabytes. Instead:

```
pass 1  ways   -> select features, record the node IDs they need
pass 2  nodes  -> emit address/place nodes; retain only the wanted locations
pass 3  ways   -> resolve geometry, emit
```

Each pass skips decoding the object types it does not need. The wanted node IDs
go into a sorted `[]int64` with a hand-rolled binary search rather than a map:
for Poland that is **38.0M retained locations in 608 MB** instead of several GB.
Peak RSS for the full CZ+PL build stays comfortably under 4 GB.

Buildings need every vertex, but a street only needs one representative point,
so for highways only the middle vertex is retained — otherwise long roads would
dominate the retained set.

### Representative points

For a building outline, the **polygon area centroid** (shoelace formula), not
the mean of vertices: OSM buildings often have many nodes bunched along one
detailed facade, which drags a vertex mean off-centre. Degenerate rings fall
back to the vertex mean.

For a street, the **segment midpoint** — an area centroid of a curved road can
land in a neighbouring field.

### Localities are derived spatially, not read from tags

Of 241,815 named Czech street ways, **four** carry `addr:city`. Grouping streets
on the tag alone collapsed every `Nádražní` in the country into one record —
27,023 streets nationwide instead of a plausible ~90,000.

The fix is to derive locality from the places layer, which is the standard
"precompute the hierarchy at build time" move: it turns what would be a
point-in-polygon query per request into a field lookup. Nearest-settlement is
too naive — it assigns streets on the edge of Prague to whichever village sits
just outside — so candidates within 30 km are scored `distance / catchment`,
where catchment scales with settlement class (city 15 km, village 2.5 km, hamlet
1.2 km). A large settlement's streets genuinely are far from its centroid; a
hamlet's are not.

Result: **89,718 Czech streets, 575 distinct `Nádražní`, zero duplicate
(name, locality) keys, 0.08% unassigned.** The same machinery gives a locality
to the 3.6% of addresses tagged with neither `addr:city` nor `addr:place`
(183,222 of 183,462 resolved, 99.87%).

### Cross-extract deduplication is mandatory

Geofabrik country extracts carry a cross-border buffer. The Poland extract
contains Czech villages (*Dětřichovec*) and German ones (*Görlitz*). Without
deduplication by OSM ID, every border settlement is indexed twice. The build
caught **35,457 duplicates** between just these two countries.

### Normalization is the single biggest quality lever

Folding runs identically at index time and query time — that symmetry is the
whole contract, and there is a test asserting the two code paths cannot drift.

- NFD decomposition plus combining-mark removal handles Czech háčky/čárky and
  Polish ogonki.
- A **singleton table** handles what NFD cannot: `ł`, `đ`, `ø`, `ß` and friends
  have their own codepoints and do not decompose. Without it `Łódź` folds to
  `łodz` and never matches a typed `Lodz` — and that is one of Poland's largest
  cities.
- **Serbian Cyrillic → Latin** transliteration, so `Бања Лука` and `Banja Luka`
  reach the same tokens. Bosnia carries 52,348 `name:sr` values; this is cheap
  and ships now even though Bosnia is last.
- Street-type abbreviations are expanded (`ul.` → `ulica`, `nám.` → `náměstí`)
  and then dropped as stopwords, so `ul. Marszałkowska`, `ulica Marszałkowska`
  and `Marszałkowska` converge on one token. Removal is skipped when it would
  empty the list, protecting features genuinely named `Rynek` or `Plac`.

### Why Go, not Java

Java is a common choice for this stage; Go was a deliberate alternative, and the
architecture is designed so it does not matter — see "the artifact is the
contract" above. Concretely Go bought: a static dependency-free binary,
`paulmach/osm` for pbf decoding, cheap parallelism across blob decoding (the
build sustains ~200–700% CPU), and a fast edit-compile-test loop. The
`fst`-crate case for Rust is real but only pays off at the index-structure
stage, and pulling native code back into the TypeScript server via napi-rs would
undercut the point of the split.

---

## Repository layout

```
ingest/
  cmd/geoingest/     pipeline entry point, street grouping, orphan resolution
  cmd/tagstat/       measures real tag distributions in an extract
  internal/pbf/      three-pass .osm.pbf extraction, geometry resolution
  internal/model/    the normalized record schema and OSM tag -> record mapping
  internal/norm/     Unicode folding, transliteration, abbreviations
  internal/spatial/  uniform grid index for nearest/radius queries
build/               generated artifact (gitignored)
data/raw/            downloaded extracts (gitignored)
```

## Testing

The `spatial` package is verified against brute force on 2,000 randomized
nearest-neighbour queries and 500 radius queries — a grid that stops at the
first non-empty ring returns wrong answers, and the test catches exactly that.
The `norm` package asserts real folding cases per language plus Cyrillic/Latin
convergence.

Data-level verification after each build: layer and country counts, anchor
distribution, records with no search tokens (0), and coordinates outside the
expected bounding box (0).

---

## Next: the serving stage

One endpoint, dispatching on parameters:

```
GET /v1/geocode?q=Marszałkowska+12        -> forward
GET /v1/geocode?lat=50.0755&lon=14.4378   -> reverse
```

Planned index structures, per the analysis that produced this schema:

- **Forward** — inverted index over the precomputed tokens. All query tokens but
  the last matched exactly, the last as a prefix range, which is what makes
  autocomplete work. Ranking multiplies a BM25-ish text score by layer prior,
  settlement importance and optional proximity.
- **Reverse** — a static k-d tree (`kdbush`/`geokdbush`) over packed typed
  arrays. Millions of points, k-nearest in true great-circle order, no
  per-point JS objects.
- **Memory layout** — struct-of-arrays with fixed-point `Int32Array`
  coordinates and one concatenated string buffer, rather than 12M JS objects.

## Future improvements

- **Bosnia and Herzegovina.** Extract confirmed available (153 MB), but with
  135,691 address points against 309,236 highways it is ~10% covered and has no
  national open address dataset to conflate against — the Federation and
  Republika Srpska geodetic administrations publish separately. It is therefore
  the case that justifies graceful degradation: falling back to street, then
  locality, with an honest confidence score. The Cyrillic handling is already in
  place.
- **Conflating authoritative national data.** Poland's GUGiK PRG address points
  (~7M, ~20 GB of GML) would materially improve coverage; 20 GB of GML is itself
  a good argument for the compiled ingest stage. Czechia gains less — OSM there
  is already largely RÚIAN-derived — so RÚIAN is better used as a validation set.
- **Incremental updates.** Geofabrik publishes daily `.osc.gz` diffs; the build
  currently does a full rebuild every time.
- **Better street geometry.** Streets are reduced to one point; a bounding box
  or centreline would let reverse geocoding say "no. 12 side of the street".
- **Address interpolation.** Deliberately skipped: `addr:interpolation` appears
  258 times in Czechia and 39 in Poland. Measured, not assumed.

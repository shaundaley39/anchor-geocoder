# Minimal Geocoding API — Czechia & Poland

A geocoding service over OpenStreetMap data for Czechia and Poland (Bosnia and
Herzegovina optional), built as two stages:

| Stage | Language | What it does |
|---|---|---|
| **Extract** | Go | Reads `.osm.pbf`, resolves way geometry, normalizes text, groups streets — emits a record stream |
| **Index** | Go | Turns the record stream into a binary artifact of flat typed arrays |
| **Serve** | TypeScript | Loads the artifact at boot, serves one `/v1/geocode` endpoint for both directions |

## Quick start

```bash
make fetch     # ~3 GB of OSM extracts from Geofabrik, checksum-verified
make records   # ~5 min  -> build/records.ndjson.gz   (12.2M records)
make index     # ~78 s   -> build/index/              (254 MB artifact)
make install   # server dependencies
make serve     # boots in 1.4 s, listens on :3000
make test      # Go + TypeScript suites
```

Go 1.24+, Node 22+, pnpm. No cgo, no C++ toolchain — `CGO_ENABLED=0`
throughout, so the ingest binaries are fully static.

## The endpoint

One endpoint serving both directions, dispatching on which parameters are
present. Forward and reverse return the same feature shape.

```bash
# forward
curl 'localhost:3000/v1/geocode?q=Marszalkowska+12'
curl 'localhost:3000/v1/geocode?q=Prazska+248/39'
curl 'localhost:3000/v1/geocode?q=Warsz&limit=5'              # autocomplete
curl 'localhost:3000/v1/geocode?q=Nadrazni&proximity=49.19,16.60'

# reverse — same endpoint
curl 'localhost:3000/v1/geocode?lat=50.0813&lon=14.4262&limit=3'
```

| parameter | applies to | meaning |
|---|---|---|
| `q` | forward | free-text query; the final token is matched as a prefix |
| `lat`, `lon` | reverse | query point (mutually exclusive with `q`) |
| `limit` | both | 1–50, default 10 forward / 5 reverse |
| `country` | both | `cz` or `pl` |
| `proximity` | forward | `lat,lon` to bias ranking |
| `radius` | reverse | metres, default 5000, capped at 50000 |

Responses are a GeoJSON `FeatureCollection` shaped after the conventional
geocoding API, so the endpoint is a drop-in for anything already speaking that
dialect.

```json
{
  "type": "FeatureCollection",
  "query": { "type": "forward", "q": "Prazska 248/39" },
  "features": [{
    "type": "Feature",
    "id": "addr:3106418",
    "place_type": ["address"],
    "text": "Pražská 248/39",
    "place_name": "Pražská 248/39, Olomouc, CZ",
    "center": [17.2232, 49.6015],
    "geometry": { "type": "Point", "coordinates": [17.2232, 49.6015] },
    "properties": {
      "layer": "address", "name": "Pražská", "country": "cz",
      "locality": "Olomouc", "house_number": "248/39"
    },
    "relevance": 74.0161
  }],
  "attribution": "© OpenStreetMap contributors (ODbL)"
}
```

## Measured behaviour

Built from the 2026-08-31 Geofabrik extracts.

| stage | time | output |
|---|---|---|
| extract | 4m51s | 12,175,034 records (11,637,055 addresses / 396,723 streets / 141,256 places) |
| index | 1m18s | 677,786 anchors, 11,632,595 addresses, 127,039 terms — **254 MB** |
| boot | **1.4 s** | 42 ms to load the artifact, 1.3 s to build the k-d tree — **513 MB RSS** |

Query latency, 16-core M-series laptop, measured by `make bench`:

| query | p50 | p95 | p99 |
|---|---|---|---|
| exact city name | 0.155 ms | 0.256 ms | 0.333 ms |
| 3-char autocomplete prefix | 0.404 ms | 0.593 ms | 0.672 ms |
| street + house number | 0.014 ms | 0.021 ms | 0.026 ms |
| two-token street + number | 0.368 ms | 0.470 ms | 0.519 ms |
| reverse, dense area, k=5 | 0.006 ms | 0.016 ms | 0.028 ms |
| reverse, sparse (~5 km) | 0.008 ms | 0.133 ms | 0.349 ms |

One case is much slower and is called out under Future improvements: a reverse
query 12 km offshore with the radius cap raised to 50 km takes **~40 ms**.

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

### The index is built over anchors, not addresses

Measured on the built corpus: **11,637,055 address points resolve to just
430,551 distinct (street-or-place, locality) anchors.** A house number is not a
name anyone searches for — it is a lookup *within* a street. So text search runs
over 677,786 anchor documents rather than 12M address documents, a 17x smaller
index, and the number is resolved afterwards by binary search inside the matched
anchor's contiguous run of addresses.

This is also what keeps the artifact small. Storing a rendered display string
per address would cost ~370 MB; dictionary-encoding the 156,578 distinct names
and 262,313 distinct house numbers costs **3.7 MB**.

A wrinkle the data forced: 141,524 anchors are referenced only by address points
and were never mapped as a highway or a place in their own right, so the builder
synthesises them and gives them the centroid of their address run.

### The artifact is flat typed arrays

Every file in `build/index/` maps onto exactly one JavaScript typed array, so
loading is a read plus a view — no parsing, no per-record objects:

```
strings.bin/.idx   concatenated UTF-8 + uint32 offsets
anchor_*.bin       struct-of-arrays x 677,786   (name, locality, lat, lon, flags, score, addr range)
addr_*.bin         struct-of-arrays x 11.6M     (number, lat, lon, anchor, sort key)
terms.bin/.idx     127,039 sorted search terms
post_off/post.bin  inverted index, 1.6M postings
```

Coordinates are `Int32` fixed-point at 1e7 (~1.1 cm) rather than `Float64`,
halving the largest arrays. The result: **254 MB on disk, 42 ms to load, 513 MB
resident** for 11.6M addresses. The same data as JavaScript objects would be
several GB and minutes of startup.

Two searches exploit the layout directly. Terms are stored sorted, so
autocomplete on the final query token is two binary searches for a prefix range
rather than a scan of 127,039 terms. Address runs are sorted by the house
number's leading integer, so finding number 248 on a street with thousands of
addresses is a binary search.

### Retrieve, then rerank

Ranking happens in two stages, and the split is not premature optimisation — it
fixes a real failure. The term `praha` has **3,665 postings**, every street whose
locality is Praha, all sharing one text weight. Truncating that to a candidate
set by text score alone leaves an arbitrary slice of a 3,665-way tie, and Praha
itself falls out of it. So the coarse stage multiplies in the importance prior
(one array read, no string decoding), and only the top 400 survivors get scored
properly.

The rerank adds two things the coarse pass cannot afford:

- **Name coverage.** Without it, `Pražská` scores identically against `Pražská`,
  `Nová Pražská` and `Pražská brána`, and the street the user meant is lost among
  its longer namesakes. Coverage is `min(queryTokens, nameTokens) / nameTokens`,
  squared.
- **House-number resolution.** An anchor that actually has number 248 is boosted
  6x over one that merely shares the street name. This has to happen before
  truncating to `limit`, because the right street can sit well down the coarse
  ranking — that was the bug that made `Pražská 248/39` return streets instead of
  the address.

An exact term match on the final token also beats a mere prefix hit (1.6x), so
`Praha` outranks `Prahatice` — which is a real OSM name variant, not a typo of
mine.

### Reverse geocoding

A static k-d tree (`kdbush`) over all 11.6M address points, built at boot in
1.3 s. It indexes flat `Int32Array` coordinates — the raw fixed-point values, so
no conversion happens during the build and precision is exact — and stores its
own index the same way, which is why 11.6M points cost ~140 MB and produce no GC
pressure.

The search grows its radius (150 m, then x4 each round) rather than using one
fixed box: most queries land in a populated area and are satisfied immediately,
while a query in a forest widens until it finds something. Because the tree is
built in raw degrees, where a degree of longitude is ~0.64x a degree of latitude
at Polish latitudes, the box is widened in longitude to guarantee it encloses
the true circle, and corners falling outside it are discarded so the radius
means what it says. Results are ranked by real great-circle distance.

### Query folding is a tested cross-language contract

The server re-implements the Go normalizer in TypeScript. If the two ever drift,
queries silently stop matching the index — zero results, no error, nothing in a
log. So `ingest/cmd/foldvectors` emits fold and token fixtures for 4,000 real
names drawn from the built corpus plus hand-picked edge cases, and
`server/test/normalize.contract.test.ts` asserts the TypeScript reproduces every
one exactly. Regenerate with `make fold-vectors`.

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
ingest/                       Go — offline stages
  cmd/geoingest/              extraction entry point, street grouping, orphan resolution
  cmd/geoindex/               record stream -> binary artifact
  cmd/tagstat/                measures real tag distributions in an extract
  cmd/foldvectors/            emits the Go->TS normalization contract fixtures
  internal/pbf/               three-pass .osm.pbf extraction, geometry resolution
  internal/model/             normalized record schema, OSM tag -> record mapping
  internal/norm/              Unicode folding, transliteration, abbreviations
  internal/spatial/           uniform grid index for nearest/radius queries
  internal/index/             artifact format and builder

server/                       TypeScript — online stage
  src/artifact.ts             loads the binary artifact into typed arrays
  src/normalize.ts            query folding; a port of internal/norm, contract-tested
  src/forward.ts              inverted index, retrieve-then-rerank, house numbers
  src/reverse.ts              k-d tree over 11.6M points
  src/geojson.ts              conventional FeatureCollection rendering
  src/server.ts               the single /v1/geocode endpoint
  test/                       43 tests, run against the real artifact

build/                        generated artifact (gitignored)
data/raw/                     downloaded extracts (gitignored)
```

## Testing

`make test` runs both suites. 43 TypeScript tests and the Go suite, all against
real data rather than fixtures — the things most likely to break in a geocoder
are the joins between stages, and those are invisible to a unit test with a
hand-made input.

The tests that would actually catch a regression:

- **Reverse geocoding vs brute force.** The k-d tree result is compared against
  a linear scan of all 11.6M points. A tree bug or a mistake in the
  longitude-widening logic returns a plausible-looking wrong answer, and nothing
  short of brute force notices.
- **The spatial grid vs brute force**, on 2,000 randomized nearest-neighbour and
  500 radius queries. A grid that stops at the first non-empty ring is wrong,
  and this catches exactly that.
- **The Go/TypeScript folding contract**, on 4,000 real names — see above.
- **Artifact integrity**: every anchor's address range lies inside the address
  arrays and back-references its own anchor; every run is sorted by house
  number; terms are sorted. The binary searches are only correct if these hold.
- **Round-tripping every house number** on a well-populated street back through
  `findHouseNumber`.
- **GeoJSON coordinate order** is `[lon, lat]`, the classic way to ship a broken
  map.

Data-level verification after each build: layer and country counts, anchor
distribution, records with no search tokens (0), coordinates outside the
expected bounding box (0).

## Known limitations

- **Reverse geocoding far from any address is slow.** A query 12 km offshore
  with the radius raised to 50 km takes ~40 ms, because the expanding box finds
  nothing until it is large, then haversines everything inside it. The fix is a
  true k-nearest walk (`geokdbush`'s `around()`), which descends the tree in
  distance order and stops at k instead of scanning a box; the default 5 km cap
  keeps this off the common path for now.
- **Streets reduce to a single representative point**, so reverse geocoding
  cannot say "the even-numbered side of the street", and a long street's centre
  is only approximately where you would point at it.
- **A few Prague streets take a quarter name** ("Modřany") rather than "Praha",
  where the quarter's catchment wins locally.
- **8,344 place records still share an anchor key** with a same-named settlement
  inside the same ~28 km cell. Most are genuine node-and-area pairs of one
  settlement, which is the intended collapse, but the two cases are not
  currently distinguished.
- **No fuzzy matching.** A typo returns nothing. The term dictionary is sorted
  and in memory, so a SymSpell deletes-index or a BK-tree over it is the natural
  next step.

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
- **Scaling out.** The artifact is immutable and the server is stateless, so
  horizontal scaling is replication: build once, ship the directory, run N
  identical processes behind a load balancer. Past the point where 254 MB per
  country pair stops fitting comfortably, the natural shard key is the country
  (already a field in the artifact) or a geohash prefix, with a thin router.
- **Cheaper artifact.** `addr_anchor` (46 MB) is derivable by binary-searching
  `anchor_addr_start`, and posting lists would compress well as delta-varints.
  Neither is worth doing until the size actually hurts.
- **Rebuild cadence.** A full rebuild is ~6.5 minutes for both countries, so
  nightly is comfortable. Incremental updates from Geofabrik `.osc.gz` diffs
  would be the step after that.

# Minimal Geocoding API — Central Europe

A geocoding service over OpenStreetMap data covering a contiguous block of
fourteen countries: **Germany, Poland, Italy, Netherlands, Czechia, Austria,
Belgium, Switzerland, Denmark, Slovakia, Hungary, Croatia, Bosnia and
Herzegovina, Luxembourg** — 61M addresses, 4.8M points of interest, 3.5M
streets, 509k settlements.

Built as three stages:

| Stage | Language | What it does |
|---|---|---|
| **Extract** | Go | Reads `.osm.pbf`, resolves way geometry, normalizes text, groups streets — emits a record stream |
| **Index** | Go | Turns the record stream into a binary artifact of flat typed arrays |
| **Serve** | TypeScript | Loads the artifact at boot, serves one `/v1/geocode` endpoint for both directions |

## Setup

### Prerequisites

| | version | notes |
|---|---|---|
| Go | 1.24+ | `brew install go` |
| Node | 22+ | `brew install node` |
| pnpm | 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |

No cgo, no C++ toolchain, no database, no Docker. `CGO_ENABLED=0` throughout, so
the ingest binaries are fully static. You need **~20 GB of free disk** (14 GB of extracts, 3.3 GB record stream,
1.6 GB artifact) and, for the full fourteen-country build, **32 GB of RAM** —
extraction peaks at 23 GB. A smaller `COUNTRIES` subset scales down
proportionally; Czechia alone peaks well under 4 GB.

### Full build

```bash
make fetch       # 14 GB from Geofabrik, md5-verified
make records     # 24m09s -> build/records.ndjson.gz    (70M records, 3.3 GB)
make index       #  7m26s -> build/index/               (1.6 GB artifact)
make install     # server dependencies
make serve       # boots in 7.1 s, listens on 127.0.0.1:3000
```

Or `make all` for the first three. `make serve` runs in the foreground, so open
a second terminal to query it.

### Faster first run

Czechia alone is 6% of the data and gives a fully working API in **~90 seconds**
of build time — enough to try every feature on a laptop:

```bash
make fetch COUNTRIES=cz          # 901 MB instead of 3 GB
make records COUNTRIES=cz        # 64 s
make index                       # 22 s
make install && make serve
```

`COUNTRIES` takes any comma-separated subset of
`de,pl,it,nl,cz,at,be,ch,dk,sk,hu,hr,ba,lu`, and defaults to all fourteen.

### Verify it works

Startup prints what it loaded:

```
loading index from ../build/index ...
  677,786 anchors, 11,632,595 addresses, 127,039 terms (42ms)
building reverse k-d tree ...
  done (1275ms)
ready on http://127.0.0.1:3000 — boot 1372ms, rss 513MB
```

Then, from another terminal:

```bash
curl -s 'localhost:3000/health' | jq
```
```json
{
  "status": "ok",
  "version": 1,
  "built_at": "2026-09-05T09:26:01Z",
  "countries": ["cz", "pl"],
  "anchors": 677786,
  "addresses": 11632595
}
```

A one-line smoke test that exercises the whole stack — folding, the inverted
index, ranking and house-number resolution:

```bash
curl -s 'localhost:3000/v1/geocode?q=Prazska+248/39' | jq -r '.features[0].place_name'
# Pražská 248/39, Olomouc, CZ
```

### Configuration

All optional, read from the environment:

| variable | default | meaning |
|---|---|---|
| `INDEX_DIR` | `../build/index` | directory holding the artifact |
| `PORT` | `3000` | listen port |
| `HOST` | `127.0.0.1` | bind address (set `0.0.0.0` in a container) |
| `CORS_ORIGIN` | `*` | comma-separated allowlist of origins |
| `RATE_LIMIT_MAX` | `120` | requests per window per IP; `0` disables |
| `RATE_LIMIT_WINDOW` | `1 minute` | the window |
| `LOG_LEVEL` | `info` | pino level |

```bash
cd server && INDEX_DIR=/srv/geo-index PORT=8080 HOST=0.0.0.0 pnpm exec tsx src/index.ts
```

### Docker

The index is a 1.6 GB build artifact, not source, and it is not in the
repository — so there are two shapes, and which you want depends on whether you
are iterating or deploying.

```bash
make index                # produce build/index/ on the host first

make docker-run           # slim image (245 MB), index mounted read-only
make docker-run-bundled   # self-contained image (631 MB), no volume
docker compose up         # same as docker-run, via compose.yaml
```

| target | image | index | good for |
|---|---|---|---|
| `runtime` | 245 MB | mounted at `/index` | local dev — rebuild the index without rebuilding the image |
| `bundled` | 245 MB + index | baked in | deployment — one immutable artifact, nothing to mount |

Both run as the unprivileged `node` user with a `HEALTHCHECK` against
`/health`. For the full fourteen-country index, boot is ~7 s and steady-state
RSS is ~2.6 GB, so **give the container at least 4 GB** — a tighter limit is
OOM-killed while the k-d tree is being built. Verified at 2.375 GiB of a 4 GiB
limit.

The index is deliberately **not** built inside Docker. It needs 2.8 GB of OSM
extracts and ~6 minutes of CPU, which does not belong in an image build: it is a
data pipeline on its own cadence, and the artifact it produces is immutable and
shared by every replica. Build it once — on the host or in CI — then mount it or
bake it in.

For a real deployment the third shape is better than either: build the index in
CI, push the directory to object storage, and have the slim image fetch it on
boot (or read it from a shared read-only volume). That keeps images small,
decouples index rebuilds from code deploys, and lets N replicas share one build.
It is not implemented here.

### Other targets

```bash
make test           # Go + TypeScript suites (44 TS tests, needs a built index)
make bench          # query latency percentiles
make verify         # report real OSM tag distributions in an extract
make fold-vectors   # regenerate the Go->TS normalization fixtures
make clean          # remove build/ (keeps the downloaded extracts)
make docker         # build the slim image
make docker-bundled # build the self-contained image
```

### Troubleshooting

- **`pnpm install` fails against a private registry.** `server/.npmrc` pins
  `registry.npmjs.org`; if a global `~/.npmrc` still wins, run
  `pnpm install --registry=https://registry.npmjs.org/`.
- **`index artifact version N is not supported`.** The artifact predates the
  server. Rerun `make index`.
- **`missing extract for cz`.** Run `make fetch` first, or pass the `COUNTRIES`
  you actually downloaded.
- **Tests skip with "against the built index".** They need `build/index/`;
  run `make index`. The folding contract tests run regardless.

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

> **Coordinate order.** GeoJSON `center` and `coordinates` are `[lon, lat]`,
> which is the reverse of the `lat`/`lon` parameters. Feeding a `center` array
> straight back in left-to-right transposes them, and for this region the result
> lands off Somalia. When a reverse query finds nothing but the transposed point
> is inside coverage, the response says so in `query.hint` rather than just
> returning an empty list. `/health` reports the indexed bounding box.

| parameter | applies to | meaning |
|---|---|---|
| `q` | forward | free-text query; the final token is matched as a prefix |
| `lat`, `lon` | reverse | query point (mutually exclusive with `q`) |
| `limit` | both | 1–50, default 10 forward / 5 reverse |
| `country` | both | `cz` or `pl` |
| `proximity` | forward | `lat,lon` to bias ranking |
| `radius` | reverse | metres, default 5000, capped at 50000 |

Results span four layers, returned mixed and ranked: `address`, `poi`,
`street`, `place`. POI results carry a `category` property with the OSM
classification (`railway=station`, `amenity=restaurant`, `historic=castle`).

Coverage is whatever the artifact holds: currently
lat 48.547–54.835, lon 12.090–24.160.

Responses are a GeoJSON `FeatureCollection` shaped after the conventional
geocoding API, so the endpoint is a drop-in for anything already speaking that
dialect.

```json
{
  "type": "FeatureCollection",
  "query": { "type": "forward", "q": "Prazska 248/39" },
  "features": [{
    "type": "Feature",
    "id": "addr:857595",
    "place_type": ["address"],
    "text": "Pražská 248/39",
    "place_name": "Pražská 248/39, Olomouc, CZ",
    "center": [17.2232302, 49.6014881],
    "geometry": { "type": "Point", "coordinates": [17.2232302, 49.6014881] },
    "properties": {
      "layer": "address", "name": "Pražská", "country": "cz",
      "locality": "Olomouc", "house_number": "248/39"
    },
    "relevance": 222.0482
  }],
  "attribution": "© OpenStreetMap contributors (ODbL)"
}
```

## Measured behaviour

Built from the 2026-08-31 Geofabrik extracts.

| stage | time | output |
|---|---|---|
| fetch | — | 14 GB of extracts, md5-verified |
| extract | 24m09s | 69,970,497 records — 61,100,607 addresses, 4,811,189 POIs, 3,549,769 streets, 508,932 places. Peak 23 GB RSS |
| index | 7m26s | 10,240,843 anchors, 61,002,577 addresses, 2,079,646 terms — **1.6 GB**. Peak 12 GB RSS |
| boot | **7.1 s** | 84 ms to load the artifact, 7.0 s to build the k-d tree over 61M points — **2.6 GB RSS** |

Per country, as indexed:

| | addresses | anchors | | addresses | anchors |
|---|---|---|---|---|---|
| de | 20,614,031 | 3,727,116 | sk | 1,605,064 | 165,395 |
| nl | 9,920,836 | 638,407 | hu | 755,755 | 306,296 |
| pl | 8,549,230 | 1,074,206 | hr | 257,634 | 161,435 |
| it | 4,592,476 | 2,000,585 | lu | 166,549 | 24,328 |
| be | 4,098,467 | 409,362 | ba | 133,468 | 60,574 |
| cz | 3,035,605 | 337,451 | | | |
| dk | 2,613,417 | 315,937 | | | |
| at | 2,469,845 | 548,341 | | | |
| ch | 2,190,200 | 471,410 | | | |

Query latency, 16-core M-series laptop, measured by `make bench`:

| query | p50 | p95 | p99 |
|---|---|---|---|
| exact city name | 0.569 ms | 0.998 ms | 1.235 ms |
| 3-char autocomplete prefix | 1.276 ms | 1.747 ms | 1.912 ms |
| street + house number | 0.095 ms | 0.118 ms | 0.213 ms |
| two-token street + number | 0.933 ms | 1.229 ms | 1.387 ms |
| reverse, dense area, k=5 | 0.010 ms | 0.047 ms | 0.104 ms |
| reverse, sparse (~5 km) | 0.013 ms | 0.312 ms | 0.907 ms |

Latency is essentially flat against a 5x larger corpus: candidate lists grew,
but the per-layer cut bounds the reranking work regardless of index size.

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

### Scaling to fourteen countries surfaced three ceilings

Going from 11.6M to 61M addresses was not a matter of passing more filenames.
Three things in the code were sized for the smaller corpus:

- **The cross-extract dedup map** was keyed by the string `"osm:n123"`. At ~70M
  entries that is roughly 90 bytes each in header, backing array and bucket
  overhead — about 6 GB. Packing the type and id into one `int64` costs 16.
- **The country id was a 4-bit nibble** of `anchor_flags`, capping at sixteen.
  Fourteen countries came uncomfortably close to silently wrapping into the
  layer bits, so country moved to its own array.
- **`addr_anchor` stored the owning anchor per address.** At 61M addresses that
  is 244 MB to avoid a binary search over `anchor_addr_start`, so it was dropped
  and the anchor is derived in ~23 comparisons. That required making the start
  offsets a proper CSR array: anchors with no addresses previously stored zero,
  which is most anchors now that POIs exist, and would have broken the search.

Extraction was also 2.1x slower than it needed to be. Street-to-settlement
assignment scanned a 30 km radius when the largest catchment is a city's 15 km,
so three quarters of the candidates were fetched only to be rejected; and
`Within` computed each distance then discarded it, leaving the caller to
recompute. Fixing both took the extract from **50m22s to 24m09s**.

### Points of interest are curated, not swept up

"Everything named with a POI tag" is 332,648 features in Czechia alone, and the
top of that distribution is furniture rather than destinations:

```
public_transport=platform   59,545   one per bus-stop platform, all sharing the stop's name
tourism=information         56,930   hiking guideposts and notice boards
public_transport=stop_position 13,421
amenity=parcel_locker       11,218
historic=yes                 6,114
amenity=parking              3,218   mostly literally named "Parkoviště"
historic=wayside_shrine      2,307   plus 1,284 wayside crosses
amenity=atm                  1,791
```

Indexing that would bury every real result. Selection is therefore an allowlist
of twelve keys with a per-key exclusion of the values that are not places anyone
searches for — the test being whether a person would plausibly type the name
into a search box. That yields **663,724 POIs** across both countries.

A POI that also carries a house number produces **two** records, not one: the
POI and the address point beneath it. 10.5% of named Czech POIs are tagged this
way, and collapsing them would mean either losing "Restaurace U Fleků" from
search or losing "Křemencova 11" from the address layer — and with it from
reverse geocoding, which only searches addresses.

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
- **House-number resolution.** An anchor that actually has the requested number
  is boosted 6x over one that merely shares the street name, and 18x when the
  written number matches exactly rather than just numerically. Czech addresses
  carry two numbers, so `248/39` matches dozens of streets numerically but
  usually only one exactly — and that one should come first. Resolution has to
  happen before truncating to `limit`, because the right street can sit well
  down the coarse ranking; that was the bug that made `Pražská 248/39` return
  streets instead of the address.

**Completeness on the final token** is the other load-bearing piece. IDF alone
makes a rare term beat a common one by ~3x, which swamps any flat exact-match
bonus: `prahatice` (1 posting, a real OSM name variant) scored above `praha`
(3,665 postings) and the top hit for "Praha" was Prachatice. Prefix expansion is
a fallback for autocomplete, not an equal-weight alternative to matching what
was typed, so evidence is discounted by `(typed length / term length)²` and an
exact term match takes a further 1.6x.

This one is worth dwelling on: the bug was invisible on the cz+pl index and only
appeared on a cz-only build, because the IDF numbers happened to fall the other
way. There is a regression test asserting the invariant — an exact name beats a
longer prefix sibling — rather than one index's happened-to-work ordering.

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

### A place has more than one name

20.7% of named Czech features carry at least one alternate name, spread across
several tags (`cmd/namestat`):

```
name:<lang>      95,380   de 36,940 · cs 36,224 · en 5,662 · ru 4,100 · pl 3,590 · be · hu · sk · uk · fr · ja · nl · it · zh
operator         85,128
brand            29,537
official_name    21,764
alt_name          8,880
short_name        4,311
old_name          2,907
```

All of them are indexed. Every `name:<lang>` is taken rather than a fixed
language list — picking a subset means silently failing queries in the rest —
along with `alt_name`, `short_name`, `official_name`, `old_name`, `loc_name`,
`int_name`, `nat_name`, `reg_name`, and semicolon-delimited values are split
(1,206 of those in Czechia). `brand` and `operator` apply to POIs only: they are
what people type for "Żabka" or "Česká pošta", but on a school the operator is
the municipality, which is noise.

So `Prague` → Praha, `Pilsen` → Plzeň, `Breslau` → Wrocław, `Danzig` → Gdańsk,
`Brunn` → Brno, and `Wenceslas Square` → Václavské náměstí.

Variants are scored **separately, best one wins** — not merged into one token
bag. Merging would make a well-documented place appear to have a very long name
and rank worse the better it is described: Kraków carries 26 alternate names.

Note this is data-limited, not code-limited: `Cracow` does *not* resolve to
Kraków, because Polish OSM sets `name:en=Kraków` and no alias in the data spells
it that way. GeoNames publishes an `alternateNames` table of historical and
English exonyms that would close the gap; see Future improvements.

### Relevance measures the name, not its length

An anchor is indexed on more than its name: a POI carries its street, city and
postcode as searchable tokens too, so that "Restaurace U Fleků" is reachable by
its address. Scoring on name *length* therefore credits matches that never
touched the name. A railway station named **Lednice**, standing at Nádražní 1,
scored full marks for the query "Nadrazni" and — with a station's importance
prior of 5.5 against a street's 1.0 — outranked all 651 Czech streets of that
name.

So two quantities are measured: how much of the *query* the name and locality
explain (locality at partial credit, because adding a city should help rather
than dilute), and how much of the *name* the query accounted for. An exact
full-name match — every query token in the name, every name token used — gets
its own 2.5x bonus, because otherwise a perfectly matched street loses to a
partial match on a higher-prior feature.

### The coarse cut is per layer

Importance priors span 1.0 for a street to 7.0 for an airport, and the coarse
pass can only rank on the prior — it has no idea whether the query matched a
name. A single overall cut therefore deletes the lowest-prior layer wholesale
whenever a term has more high-prior postings than the budget.

Measured: the term `nadrazni` has 1,136 postings, 424 of them POIs. Every
station, museum and cinema outranked every one of the 710 street anchors, so
`Nádražní / Brno` came **427th** and was discarded on every query — proximity
included — before anything looked at the name. The cut is now 200 per layer.

Proximity is applied in the coarse pass for the same reason: 651 streets share
one term weight and one prior, so without it the surviving slice of that tie is
arbitrary and the one next to the query point may not be in it.

### Results are deduplicated at query time

One place is routinely several OSM features — Karlův most is mapped as an
attraction more than once along its length, a tram stop is a node per direction.
Returning all of them spends the caller's result slots on one answer.
Build-time merging cannot fix it: the features are hundreds of metres apart, and
a merge radius that wide would fold together genuinely distinct branches of a
shop chain. So same-name, same-layer results within 600 m collapse at
presentation time, which keeps both cases right.

### Production middleware

Three things that are not core geocoding but are the difference between a demo
and a service:

- **CORS** (`@fastify/cors`). A geocoding endpoint is called from browsers by
  definition — an autocomplete box in someone else's page — so it is useless
  without this. Open by default because the data is public and there is no auth;
  `CORS_ORIGIN` narrows it to a comma-separated allowlist.
- **Rate limiting** (`@fastify/rate-limit`). Every request touches an in-memory
  index, so the per-request cost is microseconds and the real exposure is one
  client saturating the single Node thread. A blunt per-IP cap is the right
  shape for an unauthenticated public endpoint; `RATE_LIMIT_MAX` and
  `RATE_LIMIT_WINDOW` tune it. Returns 429 with `RateLimit-*` and `Retry-After`
  headers. `/health` is exempt — throttling it would make the container runtime
  report the service unhealthy under exactly the load it should survive, and
  kill it.
- **Structured logging** (Fastify's pino). One JSON line per request with a
  request id, path, status, duration and result count; `Authorization` and
  `Cookie` redacted; `trustProxy` on so client IPs survive a load balancer.
  Health checks are excluded — they fire every 30 s and would otherwise
  dominate the log.

```json
{"level":30,"reqId":"req-1","method":"GET","path":"/v1/geocode","status":200,
 "duration_ms":3.29,"query_type":"forward","results":10,"msg":"request"}
```

CI is deliberately absent. It is genuinely low-effort, but it is production
scaffolding rather than part of the problem, and the time was better spent on
the POI layer.

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
- **Some landmarks mapped as relations are missing**, per the relation gap
  below. Prague's airport and the Colosseum are the visible examples; Vienna's
  Schönbrunn, Berlin's Brandenburger Tor, the Matterhorn and the Zugspitze all
  resolve correctly.
- **No fuzzy matching.** A typo returns nothing. Diacritic-insensitivity
  (`Plzen` → `Plzeň`) is *not* fuzzy matching — both sides pass through the same
  deterministic normalizer, so it is an exact match on a folded form. Tolerating
  a genuine misspelling needs edit distance; see Future improvements.
- **OSM relations are skipped**, so multipolygon-mapped features are missing.
  Measured on Czechia and Poland: 36,703 named POI-tagged relations against
  663,724 indexed POIs, so 5.2% by count — but they skew large. Prague's
  Letiště Václava Havla is a multipolygon and is absent, while Warsaw Chopin and
  Kraków-Balice, mapped as ways, are present. Resolving multipolygon geometry
  needs member ways and then their nodes: two more extraction passes.

## Future improvements

- **Bosnia and Herzegovina.** Extract confirmed available (153 MB), but with
  135,691 address points against 309,236 highways it is ~10% covered and has no
  national open address dataset to conflate against — the Federation and
  Republika Srpska geodetic administrations publish separately. It is therefore
  the case that justifies graceful degradation: falling back to street, then
  locality, with an honest confidence score. The Cyrillic handling is already in
  place.
- **A curated exonym gazetteer.** OSM's alias coverage is good but uneven —
  `Cracow` is absent from Kraków. GeoNames publishes an `alternateNames` table
  (~16M rows, historical and English exonyms, with `isPreferredName` and
  `isHistoric` flags) keyed by GeoNames id; joining it onto the place layer by
  name and position would close most of the remaining gaps and supply the
  population figures the importance prior already wants.
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

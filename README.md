# anchor-geocoder

A forward and reverse geocoding API over OpenStreetMap data, served from a
purpose-built binary index.

Named for the abstraction it is built on. Addresses are not documents in the
text index — each one hangs off an **anchor**, which is polymorphically a street
*or* a place, because 47% of Czech addresses have no street and the classic
`{housenumber, street, city}` schema silently drops half the country. That
collapses 14.0M addresses into 2.0M searchable anchors, and turns a house number
from a document of its own into a binary search inside the anchor that matched.

The default build covers **Poland, Czechia, Switzerland and Bosnia and
Herzegovina** — 14.0M addresses, 963k points of interest, 2.0M anchors — and
takes under four minutes end to end. Those four are chosen to span the
interesting cases rather than to be big: Czechia exercises the polymorphic
address anchor (47% of its addresses have no street), Poland is the
street-and-city model at scale, Switzerland brings four languages and dense
alpine POIs, and Bosnia is the sparse case at ~10% coverage with Cyrillic and
Latin names for the same places.

The pipeline also runs over a contiguous fourteen-country block — adding
Germany, Italy, Netherlands, Austria, Belgium, Denmark, Slovakia, Hungary,
Croatia and Luxembourg for **61M addresses and 4.8M POIs** — with one flag:

```bash
make all COUNTRIES=de,pl,it,nl,cz,at,be,ch,dk,sk,hu,hr,ba,lu
```

Measurements for both scales are given below, since how the design behaves at
5x the data is the more interesting number.

Built as three stages:

| Stage | Language | What it does |
|---|---|---|
| **Extract** | Go | Reads `.osm.pbf`, resolves way geometry, normalizes text, groups streets — emits a record stream |
| **Index** | Go | Turns the record stream into a binary artifact of flat typed arrays |
| **Serve** | TypeScript | Loads the artifact at boot, serves one `/v1/geocode` endpoint for both directions |

## A note on scope

The brief suggested a day's work for a minimal service. This is more than that, deliberately,
and the reason belongs here rather than being left to inference.

Written with LLM assistance, which changes what a day buys: the cost of writing
code drops far more than the cost of deciding what is worth writing. So the time
went into the deciding — measuring the corpus before choosing a schema, chasing
the ranking failures to their causes, and proving the claims rather than
asserting them. Most of what follows is that reasoning, not the code.

The endpoint itself is minimal, as asked: one route, two directions.

**If you read one section**, read [Retrieve, then rerank, with a bound that
makes pruning safe](#retrieve-then-rerank-with-a-bound-that-makes-pruning-safe).
It is the piece I would most want to be questioned on. [The address schema is
polymorphic](#the-address-schema-is-polymorphic-because-the-data-is) is the
decision the whole design rests on, and [Known
limitations](#known-limitations) is what I would fix next.

## Contents

- [Sixty-second demo](#sixty-second-demo) — three calls with real output
- [Setup](#setup) — prerequisites, build, Docker, CI
- [The endpoint](#the-endpoint) — parameters, response shape, OpenAPI
- [Measured behaviour](#measured-behaviour) — build times, latency, memory
- [Architectural decisions](#architectural-decisions) — the long section; the
  data schema, the artifact format, ranking, reverse geocoding, and why each
  stage is in the language it is
- [Why the server is TypeScript](#why-the-server-is-typescript)
- [Repository layout](#repository-layout) · [Testing](#testing)
- [Known limitations](#known-limitations) — what is missing and why
- [Scaling to the planet](#scaling-to-the-planet) · [Future
  improvements](#future-improvements)

## Sixty-second demo

Nothing to download and nothing to build — a Liechtenstein index (12,547
addresses, 672 KB) is committed to this repository for exactly this:

```bash
make install && make demo
```

```
loading index from ../demo/index ...
  2,287 anchors, 12,547 addresses, 2,544 terms (2ms)
ready on http://127.0.0.1:3000 — boot 56ms, rss 249MB
```

```bash
curl 'localhost:3000/v1/geocode?q=Landstrasse+1'      # -> Landstrasse 1, Vaduz, LI
curl 'localhost:3000/v1/geocode?lat=47.1410&lon=9.5250'  # -> Känzile, 73.8m
```

A committed build artifact is a deliberate exception, and
`server/test/demo-index.test.ts` loads it in CI so a format change cannot ship
past it. `make demo-index` regenerates it.

The rest of this section is the default four-country build, with actual output.

**A Czech address with no street.** 47% of Czech addresses hang off `addr:place`
rather than a street, and the query is typed without diacritics:

```bash
curl 'localhost:3000/v1/geocode?q=Velka+Upa+299&limit=1'
```
```json
{
  "query": { "type": "forward", "q": "Velka Upa 299" },
  "features": [{
    "place_name": "Velká Úpa 299, CZ",
    "center": [15.7636224, 50.6784589],
    "properties": {
      "layer": "address", "name": "Velká Úpa", "country": "cz",
      "locality": "Velká Úpa", "house_number": "299"
    }
  }]
}
```

**A misspelling.** Correction runs only after an exact search finds nothing, and
the response says what was actually searched:

```bash
curl 'localhost:3000/v1/geocode?q=Warszwa&limit=1'
```
```json
{
  "query": { "type": "forward", "q": "Warszwa", "corrected": "warszawa" },
  "features": [{
    "place_name": "Warszawa, PL",
    "center": [21.0067249, 52.2319581],
    "relevance": 183.0286
  }]
}
```

**A click on Prague's Old Town Square.** Regions containing the point come
first, then everything else by distance:

```bash
curl 'localhost:3000/v1/geocode?lat=50.0870&lon=14.4207&limit=3'
```
```json
[
  { "place_name": "Praha, památková rezervace, CZ", "distance_m": 0,   "containing": true },
  { "place_name": "Staroměstský orloj, CZ",         "distance_m": 2.4, "containing": null },
  { "place_name": "Radniční věž, CZ",               "distance_m": 3.8, "containing": null }
]
```

*(The third is abridged to the fields that matter; each feature is a full
GeoJSON `Feature`.)*

Getting there from nothing takes one command and about four minutes — see below.

## Setup

### Prerequisites

| | version | notes |
|---|---|---|
| Go | 1.24+ | `brew install go` |
| Node | 22+ | `brew install node` |
| pnpm | 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |

No cgo, no C++ toolchain, no database, no Docker. `CGO_ENABLED=0` throughout, so
the ingest binaries are fully static. The default build needs **~5 GB of free disk** and about **8 GB of RAM** —
extraction peaks at 5.5 GB. The full fourteen-country build needs ~20 GB of disk
and **16 GB of RAM**. Czechia alone (`COUNTRIES=cz`) builds in ~90 seconds and
peaks around 2 GB.

### Full build

```bash
make fetch       # 3.5 GB from Geofabrik, md5-verified per file
make records     # 3m27s -> build/records.ndjson.gz     (16M records)
make index       # 1m42s -> build/index/                (469 MB artifact)
make install     # server dependencies
make serve       # boots in 118 ms, listens on 127.0.0.1:3000
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

`COUNTRIES` takes any comma-separated set of country codes, or `@group` names,
and defaults to `@default` (`pl,cz,ch,ba`).

```bash
make countries                    # everything available, and the named groups
make all COUNTRIES=cz             # one country, ~90 seconds
make all COUNTRIES=@nordics       # a named group
make all COUNTRIES=@baltics,fr    # mix groups and codes
make all COUNTRIES=@europe        # all 41, ~30 GB of extracts
```

**41 European countries** are configured: Albania, Austria, Belarus, Belgium,
Bosnia and Herzegovina, Bulgaria, Croatia, Cyprus, Czechia, Denmark, Estonia,
Finland, France, Germany, Great Britain, Greece, Hungary, Iceland, Ireland and
Northern Ireland, Italy, Kosovo, Latvia, Lithuania, Luxembourg, Malta, Moldova,
Montenegro, Netherlands, North Macedonia, Norway, Poland, Portugal, Romania,
Serbia, Slovakia, Slovenia, Spain, Sweden, Switzerland, Turkey, Ukraine.

Adding another is **one line in `config/countries.tsv`** — the same file the Go
build and the Makefile both read, so a country can never be fetchable but not
ingestable. `config/groups.tsv` names reusable sets, which is also how a sharded
build is expressed: one group per shard, built independently and in parallel.

Two naming notes carried in the config: Geofabrik's `great-britain` excludes
Northern Ireland and `ireland-and-northern-ireland` includes it, so `gb`+`ie` is
the British Isles with no overlap and no gap; and `xk` is the conventional
user-assigned code for Kosovo.

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
| `RATE_LIMIT_MAX` | `600` | requests per window per IP; `0` disables |
| `RATE_LIMIT_WINDOW` | `1 minute` | the window |
| `LOG_LEVEL` | `info` | pino level |

```bash
cd server && INDEX_DIR=/srv/geo-index PORT=8080 HOST=0.0.0.0 pnpm exec tsx src/index.ts
```

### Docker

The index is a 1.6 GB build artifact, not source, and is not in the repository.
So there are two shapes, and which you want depends on whether you are iterating
or deploying.

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

### Checks and CI

```bash
make lint           # exactly what CI runs: gofmt, go vet, golangci-lint, tsc, eslint
make test           # both suites
make hooks          # install the local git hooks
```

Two GitHub Actions workflows:

- **`ci`** — every push and pull request, path-filtered so a TypeScript change
  does not re-run the Go build. Formatting, `go vet`, golangci-lint, `go test
  -race`, `tsc --noEmit`, ESLint, `vitest`. No artifact needed: the integration
  tests skip without one, leaving the unit tests — folding, geometry, the k-d
  tree, which are what a code change is most likely to break. Typically a
  minute or two.
- **`pipeline`** — end to end. Fetches Czechia, runs extract and index, runs the
  full suite against the artifact it produced, then boots the server and queries
  it in both directions. On pull requests touching `ingest/`, weekly, and on
  demand with any `COUNTRIES` selection. It catches what unit tests structurally
  cannot: a record-schema change the index builder mis-reads, a format version
  bumped on one side only, an artifact the server refuses to load.

The integration tests declare which countries they need
(`needs('cz','pl')(...)`), so the pipeline job can build Czechia alone — 0.9 GB
rather than 30, and the tests naming Polish places skip rather than fail. A
test that silently requires one dataset is testing the dataset.

**Local hooks are static checks only, and deliberately do not run tests.**
`pre-commit` is gofmt, `go vet` and `tsc` on the staged directories, about a
second; `pre-push` only checks that the Go build is not broken. Running the
suite on push taxes every push to catch what CI catches a minute later, and the
habitual response to a slow hook is `--no-verify`, which removes the protection
altogether. Bypass either with `-n` / `--no-verify`.

### Other targets

```bash
make test           # Go + TypeScript suites
make bench          # query latency percentiles
make verify         # report real OSM tag distributions in an extract
make fold-vectors   # regenerate the Go->TS normalization fixtures
make countries      # every country and group the pipeline can ingest
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
present. Forward and reverse return the same feature shape and differ only in
how the caller asks, so splitting them would duplicate the response contract
for no gain.

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

Reverse results carry `distance_m`, and a feature containing the query point
also carries `containing: true` and `area_m2`. Features with real extent carry a
GeoJSON `bbox` so a UI can zoom to them rather than to a pinpoint.

Results span four layers, returned mixed and ranked: `address`, `poi`,
`street`, `place`. POI results carry a `category` property with the OSM
classification (`railway=station`, `amenity=restaurant`, `historic=castle`).

Coverage is whatever the artifact holds: currently
lat 48.547–54.835, lon 12.090–24.160.

Responses are a GeoJSON `FeatureCollection` shaped after the dialect the
commercial geocoding APIs converged on — `center`, `bbox` and a `place_type`
alongside the standard geometry, so the endpoint is a drop-in for anything
already speaking it. The **OpenAPI 3.1 document** is served at `/openapi.json` and rendered
at **`/docs`**.

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
**Default build** (pl, cz, ch, ba):

| stage | time | output |
|---|---|---|
| fetch | — | 3.5 GB of extracts, md5-verified |
| extract + index | **3m27s** | 1,965,085 anchors, 13,979,530 addresses, 963,136 POIs, 266,783 shapes — **469 MB**. Peak 5.5 GB RSS |
| boot | **118 ms** | **609 MB RSS** |

**All 41 European countries**, the largest build actually run:

| stage | time | output |
|---|---|---|
| fetch | — | 29.6 GB of extracts, md5-verified |
| extract | **1h23m** | 118M records — 97,171,286 addresses, 10,417,125 POIs, 8,871,902 streets, 1,784,728 places. 183,803 of 184,036 multipolygons stitched into closed rings (99.9%). Peak 32.7 GB RSS |
| index | **13m42s** | 23,297,843 anchors, 90,103,638 addresses, 4,423,316 terms, 91,815,428 postings — **4.37 GB**. Whole-build peak **35.25 GB RSS** |
| boot | **907 ms** | **4.8 GB RSS** |

Serving that is comfortable; building it is not. Peak memory scales with the
whole corpus rather than the largest extract, because records accumulate across
all 41 before any are written, and 35 GB only survived here because macOS
compresses memory under pressure. A container with a hard 24 GB limit kills this
build. That is the concrete argument for the sharded build described under
[Scaling to the planet](#scaling-to-the-planet), and it is measured rather than
projected.

**Full region** (all fourteen), for comparison:

| stage | time | output |
|---|---|---|
| fetch | — | 14 GB of extracts |
| extract | ~24m | 69,970,497 records — 61,100,607 addresses, 4,811,189 POIs, 3,549,769 streets, 508,932 places. Peak ~11 GB RSS |
| index | 7m41s | 10,240,843 anchors, 61,002,577 addresses, 2,079,646 terms, 1,466,886 shapes — **1.8 GB**. Peak 13 GB RSS |
| boot | ~0.5 s | the spatial structures come precomputed; boot is a read and a cast — ~**2.6 GB RSS** |

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

Query latency, 16-core M-series laptop, measured by `make bench`, at two corpus
sizes 6.4x apart:

| query | 14.0M addresses | 90.1M addresses |
|---|---|---|
| exact city name | 1.093 ms | **0.977 ms** |
| street + house number | 0.109 ms | **0.104 ms** |
| reverse, dense area, k=5 | 0.014 ms | **0.024 ms** |
| two-token street | 0.487 ms | **1.736 ms** |
| 3-char autocomplete prefix | 1.169 ms | **4.946 ms** (p99 11.0 ms) |

Exact lookups are flat, which is the design working: the search bound
terminates the rerank on evidence rather than on index size, and a house number
is a binary search inside one anchor whatever else the index holds.

Prefix queries are not flat, and that is the honest result. A 3-character
prefix over 4.4M terms expands to roughly twice the term range it did over 2.1M,
and every expansion's posting list is longer, so the coarse pass does more work
before the bound can prune anything. 4.2x slower for 6.4x the data is
sub-linear, but it is the query shape autocomplete depends on and the one that
would need attention first — the cheapest fix is capping the expansion by
posting count rather than by candidate count.

One case is much slower and is called out under Future improvements: a reverse
query 12 km offshore with the radius cap raised to 50 km takes **~40 ms**.

---

## Architectural decisions

### Two stages, with the artifact as the contract

Everything expensive happens offline and exactly once: pbf decoding, way
geometry resolution, Unicode folding, street grouping, deduplication. The server
loads the result and never mutates it. The point of the split is that the
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
*část obce*, a municipality part, and are identified by a *číslo popisné*
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

### Four passes over each extract

A pbf file is ordered nodes, then ways, then relations, and ways reference nodes
by bare ID. Resolving way geometry therefore needs locations already streamed
past. This is not a corner case: **5.37M of Poland's 8.58M addressed features
are tagged on building ways, not nodes**, so a node-only ingest drops 63% of
Polish addresses.

Holding every node location is not viable — the Poland extract has 241M nodes,
and a hash map keyed by int64 OSM IDs runs to tens of gigabytes. Instead:

```
pass 0  relations -> select multipolygons, note the member ways they need
pass 1  ways      -> select features, record the node IDs they need
pass 2  nodes     -> emit address/place nodes; retain only the wanted locations
pass 3  ways      -> resolve geometry, emit; keep member geometry for stitching
```

Relations come first because pass 1 has to know which extra ways to retain: a
member way usually carries no tags of its own — an airport perimeter is 68
untagged segments — so nothing else would select it. The rings are stitched
afterwards, in memory.

Each pass skips decoding the object types it does not need. The wanted node IDs
go into a sorted `[]int64` with a hand-rolled binary search rather than a map:
for Poland that is **38.0M retained locations in 608 MB** instead of several GB.
Peak RSS for the full CZ+PL build stays comfortably under 4 GB.

Buildings need every vertex, but a street only needs one representative point,
so for highways only the middle vertex is retained — otherwise long roads would
dominate the retained set.

A way selected in pass 1 is remembered as **one packed `int64`** — its OSM id
shifted left a bit, with the low bit marking whether it needs all its vertices —
and pass 3 finds it by binary search. It deliberately does *not* keep the way's
tags. Pass 3 re-reads the same way from the pbf, so a `map[string]string` held
per selected way buys nothing and costs everything: tens of millions of Go maps
at several hundred bytes each dominated peak memory. Dropping them took the
default build's peak from **11.5 GB to 5.5 GB** with no change to build time and
a byte-identical artifact.

### Stitching multipolygon relations

OSM maps a large feature as a relation whose outer ring is split across member
ways, in arbitrary order and either direction, wherever tagging changes or ways
meet. Prague's airport is 68 of them. Only 67% of Czechia's 2,955 named
multipolygons have a single outer way, so there was no shortcut: the pieces are
walked, matching end node ids and reversing where needed, until the ring closes.
Chains that never close are dropped rather than forced shut, since guessing at a
boundary nobody mapped invents geometry.

**183,803 of 184,036 resolve across Europe — 99.9%.** Deliberately partial: one
ring per relation, and inner rings ignored.

Two bugs came out of this, both found by running it rather than reading it. A
`natural=water` centreline was being stored as a *closed* ring, because
closedness was inferred from a shape merely existing rather than from the way's
own end nodes — so ray casting joined the Vltava's endpoints into an 11 km lens
that reported Old Town Square, 300 m inland, as inside the river. And a
self-intersecting stitched ring has shoelace areas that cancel, which made the
centroid divisor small without looking degenerate and produced a latitude of
94.2; that fed a negative cosine into the spatial grid and turned a bounded ring
walk into ten million iterations, hanging the Norwegian build. The centroid is
now checked against the ring's own bounding box, which is a validity test rather
than a magnitude one.

### The build holds one country at a time

Locality is derived spatially, so grouping one country needs settlements from
its neighbours — including neighbours later in the list. That is why street
segments, orphan addresses and POIs used to accumulate across all 41 extracts
before anything was written, and why peak memory tracked the whole corpus rather
than the largest country: **35.25 GB for a 4.4 GB artifact**.

Settlements are now collected in a places-only prepass over every extract first.
It is cheap, because places are a rounding error next to addresses — five
minutes and 1.79M settlements over 30 GB of pbf — and afterwards each country is
grouped, resolved, written and released.

The catchment lookup needed the same treatment. It held one grid per country and
searched it to 15 km for every point, because a *city* reaches that far: a 9x9
block of cells, roughly 2,400 distance checks against France's 556,582 places,
about fifteen million times over. But a hamlet only ever claims a point within
1.2 km. Splitting the grid by catchment class and searching each only as far as
its own class reaches drops that to about 70 checks, and Czechia's
post-processing from ~30 s to ~6 s.

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
just outside, so candidates within 30 km are scored `distance / catchment`,
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

Folding runs identically at index time and query time. That symmetry is the
contract, and a test asserts the two code paths cannot drift.

- NFD decomposition plus combining-mark removal handles Czech háčky/čárky and
  Polish ogonki.
- A **singleton table** handles what NFD cannot: `ł`, `đ`, `ø`, `ß` and friends
  have their own codepoints and do not decompose. Without it `Łódź` folds to
  `łodz` and never matches a typed `Lodz`, one of Poland's largest cities.
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
search or losing "Křemencova 11" from the address layer, and with it from
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

### Retrieve, then rerank, with a bound that makes pruning safe

Ranking happens in two stages, and the split is not premature optimisation — it
fixes a real failure. The term `praha` has **3,665 postings**, every street whose
locality is Praha, all sharing one text weight. Truncating that to a candidate
set by text score alone leaves an arbitrary slice of a 3,665-way tie, and Praha
itself falls out of it. So the coarse stage multiplies in the importance prior
(one array read, no string decoding), and the survivors get scored properly.

The rerank adds two things the coarse pass cannot afford:

- **Name coverage.** Without it, `Pražská` scores identically against `Pražská`,
  `Nová Pražská` and `Pražská brána`, and the street the user meant is lost among
  its longer namesakes. Query and name tokens are matched as *multisets*, each
  name token claimed at most once, so `Baden Baden` still matches both halves of
  `Baden-Baden` while `Praha Praha Praha` cannot match the one-token name three
  times over. Before that, repeats reinforced instead of diluting: `Praha`,
  `Praha Praha` and `Praha Praha Praha` scored 200, 577 and 1881, and the last
  two returned junk.
- **House-number resolution.** An anchor that actually has the requested number
  is boosted 6x over one that merely shares the street name, and 18x when the
  written number matches exactly rather than just numerically. Czech addresses
  carry two numbers, so `248/39` matches dozens of streets numerically but
  usually only one exactly, and that one should come first. Resolution has to
  happen before truncating to `limit`, because the right street can sit well
  down the coarse ranking; that was the bug that made `Pražská 248/39` return
  streets instead of the address.

#### Why the cut used to be a guess, and is not any more

The rerank is the expensive half, so it cannot run over every candidate: `Pra`
retrieves 23,251. The original answer was a fixed cut — keep the top 400 by
coarse score per layer, discard the rest. That is fast and usually right, and
there is no way to know when it is wrong. Every ranking bug found during this
build was of the form *the correct answer was cut before anything looked at it*.

So the cut is now an **admissible bound**, the A\* idea applied to ranking.
Alongside each candidate's coarse score the server computes a ceiling on what
that candidate could reach if the expensive factors all broke its way, then
walks candidates in descending ceiling order. When the best remaining ceiling
falls below the worst score already retained, nothing left can displace the
retained set, and the scan stops — **provably**, not heuristically.

Making the ceiling true meant fixing the factors that had no ceiling. Relevance
is `(explained × (0.1 + 0.9 × nameUsed))²`, at most 1 before the 2.5x
exact-match bonus, but only once a query token cannot be spent twice on the
same name token, which is what the multiset matching above guarantees.

A ceiling that is *true* is easy; one that is *tight* is the work. Bounding
relevance by its global maximum of 2.5 is sound and useless: for `Praha` it
claims each of 9,496 candidates might be an exact match, when most are
three-word POIs merely located in Praha, and the scan never terminates early. So
the artifact carries one byte per anchor — the token count of the shortest name
it is known by. A q-token query can cover at most `min(q, n) / n` of an n-token
name, and only an n = q name can match exactly, which puts those POIs at 0.16
instead of 2.5. One byte, 2 MB over the whole index:

| query | candidates | fully scored | |
|---|---|---|---|
| `Matterhorn` | 36 | 12 | |
| `Nadrazni` | 1,147 | 109 | |
| `Pra` | 23,251 | 79 | a 3-character prefix, 0.3% scored |
| `Praha` | 9,496 | 971 | |
| `Warszawa` | 16,253 | 8,639 | the honest worst case |

`Warszawa` is worth keeping in view. Over half its candidates have short names
the term matches, and a sound bound cannot tell `Warszawa` from `Warszawska`
without folding the name, so 8,639 full scorings is what correctness costs
there, not a defect to tune away. A hard ceiling of 10,000 still backstops the
scan, and `SearchStats.cappedByLimit` records whether the guarantee held; no
query in the benchmark set reaches it.

Two smaller things fell out of this. Ordering by ceiling rather than score meant
sorting 23,251 candidates to consume 79, so the sort became a heap over parallel
typed arrays — O(n) to build, O(log n) per pop — taking `Pra` from 3.91 ms to
1.38 ms. And because a heap has no stable order, ties now break on anchor id:
Wenceslas Square is mapped as two ways with identical scores, and the API should
return them in the same order every time.

Tests assert the bound rather than the outcome: that no candidate's true score
ever exceeds its ceiling (over 10,000 checks, with and without proximity), and
that pruning returns the same top result as an exhaustive scan.

**Completeness on the final token** is the other load-bearing piece. IDF alone
makes a rare term beat a common one by ~3x, which swamps any flat exact-match
bonus: `prahatice` (1 posting, a real OSM name variant) scored above `praha`
(3,665 postings) and the top hit for "Praha" was Prachatice. Prefix expansion is
a fallback for autocomplete, not an equal-weight alternative to matching what
was typed, so evidence is discounted by `(typed length / term length)²` and an
exact term match takes a further 1.6x.

The bug was invisible on the cz+pl index and appeared only on a cz-only build, because the IDF numbers happened to fall the other
way. There is a regression test asserting the invariant — an exact name beats a
longer prefix sibling — rather than one index's happened-to-work ordering.

### A typo should not look like an empty world

Diacritics were never the problem — `Plzen` finds `Plzeň` because both sides
pass through the same normalizer, which is an exact match on a folded form. A
real misspelling was: `Prahha` returned nothing, and an empty result is the most
visible way a search box feels broken.

Correction runs **only after** an exact search has found nothing, and never
instead of one, so a correctly spelled query can never be quietly rewritten into
a more popular neighbour. When it fires, the response says so — `query.corrected`
carries the text actually searched, for the caller to render as *showing results
for…* rather than passing off an answer to a different question:

```json
{ "type": "forward", "q": "Prahha", "corrected": "praha" }
```

The usual approach is SymSpell: precompute every deletion of every dictionary
term and look up deletions of the query. It works, but at 496,534 terms the
delete table is roughly 40 MB, and it is a whole index to build and ship.

**Pigeonhole instead.** If a term is one edit from the query, that single edit
lies wholly in one half of the query, so either the query's first half is an
exact prefix of the term, or its second half is an exact suffix. Both are
*prefix* searches, and a suffix search is a prefix search on reversed strings.
The term dictionary is already a sorted table with binary-search `prefixRange`,
so the only new data is that same dictionary reversed and re-sorted: **8 MB, and
no new data structure**. Candidates are then verified with a real distance check
that early-exits at two edits.

Among terms within one edit, the most frequent wins. That is the standard
spelling prior and the right one here: a typo is far likelier to be a mangled
Praha (3,665 postings) than an exact hit on some hamlet spelled almost the same.

Two deliberate limits. Tokens under 5 characters are left alone — `brna` is
equally close to Brno, Brna, BrnA and Brní, and correcting it is guesswork, not
inference. And the search is single-token: each token is corrected
independently, rather than searching the product of every token's candidates for
a combination that only works together.

Warm, the correction itself costs under a millisecond; the visible cost is the
retried search, so `Prahha` lands at the same 1.1 ms as `Praha`. A query that is
not a typo of anything — `Xyzzyplugh` — has both halves miss the dictionary and
returns in microseconds.

The test that matters is not the handful of typos that work. It is that the
pigeonhole property holds: for a set of misspellings, the two prefix searches
find exactly what a brute-force scan of all 496,534 terms finds.

### Reverse geocoding is two tiers, and keeps real geometry

A click asks "what is here", and the honest answer is a short ranked list rather
than one feature: the building the user meant may not be mapped, or may be the
second-nearest thing. So results come back in two tiers.

1. **Features whose outline contains the click, smallest area first.** If you
   are standing inside something, that is where you are; and of two nested
   regions the smaller is the more specific answer.
2. **Everything else, by distance.**

Containment beats proximity outright — a restaurant 25 m away is somewhere the
user is *not*, but sits directly above it, ahead of anything further off. The
containing tier is capped at four so a stack of nested regions cannot crowd the
nearby points off a short list.

```
tap inside the Englischer Garten, München
  IN Englischer Garten                [leisure=park]          0m   347.1ha
     Regenüberlaufbecken Gyßlingstr.  [man_made=reservoir]  133.6m
     Gyßlingstraße, München           [street]              142.6m
     Gyßlingstraße 23, München        [address]             192.8m

tap the Siegessäule inside the Tiergarten, Berlin
  IN Siegessäule                      [tourism=attraction]     0m     0.2ha
     Viktoria                         [tourism=artwork]       1.1m
     Großer Stern 1, Berlin           [address]               1.2m
```

**Filter and refine.** The two tiers ask different questions, so there are two
indexes.

A k-d tree over every point — every address *plus* every anchor — answers
"what is near". Anchors have to be in it: the first version indexed only
addresses, so a click could never return a park, a station or a street, only the
nearest doorway. That is why all three of the first test taps came back as house
numbers.

But a proximity search cannot answer "what am I inside". The Englischer Garten
is 3.7 km long, so a click at its north end sits ~2 km from the stored centroid
and no sane radius would reach it. Containment therefore gets its own index: a
uniform grid over anchor bounding boxes, each feature registered in every cell
its box touches. A click looks up one cell to get candidates — **the filter** —
and each is then tested against its actual simplified outline — **the refine**.

The box alone will not do. A diagonal or crescent feature fills a fraction of
it, so "inside the box" is not "inside the park"; there is a test asserting that
the notch of an L-shaped ring reads as outside even though its bbox accepts it.

**Geometry is affordable because most features opt out.** Only shapes that can
change an answer are stored:

| | count | shape? |
|---|---|---|
| address ways (building footprints) | 32,430,081 | no — metres across, the centroid is inside clicking tolerance |
| POI and place ways over 60 m | 926,901 + 8,472 | **ring**, Douglas–Peucker at 10 m, capped at 48 vertices |
| streets over 150 m | — | **sampled points** along the way; a ring makes no sense for a line |

That comes to **1,466,886 shapes and 9,621,818 vertices — a 73 MB `geom.bin`.**
Rings are stored as fixed-point pairs in one blob with a per-anchor offset
array, the same shape as the string table.

Distance is measured to the outline, not the representative point, so a click at
one end of a 2 km street reads as metres from the street rather than a kilometre
from its midpoint.

A ring is measured along its edges. An open shape is measured to its nearest
**vertex**, and the distinction matters: a street's stored points are the
midpoints of the ways composing it, in whatever order those ways appeared — a
sample of the street, not a traversal. Joining them draws segments the road does
not follow. Measuring along those changed the answer for **26.6% of streets and
under-reported by up to 300 m**, so streets appeared nearer than they were.
Vertex distance is honest about what the data is: the error is bounded by about
half the sample spacing, and it over-estimates rather than under-estimates. Point-in-polygon runs on the raw integers — ray casting is
sign-preserving under a uniform scale, so converting to degrees first would cost
precision and time for nothing.

The proximity search grows its radius (150 m, then ×4) rather than using one
fixed box: most clicks land somewhere populated and are satisfied immediately,
while one in a forest widens until it finds something. Because the tree is built
in raw degrees, where a degree of longitude is ~0.64× a degree of latitude at
these latitudes, the box is widened in longitude to enclose the true circle and
the corners falling outside it are discarded, so the radius means what it says.

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

### Nothing expensive happens at boot

The premise of the build/serve split is that the server does no heavy work. The
first version violated it: startup partitioned every point into a k-d tree
(~3.0 s) and constructed the containment grid (~2.4 s). Both are pure functions
of data already in the artifact, and both were recomputed by every replica on
every deploy and every rollback — scaling to close to a minute at planet size.

They are now built once, in Go, and shipped:

- `kd_perm.bin` — point ids in k-d tree order. The traversal is implicit, so the
  reader must partition exactly as the writer did; `kd_node_size` is recorded in
  the manifest rather than assumed. The reader depends only on the *invariant*
  at each node, not on a particular tie-break, so the Go and TypeScript builders
  can differ in permutation and both be correct, which the brute-force reverse
  test confirms.
- `cell_key` / `cell_start` / `cell_count` / `cell_items` — the containment grid
  as sorted cell keys with a CSR of anchor ids, replacing a `Map` built at boot
  with a binary search.

**Boot falls from 3.4 s to 118 ms**, for 61 MB of artifact, which is the same
`Uint32Array` that was resident anyway, so resident memory is unchanged. Cheap
startup is what makes horizontal scaling and instant rollback practical: a
replica is a process that reads a file.

### The k-d tree does not own its coordinates

`kdbush` copies every coordinate into arrays of its own, and those coordinates
are already in the artifact. Measured: the tree cost 209 MB, of which **128 MB
was a verbatim second copy** of `addr_lat`/`addr_lon` and
`anchor_lat`/`anchor_lon` — more than the entire render-only half of the
artifact, and ~490 MB at the fourteen-country scale.

So `PointIndex` keeps only the permutation, a `Uint32Array` of point ids in k-d
order, and reads coordinates back through an accessor that indexes the artifact
arrays that were resident anyway. Resident memory falls from 746 MB to
**620 MB**, and query latency is unchanged at 16 microseconds — a range query
touches only the nodes on its path, so it pays one indirect read per node.

Building is the opposite pattern: it touches every point ~log n times, hundreds
of millions of reads, and doing that indirectly is cache-hostile. A
contiguous scratch copy makes the build 0.8 s faster but adds 127 MB to *peak*
RSS, which is what a container limit watches, so the default trades boot time
for headroom, and the scratch path is a constructor flag.

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
  definition — an autocomplete box in someone else's page, so it is useless
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

### Why the build stage is Go

There is no default language for this. The heavy lifting in the OSM ecosystem is
mostly C++ — libosmium, osm2pgsql, Nominatim's indexer, OSRM — with a strong JVM
contingent in [Planetiler](https://github.com/onthegomap/planetiler),
GraphHopper and Photon, and Go present in imposm3. So the choice has to be
argued from what the stage actually is: a batch job that reads between 3.5 GB
and 88 GB of binary input and writes a binary file. Not a service, not a request
path — a compiler for map data. The default build reads 3.5 GB, the full
European set 30 GB, and the planet 88 GB; the design target is the top of that
range, not the bottom.

**Memory layout is the dominant constraint, and Go gives direct control of it.**
Two of the largest wins in this project were layout decisions that Go makes
expressible and measurable:

- the cross-extract dedup set keyed by a packed `int64` rather than an
  `"osm:n123"` string — at ~70M entries, 16 bytes each instead of roughly 90
- selected ways held as one packed `int64` rather than a struct carrying a
  `map[string]string` of tags, which took the build's peak from 11.5 GB to
  5.5 GB

Both are the kind of change you reach for when values are values and a slice is
a slice. In a language where everything is boxed by default they are harder to
express and harder to verify; in Node or Python they are not on the table.
The same control produced the artifact format itself — struct-of-arrays,
fixed-point `int32` coordinates, CSR offsets.

**The decode parallelises for free.** `paulmach/osm` decodes pbf blobs across
goroutines, and the scan phases sustain **696% CPU on a 16-core machine**. The
whole extract averages 238%, the gap being the genuinely sequential parts —
sorting the node-id set, grouping streets. Go's concurrency model is what makes
a library expose that as a plain `Scan()` loop rather than an executor and a
future.

**The operational surface is small.** Two direct dependencies. `CGO_ENABLED=0`
throughout, so the output is a static binary with no runtime to install — which
is why the build stage needs nothing in CI beyond `setup-go`, and why the
container never has to carry a JVM. Formatting, vetting, testing and
benchmarking are in the toolchain rather than in build-tool configuration.

**And it is easy to read six months later.** A small language with one obvious
way to do most things, and `gofmt` ending style discussion, is a real
maintenance property for a stage that will be revisited whenever OSM tagging
shifts.

#### Where the Go-versus-Java argument is weaker than it looks

Worth stating plainly, because the usual version of it is out of date:

- **Java's backwards compatibility is comparable, not worse.** Old bytecode runs
  on new JVMs. What people remember is the 8→9 module migration and the Oracle
  licensing scare, both largely behind us; since 17 LTS the story is good. The
  honest claim for Go is a *smaller* surface, not a *more stable* one.
- **Virtual threads closed most of the concurrency gap.** Since Java 21 the
  ergonomics of cheap concurrency are close enough that "Go for concurrency" is
  much weaker than it was a decade ago. The parallel decode above is a real
  benefit, but it is not one Java could not have.
- **The JVM might well be faster here, and the GC argument says so too.** A
  24-minute batch job is long past warmup, which is where a mature JIT shines.
  More pointedly: Go's collector is tuned for low pause and is not generational,
  while this workload wants throughput and allocates a torrent of short-lived
  decoded objects over a multi-GB long-lived heap. That is the generational
  hypothesis in its textbook form, and Java's collectors are built for it. I
  would not bet on Go winning a like-for-like rewrite on speed.
- **Planetiler is the counter-example that matters.** It builds planet-scale
  vector tiles in a few hours on one machine, memory-efficiently and with no
  external database, in Java — a strictly harder version of this job. It cuts
  both ways, though: its speed comes from hand-built off-heap, memory-mapped
  primitive storage, which is to say from working around the object model rather
  than with it.

So the argument is surface area and memory control, not raw speed, not
stability, and not a concurrency model Java lacks. And it is deliberately not
load-bearing: the artifact format is the contract, so this stage can be
rewritten in Java tomorrow without the server noticing. That property is the
point — a build stage you can replace is worth more than one you chose
perfectly.

The `fst`-crate case for Rust is real but only pays off at the index-structure
stage, and pulling native code back into the TypeScript server via napi-rs would
undercut the split.

---

## Why the server is TypeScript

The usual argument — a rich client ecosystem to integrate with — does not apply
to a geocoder. The real one is that everything *downstream* is JavaScript, and
the API can share code with it rather than just data.

`packages/core` is dependency-free and browser-buildable. A consumer importing
it gets the response types **and the exact query normalizer the index was built
with**, so a client can fold a query before sending it, and filter cached
results locally, without a second implementation of the folding rules.

That last point is load-bearing. There is already a Go↔TypeScript folding
contract test *because two implementations are dangerous*. A server in another
language would force a third one in the browser; here the client imports the
same module, and the drift risk goes to zero rather than up.

Three things follow:

- **`@anchor-geocoder/core`** — TypeBox schemas, the types derived from them,
  and the normalizer. One schema definition produces the runtime validation
  Fastify applies, the TypeScript types both sides import, and the OpenAPI
  document. They cannot drift, because there is nothing to keep in step.
- **`@anchor-geocoder/client`** — a typed, isomorphic client. Not just a fetch
  wrapper: it debounces, aborts superseded keystrokes so a slow request for
  "Pra" cannot overwrite the results for "Prague", and folds queries so
  equivalent spellings share one cache key.
- **OpenAPI 3.1**, generated from those same schemas rather than hand-written,
  so it cannot describe an API that no longer exists.

```ts
import { GeocodeClient } from '@anchor-geocoder/client';

const geo = new GeocodeClient({ baseUrl: 'https://geocode.example.com' });
const search = geo.autocomplete({ debounceMs: 150, limit: 5 });

input.addEventListener('input', async (e) => {
  const results = await search(e.target.value);   // debounced, cancellable
  if (results) render(results.features);          // null when superseded
});
```

What TypeScript costs, for honesty: one thread (~1,600 qps per process), no
`mmap`, and GC. All of which is mitigated by the server doing almost nothing at
request time, which is itself part of why the choice works out.

## Repository layout

```
packages/core/                shared contract: schemas, types, normalizer
packages/client/              typed isomorphic client with autocomplete
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
  src/query.ts                splits a query into name tokens and a house number
  src/terms.ts                inverted index: tokens -> candidate anchors
  src/ranking.ts              scoring, and the ceiling that makes pruning safe
  src/housenumber.ts          resolving a number inside an anchor's address run
  src/fuzzy.ts                one-edit spelling correction on the zero-result path
  src/forward.ts              the search loop combining the above
  src/geometry.ts             point-in-polygon, distance, area, haversine
  src/pointindex.ts           static k-d tree over borrowed coordinate arrays
  src/reverse.ts              two-tier reverse geocoding over that tree
  src/result.ts               the internal result shape, shared by both directions
  src/geojson.ts              FeatureCollection rendering
  src/routes.ts               /v1/geocode and /health
  src/server.ts               Fastify instance, plugins, request logging
  src/index.ts                process entry: load, attach indexes, listen
  test/                       104 tests, run against the real artifact

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

- **Importance is per category, not per feature.** A POI's prior comes from its
  OSM tag, so nothing distinguishes a world landmark from a namesake in the same
  class: Munich's Englischer Garten loses to a Swedish park carrying the name as
  a German alt-name, because `tourism=attraction` outranks `leisure=park`.
  Locality now breaks most such ties — 96% of POIs have one, against 41% before
  it was assigned spatially — but the underlying signal is missing. It wants
  Wikidata links or Wikipedia pagerank, which is what Nominatim uses.
- **Reverse geocoding far from any address is slow.** A query 12 km offshore
  with the radius raised to 50 km takes ~40 ms, because the expanding box finds
  nothing until it is large, then haversines everything inside it. The fix is a
  true k-nearest walk (`geokdbush`'s `around()`), which descends the tree in
  distance order and stops at k instead of scanning a box; the default 5 km cap
  keeps this off the common path for now.
- **Settlements have no extent.** OSM maps a city as a `place=city` *node* and
  its boundary as a relation, and only *multipolygon* relations are indexed —
  administrative boundaries are `type=boundary` and still skipped. So Berlin
  returns a point and no `bbox`, and the API omits the field rather than faking
  one from a radius. Boundary relations would also give the administrative
  hierarchy the results currently lack.
- **Buildings have no outline.** 32.4M footprints would cost more than they are
  worth when a centroid is already within clicking tolerance, so a click inside
  a building resolves to its address point a few metres away rather than to the
  building as a containing region.
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
- **Spelling correction stops at one edit, and at 5 characters.** `Prahha`
  resolves; `Prgaa` (two edits) and `Prga` (four characters, below the gate) do
  not. See "A typo should not look like an empty world".
- **Only multipolygon relations are indexed.** `type=boundary` is still
  skipped, which is why a settlement has no extent and why results carry no
  administrative hierarchy. One ring per relation, so an archipelago loses its
  smaller islands, and inner rings are ignored, so a click in a courtyard reads
  as inside the building around it.

## Scaling to the planet

Projected from the per-record costs measured in the built artifact, with the
global address count taken from taginfo rather than extrapolated:
**183,264,232 addresses**, ~34M anchors, 88 GB of pbf.

| | |
|---|---|
| addresses (183M × 16 B) | 2.93 GB |
| anchors (~34M × 59 B) | 2.00 GB |
| terms, postings, strings, geometry | 1.04 GB |
| **artifact** | **5.98 GB** |
| k-d tree permutation | 0.87 GB |
| node + runtime | 0.40 GB |
| **resident** | **~7.25 GB** |

**The whole world fits on one ordinary machine.** Central Europe is unusually
*well mapped* rather than unusually dense — the fourteen-country build holds a
third of the world's mapped addresses in about 3% of its land, so the planet is
only ~3× that corpus.

Treat that as a snapshot of OSM in 2026 rather than a property of the design.
Coverage elsewhere is improving, and if China or India reach parity the address
count grows several-fold with no warning. Sharding is a question of when.

### What actually forces sharding

Not capacity. In order:

1. **Throughput.** One Node thread at ~0.6 ms is around 1,600 queries a second
   whatever the index holds. This is the real driver, and replicas fix it.
2. **Blast radius.** One process holding the planet is one process to lose.
3. **Build parallelism.** Extraction peaks at 5.5 GB for four countries and
   around 11 for fourteen; the planet would want splitting regardless.

Boot is no longer on that list — the spatial structures are precomputed, so a
replica starts in 118 ms locally and would still be under a second at planet
scale.

### How sharding would work

The boundaries already exist in the data source, so this needs almost no new
code. Geofabrik publishes a continent → country → sub-region hierarchy, and
sharding is choosing a cut of that tree that balances.

- **The build mechanism exists.** `COUNTRIES=` already takes an arbitrary set
  and emits one artifact, so a shard is one `config/groups.tsv` entry. The runs
  are independent, which makes the build embarrassingly parallel.
- **The halo comes free.** Geofabrik extracts already carry a cross-border
  buffer, which is why the build deduplicates by OSM id, catching 221,709
  duplicates across fourteen countries. That machinery *is* what a shard halo
  needs, and the OSM id is already the merge key.
- **Routing needs no new index.** Every artifact already computes a coverage
  bounding box; promote it to the manifest and a router holds N manifests, a few
  kilobytes, routing on a box test.

Forward and reverse have opposite locality, which drives the shape. A click is
one point, so reverse goes to the shard containing it plus a neighbour near an
edge. Text is not local — someone looking at Prague may search for Lisbon, so a
small **global tier** of settlements and major POIs is replicated to every node
and answers those without fan-out, while geographic shards carry the long tail
of streets and addresses.

Replication and rebalancing are close to free, and that is the real payoff over
a search cluster: artifacts are immutable and versioned, so replication is N
nodes pulling the same file, and rebalancing is a different cut of the tree plus
a rolling restart. No leader election, no consensus, no live shard migration.

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
  is already largely RÚIAN-derived, so RÚIAN is better used as a validation set.
- **Incremental updates.** Geofabrik publishes daily `.osc.gz` diffs; the build
  currently does a full rebuild every time.
- **Better street geometry.** Streets are reduced to one point; a bounding box
  or centreline would let reverse geocoding say "no. 12 side of the street".
- **Address interpolation.** Deliberately skipped: `addr:interpolation` appears
  258 times in Czechia and 39 in Poland. Measured, not assumed.
- **Scaling out.** See below — the numbers turn out better than the hedge that
  used to be here.
- **Rebuild cadence.** A full rebuild is ~3.5 minutes for the default four
  countries and ~32 for all fourteen, so nightly is comfortable. Incremental
  updates from Geofabrik `.osc.gz` diffs would be the step after that.

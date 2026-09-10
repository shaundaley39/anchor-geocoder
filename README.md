# Anchor Geocoder

Anchor Geocoder is a geocoding API built on OpenStreetMap data, served from a purpose-built binary index. It maps from a text input (possibly and address or name) to places (forward geocoding), and from latitude/longitude pairs to places (reverse geocoding).

The "anchor" in the name is the abstraction used in the index: it polymorphically takes the value of a street or place, and resolves the fact that 47% of Czech addresses have no street and can be referenced by place.


## Setup Instructions


### Quick Start - Liechtenstein

To simplify working with this, I've included Liechtenstein directly in the git repo.

```sh
make install && make demo
```

```
loading index from ../demo/index ...
  2,287 anchors, 12,547 addresses, 2,544 terms (2ms)
ready on http://127.0.0.1:3000 — boot 56ms, rss 249MB
```

```sh
curl 'localhost:3000/v1/geocode?q=Landstrasse+1'      # -> Landstrasse 1, Vaduz, LI
curl 'localhost:3000/v1/geocode?lat=47.1410&lon=9.5250'  # -> Känzile, 73.8m
```

### Build Czechia, Poland, Switzerland and Bosnia

I've configured this country set as the default build - small enough to be workable for development, large enough to be interesting. Assume 5-10 minutes to build it and you won't be disappointed.

```sh
make all           # fetch + records + index — 3.5 GB of extracts, 4m38s without fetch time; the build requires 5.4 GB of RAM
make serve         # boots in 119 ms; running requires 752 MB of RAM
```

```sh
curl 'localhost:3000/v1/geocode?q=milady%20horakove+334/36&limit=1' # -> Milady Horákové 334/36
curl -s 'localhost:3000/v1/geocode?q=Brno%20Main%20Train%20Station' # -> Brno hlavní nádraží
curl 'localhost:3000/v1/geocode?lat=49.1922&lon=16.6113&limit=1' # -> Brno, CZ, center: [16.6113382,49.1922443]
```

### Build Europe

This takes time and resources - it's a stress test, which I ran twice, rather than for quick local development.

```sh
make all COUNTRIES=@europe        # all 42, ~30 GB of extracts, 42m47s
make serve                        # one thread, boots in 908 ms
make serve-pool                   # the same index, one request thread per core
```

Europe's memory and throughput figures used to sit on those lines. They have been dropped rather than restated: they predate folding anchor names into the index at build time, which grew the artifact and changed both, and that index is no longer on disk to re-measure. Every serving figure below is the world index.

### Build the World

Built and served, not calculated. The catalogue holds every country Geofabrik publishes — 189 extracts, 77 GB — and `@world` names all of them:

```sh
make all COUNTRIES=@world MEM_GB=26   # fetch + records + index, about 2h15
make serve-pool                        # 189 countries, one thread per core
```

| | |
| --- | --- |
| extracts | 189 countries, 77 GB downloaded |
| extract stage | 1h19, peak 27.7 GB resident, producing 12.2 GB of records |
| index stage | 36m, peak 31.9 GB resident (22.1 GB live), producing an 11.0 GB index |
| whole build | 1h55 of compute, or about 2h15 with the download; peak 31.9 GB resident, in the index stage |
| index contents | 58.5M anchors, 173.8M addresses, 25.8M POIs, 9.6M search terms, 34.5M strings |
| serving it | 11.2 GB resident at one thread, 11.7 GB at eight, 15.3 GB at its peak under load; 2.3 s to boot |

Both stages run under `MEM_GB`, which is what makes this a laptop job rather than a cloud one — see [Building Within the RAM You Have](#building-within-the-ram-you-have). The index stage's 31.9 GB is macOS's peak resident figure and counts pages the collector has already released; the live heap peaked at 22.1 GB, and a tighter ceiling trades CPU for the difference.

**Build it from country extracts, not from `planet-latest.osm.pbf`.** Resolving way geometry needs the node ids each selected way refers to, and their locations, held while the file streams past: the United States alone needs 132M of them. Those arrays scale with the file being read, not with the machine, so one planet file would want tens of gigabytes for that step and no ceiling can help — the data has to be live. Country extracts bound it by the largest country instead, which is why the run above peaks where it does.

Adding countries needs no hand-editing: `scripts/refresh-catalog.sh` reads Geofabrik's published index.

```sh
scripts/refresh-catalog.sh list asia    # what is available
scripts/refresh-catalog.sh add jp kr    # add two by ISO code
scripts/refresh-catalog.sh add-all      # every country on earth
```

Saudi Arabia is the one gap in `@world`, and it is Geofabrik's: they publish no extract for it.

What it serves per second, and what a thread of it costs in memory, is under [Serving on Every Core](#serving-on-every-core).

## Architectural Decisions

The server ([`./server`](./server), written in TypeScript) consumes a static index - never mutating it, which is also what lets every request thread share one copy of it in memory. All expensive operations are done once at build time, in the [`ingest`](ingest) pipeline written in Go: pbf decoding, way geometry resolution, Unicode folding, street grouping, deduplication.

### Ordered Lists over Single Unique Matches

The task reads (at least to me) as though each direction should return one precise match. This implementation is a superset of that.

This is a deliberate architecture decision, coming from how I imagine the main applications of a geocoder. If someone enters an address or place name, they probably won't do it perfectly and multiple places can have the same name/ share parts of names. And given a lat/lon, perhaps coming from a cursor click or finger tap on a point on a map, there could be a few candidate places matching the point selected by a human user.

Setting `limit=1` achieves the single match behaviour if desired, so this decision loses nothing. Enabling a longer list of candidate matches felt like the more useful approach.

### Why an Index

Photon and Pelias use ElasticSearch - that would be a reasonable choice. Against that: a geocoder answers a narrow set of query shapes, and building an index exactly for that can get results on a single process and single file rather than a cluster. It also achieves low RAM requirements and boot time in under a second, with lookup latency of less than a millisecond for a house number or a reverse lookup, and just a few milliseconds for text.

### Index Structure

The index is a directory of flat little-endian arrays and a small JSON manifest, laid out so that every file maps one-to-one onto a JavaScript typed array (see [`ingest/internal/index/format.go`](ingest/internal/index/format.go)).

The whole shape follows from a single decision: the server never writes to the index, so nothing in it has to support insertion. That's a strong constraint - and it allows us to support autocomplete with fewer datastructures and less RAM.

Three arrangements build all forty-odd files: a column (a fixed-width array indexed by id), a blob with its `n + 1` bounds (anything variable length, sliced without a pointer), and a *sorted* blob with its bounds. Sorted arrays do the work of trees, and the same term dictionary serves both exact lookup and prefix range by binary search, which is what makes autocomplete cheap. A term id is a position in that sorted order, so one integer is at once the key into every parallel column and an order-preserving encoding of the string - testing whether a term begins with "pra" is two integer comparisons against an interval. That dictionary is also how an anchor stores its own name: `anchor_terms.bin` holds the term ids its name and locality fold to, so scoring compares integers and the server never folds a string at query time - the fold happens once, at build time, for everyone. Offsets do the work of pointers, so a term's posting list is a slice of one long array of ascending anchor ids and a multi-token query is a linear intersection. Anchor fields live in one array each rather than in records, so a query touches only the fields it actually reads. House numbers sit in sorted runs behind their anchor, keyed on the number's leading integer, so finding 248 on a street with thousands of addresses is another binary search - and keeping them out of the term dictionary is what stops "1" becoming a posting list of 4.8M addresses. Coordinates are int32 fixed point at roughly a centimetre, which halves the space against float64, keeps comparisons exact, and lets point-in-polygon run directly on the stored integers.

The spatial structures are precomputed on the same principle. The k-d tree ships as a permutation of point ids with its structure implicit in their order, so the server builds nothing at startup. Loading is then a read and a cast rather than a parse - 119 ms for 14M addresses, 908 ms for 90M - and resident memory stays close to the artifact size.

### Geocoding

The geocoding follows from the data structure (well, also vice-versa). What
follows is the summary; [`docs/forward-geocoding.md`](docs/forward-geocoding.md)
and [`docs/reverse-geocoding.md`](docs/reverse-geocoding.md) walk the same two
paths in full, from the OSM tags that made the index to the ordering of the
answer, with a code link at each step.

A forward query is folded, split, looked up, then scored twice. Folding ([`packages/core/src/normalize.ts`](packages/core/src/normalize.ts)) strips diacritics, transliterates Cyrillic and expands street-type abbreviations, so "Plzen" and "Plzeň" reduce to the same token; the same rules run at build time in Go ([`ingest/internal/norm/norm.go`](ingest/internal/norm/norm.go)), with a 4,000-name fixture generated by the Go side asserting the TypeScript reproduces it exactly. Where two spellings are both correct and folding cannot converge them - German writes "München" and "Muenchen", "Schloßstraße" and "Schlosstraße" - the build indexes the alternatives as extra terms beside the canonical one, and the query widens to the forms it can infer from what was typed; every spelling reaches the name, and the exact one still scores best. Parsing ([`server/src/query.ts`](server/src/query.ts)) separates a house number from the name, since "3 Maja" is a street and "Marszalkowska 12" is not. The number is matched as a whole run in the raw text rather than as a token, because folding splits "78-52", "213號", "5/B" and "334/36" in two and throws the punctuation away; a postcode is recognised and dropped for the same reason, since nothing is searchable by one. Lookup ([`server/src/terms.ts`](server/src/terms.ts)) resolves every token but the last exactly and the last as a prefix range (a token with alternative spellings resolving to the union of them), then intersects the posting lists - that gives a candidate set and a text weight from array reads alone.

Scoring happens in two passes, with crude scoring providing an A*-style upper bound, because precise scoring is expensive: it has to fold each candidate's name and every alias it carries. The cheap pass ([`server/src/ranking.ts`](server/src/ranking.ts)) multiplies the text weight by an importance prior, all array reads, so it can afford to run on every candidate. Each candidate gets an upper bound on what it could possibly score, candidates are visited in bound order, and the scan stops once the best remaining bound can't beat the worst result already held ([`server/src/forward.ts`](server/src/forward.ts)). A three-character prefix retrieves 23,251 candidates and only needs to fully scores 79 of them to guarantee finding the best. Within the winning anchor, the house number is then found inside it by binary search ([`server/src/housenumber.ts`](server/src/housenumber.ts)) - allowing for the fact that a Czech building carries two numbers and is addressed by either the pair or the second alone.

A misspelling gets one retry, and only after an exact search has found nothing ([`server/src/fuzzy.ts`](server/src/fuzzy.ts)). A term within one edit of the query must share either its first half as a prefix or its second half as a suffix, so both halves are binary searches - the second against a reversed copy of the term dictionary.

Reverse geocoding asks two questions and uses a different structure for each. "Is this point within a polygon/ multipolygon?" uses a uniform cell grid for feature bounding boxes lookup, and ray casting on the stored integers ([`server/src/geometry.ts`](server/src/geometry.ts)) confirms whether the point is within the polygon/ place. Those places are the first results returned, since the point is actually within them, ordered from smallest to largest since a particular lake within a park is assumed to be more informative than the park it is in. "What places are near this point?" is answered with a k-d tree search ([`server/src/pointindex.ts`](server/src/pointindex.ts)) from the query point, with places sorted by distance ([`server/src/reverse.ts`](server/src/reverse.ts)).

### Serving on Every Core

A geocode is pure CPU. There is no I/O inside a query to yield on, so one Node thread serves them strictly one at a time and the service tops out at 1 / service time no matter how large the machine is - a few hundred a second for text search.

The fix is a thread per core, and the reason it can be threads rather than processes is the index itself. It is read-only after load and, for the whole world, 11.0 GB of it. So [`server/src/artifact.ts`](server/src/artifact.ts) reads each file straight into a `SharedArrayBuffer` and [`server/src/pool.ts`](server/src/pool.ts) hands that bundle to every worker, which wraps it in typed-array views of the same bytes. A thread costs an event loop, a Fastify instance and a V8 heap, not another copy of the index. Audited rather than assumed: every array the query code reads is a view on a `SharedArrayBuffer`, 11.088 GB of them, and the only per-thread objects are the manifest, a 189-entry country table and two empty caches.

#### What a thread actually costs

| threads | idle | peak under load | settled afterwards |
| ---: | ---: | ---: | ---: |
| 1 | 11.23 GB | 11.73 GB | 11.32 GB |
| 8 | 11.66 GB | 15.30 GB | 12.24 GB |
| 16 | 11.94 GB | 19.01 GB | 13.33 GB |

So ~47 MB per thread resident before it does anything, and ~485 MB at peak while it is serving - and it is the second number a deployment has to be sized on, since that is what an OOM killer sees. The peak is whatever the traffic is: the run above walks every profile in the table below, and under the mixed profile alone the same three thread counts peak at 11.51, 13.45 and 15.23 GB. Sixteen threads still beat sixteen processes, which would have started at 180 GB before serving a request, but "the index is shared so threads are nearly free" would be an overstatement.

Where the ~485 MB goes, in decreasing order:

- **The V8 heap under load** - in-flight GeoJSON objects and the JSON being serialised from them. This is most of it, and it is transient: peak falls back to 13.33 GB at sixteen threads within a minute of the traffic stopping. Bounding it is a `resourceLimits.maxOldGenerationSizeMb` away, at the risk of turning a memory spike into a dead worker.
- **~55 MB of idle floor** - the isolate, the Fastify instance, the compiled AJV validators and `fast-json-stringify` serializers, the OpenAPI document and the docs bundle, all built once per thread. Measured against the 676 KB demo index, where the index itself is a rounding error: 146 MB at one thread, 973 MB at sixteen.
- **The decoded-string cache**, per thread because a JavaScript string cannot be shared, and capped. (An earlier version was an array slot per entry - 8 bytes x however many strings the index holds, whether or not they were ever asked for, allocated eagerly per thread. On the 42-country index that alone was 2.5 GB across sixteen threads, more than half the index; on the world's 34.5M strings it would be 4.4 GB, and it is why the cache is a capped map instead.)

Each worker runs a complete Fastify instance on its own HTTP server (supplied through Fastify's `serverFactory`), and there is no dispatcher in front of them: the kernel does the balancing. On Linux each worker binds its own socket with `SO_REUSEPORT` and the kernel hashes connections across them. macOS has `SO_REUSEPORT` but does not load-balance it, and Node rejects the option outright, so the pool falls back to the pre-fork model - the first worker binds, the rest accept on its descriptor, which they can because threads share a descriptor table. The strategy is probed at boot, not assumed.

Thread count defaults to `availableParallelism()`, which reads the cgroup quota, so `docker run --cpus=4` starts four threads on a 14-core host rather than fourteen fighting over four. `WORKERS` overrides it, and `WORKERS=1` is the old single-threaded process exactly.

Two consequences worth knowing. A connection belongs to one worker for its lifetime, so load balance is connection balance and a single keep-alive client uses a single thread. And the rate limiter counts per thread, which is deliberate - dividing the budget would throttle a real user mid-word, since keep-alive pins them to one thread - so the aggregate ceiling is now up to `workers x RATE_LIMIT_MAX`.

#### What it actually serves

Measured with [`server/loadtest.mjs`](server/loadtest.mjs) against the world index (58.5M anchors, 173.8M addresses) on an M4 Max - 12 performance cores, 4 efficiency cores, 48 GB - with the load generator on the same machine. Requests per second, closed-loop at 96 connections:

| query shape | 1 thread | 8 threads | 16 threads | speedup at 8 | per thread |
| --- | ---: | ---: | ---: | ---: | ---: |
| reverse, filtered to a far-off country | 59,397 | 168,320 | 164,447 | 2.8x | 0.05 ms |
| reverse, lat/lon | 10,290 | 78,024 | 89,599 | 7.6x | 0.10 ms |
| full city name | 489 | 3,689 | 5,267 | 7.5x | 2.2 ms |
| street + house number | 545 | 3,633 | 5,234 | 6.7x | 2.2 ms |
| all-common-word names | 163 | 1,107 | 1,622 | 6.8x | 7.2 ms |
| mixed traffic | 127 | 824 | 1,205 | 6.5x | 9.7 ms |
| 5,000 distinct real names, one per request | 113 | 546 | 764 | 4.8x | 14.7 ms |
| reverse at max radius and page size | 71 | 508 | 765 | 7.2x | 15.7 ms |
| 3-character autocomplete prefix | 75 | 488 | 682 | 6.5x | 16.4 ms |

A fresh server for every row, which is a correction to how I measured this before. Nine profiles in one process does not measure the last of them: `heavy` and `diverse` leave a heap the next profile pays to collect, and the harness's five second gap is not enough. Measured side by side, autocomplete read 346 rps at eight threads running eighth in the queue against 487 running first, and mixed 610 against 809. Every row above ran first in its own process.

Every row but one cycles a handful of queries, which is the friendliest traffic there is for anything cached per thread. The `diverse` row does not: 5,000 distinct names sampled from the index, one per request, which is what a search box actually sends. On a world index that row is also the one carrying names from every language at once, and it is the slowest text shape after a bare prefix.

Scaling the mixed profile by thread count: 131, 253, 468, 680, 863, 1033, 1161, 1206 rps at 1, 2, 4, 6, 8, 10, 12, 16 threads. That is 8.9x at twelve threads and 9.2x at sixteen, on a box with twelve performance cores and four efficiency cores that is also running the load generator - the curve bends where the machine runs out of cores, not where the server does. Resident memory over the same sweep, *idle*: 11.23, 11.31, 11.45, 11.58, 11.68, 11.64, 11.74, 11.92 GB - 690 MB of spread across fifteen extra threads, over an 11 GB index they share. See the table above for what it reaches while serving.

The same sweep in a container, scaling the CPU allocation rather than the thread count, gave 154, 304, 561, 1010 rps at `--cpus` 1, 2, 4, 8 - so a deployment gets what it pays for, and `docker stats` showed 4.24, 4.37, 4.52, 4.84 GiB at rest, the index being shared rather than replicated. That one is against the 42-country index and has not been repeated: what it demonstrates is the cgroup quota being read and the shared index not being copied, neither of which the size of the index changes.

**Reverse is essentially free** and text search is not, by two orders of magnitude. A deployment serving mostly map clicks and one serving mostly autocomplete need very different sizing, which is why the table is per shape and the blended figure carries a stated mix.

### Container Image

The Dockerfile has a two stage build: the builder compiles the TypeScript and resolves production-only dependencies, and the runtime stage copies just the output across, leaving a 61 MB image with just the node runtime and server. The index is deliberately not built during the runtime image build - that would drag 3.5 GB of extracts and the Go toolchain into a parent layer for an artifact that is immutable once written, and shared by every replica/ deployment. `make docker` leaves the index outside the image, to be mounted from the host at `/index`, while `make docker-bundled` copies it into the image so the container needs no volume - at the cost of carrying an extra 473.


## Tech Stack Rationale

### Ingest

The ingest pipeline is built in Go. It could have been done in Java, Rust or C++ (and could be ported to any of those languages), and I choose Go mostly on personal preference/ perceived readability and less frequent need for maintenance/ overhauls. The pipeline is just a batch job that reads 3.5-88 GB of binary input and writes a binary file. Its weight is in file operations, RAM and CPU computation. Go is particularly good for concurrency - the decode parallelises for free. `paulmach/osm` decodes pbf blobs across goroutines, and the scan phases sustain 870–1250% CPU on a 16-core machine, with the whole build averaging about 300%. And in practice my maintainability expectation seems to hold (though I haven't tested the counterfactual in Java/ C++) - there are only 2 external dependencies. The toolchain for formatting, vetting, testing and benchmarking is inbuilt and great.

Note: C, C++ and Rust without garbace collection would likely offer the best performance, at a code complexity and maintenance cost. Java would probably get similar computational performance to Go, with more complex and verbose code, more dependencies and higher maintenance cost. The Go ingest pipeline performance seems pretty good already, with further optimization possible within the language.

See the implementation at [`./ingest`](./ingest).

### Server

The server ([`./server`](./server)) is implemented in TypeScript/ NodeJS. Many languages would work there, but TypeScript has important advantages over all others - everything downstream integrating with it is probably JavaScript.

See [`./packages/core`](./packages/core) - dependency-free and browser-buildable, supplying the response types and the index's query normalizer, simplifying (and improving robustness and completeness of) client any integrations.


## Future Improvements and Scale

Many!
- forward geocoding could benefit from setting a locality bias, based on the user's map viewport or the particular application
- depending on application, filtering places/ features by type or metadata may make sense
- this API returns ranked places for a lat/lon or text input, but the ranking/ weights would deserve better calibration & regression testing (for both code changes and data ingestion)
- the current rate limiting should be eliminated, and replaced with API keys/ user-based usage restriction
- make it possible for a running server to pick up a new index without downtime
- actually deploy this to a chosen cloud infrastructure (along with some CD setup)
- there is no load shedding: a saturated pool queues rather than refusing, where returning 503 with Retry-After off an event-loop-delay watch would be both cheaper and more honest to the client
- a worker that dies takes the process down with it, because the listening socket cannot be handed to a replacement without redoing the bind; a supervisor restart covers it, but in-flight requests are lost
- graceful shutdown drains nothing: under the shared-descriptor fallback the listening socket belongs to all the threads at once, so they are stopped together
- we could further increase throughput, if we were lucky enough to have to, by setting up horizontal scaling
- in production, observability beyond structured logs would be nice
- explore caching and CDN layer (e.g. for handling an autocomplete load)
- broad prefixes still build a candidate map over every posting of a very common term ("de" alone reaches 2.3M), which the search then discards; champion lists — a short, importance-ordered posting list per high-frequency term — would bound that and improve the answers, at an index format change
- more data beyond OSM
- it would be nice to have a frontend map UI consuming this API - to catch any bugs, get a gauge of its usefulness and prioritize further work

Based on global OSM data alone, and an 11 GB index, it doesn't look like there'd be any need to shard geographically (OVH has servers with 2 TB of RAM, and AWS/ GCP have 32 TB servvers). Cheap generic servers can carry the world - and since the index is shared memory rather than a copy per thread, a bigger server is genuinely bought by the core rather than by the core-plus-a-copy-of-the-index.





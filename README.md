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
make all COUNTRIES=@europe        # all 42, ~30 GB of extracts, 42m47s; building requires 31.1 GB of RAM
make serve                        # boots in 908 ms; runnning requires 4.86 GB of RAM
make serve-pool                   # the same index, one request thread per core — 4.28 GB idle, ~290 MB a thread under load
```

### Build the World

In principle, an index for the whole world should fit into under 8 GB of RAM (calculated, not tested). Building it will require more RAM and time however - I haven't explored how far we can get there with an ordinary laptop.

```sh
curl -O https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf
mv planet-latest.osm.pbf data/raw/
printf 'planet\tplanet\t%s\tPlanet\n' "$(stat -f%z data/raw/planet-latest.osm.pbf)" \
  >> config/countries.tsv

make records index COUNTRIES=planet
make serve
```


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

Sorted arrays do the work of trees, and the same term dictionary serves both exact lookup and prefix range by binary search, which is what makes autocomplete cheap. That dictionary is also how an anchor stores its own name: `anchor_terms.bin` holds the term ids its name and locality fold to, so scoring compares integers and the server never folds a string at query time - the fold happens once, at build time, for everyone. Offsets do the work of pointers, so a term's posting list is a slice of one long array of ascending anchor ids and a multi-token query is a linear intersection. Anchor fields live in one array each rather than in records, so a query touches only the fields it actually reads. House numbers sit in sorted runs behind their anchor, keyed on the number's leading integer, so finding 248 on a street with thousands of addresses is another binary search. Coordinates are int32 fixed point at roughly a centimetre, which halves the space against float64, keeps comparisons exact, and lets point-in-polygon run directly on the stored integers.

The spatial structures are precomputed on the same principle. The k-d tree ships as a permutation of point ids with its structure implicit in their order, so the server builds nothing at startup. Loading is then a read and a cast rather than a parse - 119 ms for 14M addresses, 908 ms for 90M - and resident memory stays close to the artifact size.

### Geocoding

The geocoding follows from the data structure (well, also vice-versa).

A forward query is folded, split, looked up, then scored twice. Folding ([`packages/core/src/normalize.ts`](packages/core/src/normalize.ts)) strips diacritics, transliterates Cyrillic and expands street-type abbreviations, so "Plzen" and "Plzeň" reduce to the same token; the same rules run at build time in Go ([`ingest/internal/norm/norm.go`](ingest/internal/norm/norm.go)), with a 4,000-name fixture generated by the Go side asserting the TypeScript reproduces it exactly. Where two spellings are both correct and folding cannot converge them - German writes "München" and "Muenchen", "Schloßstraße" and "Schlosstraße" - the build indexes the alternatives as extra terms beside the canonical one, and the query widens to the forms it can infer from what was typed; every spelling reaches the name, and the exact one still scores best. Parsing ([`server/src/query.ts`](server/src/query.ts)) separates a house number from the name, since "3 Maja" is a street and "Marszalkowska 12" is not. Lookup ([`server/src/terms.ts`](server/src/terms.ts)) resolves every token but the last exactly and the last as a prefix range (a token with alternative spellings resolving to the union of them), then intersects the posting lists - that gives a candidate set and a text weight from array reads alone.

Scoring happens in two passes, with crude scoring providing an A*-style upper bound, because precise scoring is expensive: it has to fold each candidate's name and every alias it carries. The cheap pass ([`server/src/ranking.ts`](server/src/ranking.ts)) multiplies the text weight by an importance prior, all array reads, so it can afford to run on every candidate. Each candidate gets an upper bound on what it could possibly score, candidates are visited in bound order, and the scan stops once the best remaining bound can't beat the worst result already held ([`server/src/forward.ts`](server/src/forward.ts)). A three-character prefix retrieves 23,251 candidates and only needs to fully scores 79 of them to guarantee finding the best. Within the winning anchor, the house number is then found inside it by binary search ([`server/src/housenumber.ts`](server/src/housenumber.ts)).

A misspelling gets one retry, and only after an exact search has found nothing ([`server/src/fuzzy.ts`](server/src/fuzzy.ts)). A term within one edit of the query must share either its first half as a prefix or its second half as a suffix, so both halves are binary searches - the second against a reversed copy of the term dictionary.

Reverse geocoding asks two questions and uses a different structure for each. "Is this point within a polygon/ multipolygon?" uses a uniform cell grid for feature bounding boxes lookup, and ray casting on the stored integers ([`server/src/geometry.ts`](server/src/geometry.ts)) confirms whether the point is within the polygon/ place. Those places are the first results returned, since the point is actually within them, ordered from smallest to largest since a particular lake within a park is assumed to be more informative than the park it is in. "What places are near this point?" is answered with a k-d tree search ([`server/src/pointindex.ts`](server/src/pointindex.ts)) from the query point, with places sorted by distance ([`server/src/reverse.ts`](server/src/reverse.ts)).

### Serving on Every Core

A geocode is pure CPU. There is no I/O inside a query to yield on, so one Node thread serves them strictly one at a time and the service tops out at 1 / service time no matter how large the machine is - a few hundred a second for text search.

The fix is a thread per core, and the reason it can be threads rather than processes is the index itself. It is read-only after load and, for the 42 countries, 4.4 GB of it. So [`server/src/artifact.ts`](server/src/artifact.ts) reads each file straight into a `SharedArrayBuffer` and [`server/src/pool.ts`](server/src/pool.ts) hands that bundle to every worker, which wraps it in typed-array views of the same bytes. A thread costs an event loop, a Fastify instance and a V8 heap, not another copy of the index. Audited rather than assumed: every array the query code reads is a view on a `SharedArrayBuffer`, 4.458 GB of them, and the only per-thread objects are the manifest, a 42-entry country table and two empty caches.

#### What a thread actually costs

| threads | idle | peak under load | settled afterwards |
| ---: | ---: | ---: | ---: |
| 1 | 4.85 GB | 5.09 GB | 4.96 GB |
| 8 | 5.30 GB | 6.60 GB | 5.56 GB |
| 16 | 5.93 GB | 8.54 GB | 6.32 GB |

So ~72 MB per thread resident before it does anything, and ~230 MB at peak while it is serving - and it is the second number a deployment has to be sized on, since that is what an OOM killer sees. Sixteen threads still beat sixteen processes, which would have started at 78 GB before serving a request, but "the index is shared so threads are nearly free" would be an overstatement.

Where the ~290 MB goes, in decreasing order:

- **The V8 heap under load** - in-flight GeoJSON objects and the JSON being serialised from them. This is most of it, and it is transient: peak falls back to 6.11 GB at sixteen threads within a minute of the traffic stopping. Bounding it is a `resourceLimits.maxOldGenerationSizeMb` away, at the risk of turning a memory spike into a dead worker.
- **~68 MB of idle floor** - the isolate, the Fastify instance, the compiled AJV validators and `fast-json-stringify` serializers, the OpenAPI document and the docs bundle, all built once per thread. Measured against the 676 KB demo index, where the index itself is a rounding error: 175 MB at one thread, 1124 MB at sixteen.
- **The decoded-string cache**, per thread because a JavaScript string cannot be shared, and capped. (An earlier version was an array slot per entry - 8 bytes x 13.9M strings whether or not they were ever asked for, allocated eagerly per thread. That alone was 2.5 GB across sixteen threads, more than half the index, and it is why the cache is a capped map instead.)

There used to be a second, larger cache here: the folded tokens of each anchor's names, at ~140 MB a thread. It is gone, because the fold moved into the artifact - see [The Fold Belongs in the Index](#the-fold-belongs-in-the-index). Per-thread peak went from ~290 MB to ~230 MB, at the cost of 0.6 GB of shared index, which pays for itself at about ten threads.

Each worker runs a complete Fastify instance on its own HTTP server (supplied through Fastify's `serverFactory`), and there is no dispatcher in front of them: the kernel does the balancing. On Linux each worker binds its own socket with `SO_REUSEPORT` and the kernel hashes connections across them. macOS has `SO_REUSEPORT` but does not load-balance it, and Node rejects the option outright, so the pool falls back to the pre-fork model - the first worker binds, the rest accept on its descriptor, which they can because threads share a descriptor table. The strategy is probed at boot, not assumed.

Thread count defaults to `availableParallelism()`, which reads the cgroup quota, so `docker run --cpus=4` starts four threads on a 14-core host rather than fourteen fighting over four. `WORKERS` overrides it, and `WORKERS=1` is the old single-threaded process exactly.

Two consequences worth knowing. A connection belongs to one worker for its lifetime, so load balance is connection balance and a single keep-alive client uses a single thread. And the rate limiter counts per thread, which is deliberate - dividing the budget would throttle a real user mid-word, since keep-alive pins them to one thread - so the aggregate ceiling is now up to `workers x RATE_LIMIT_MAX`.

#### What it actually serves

Measured with [`server/loadtest.mjs`](server/loadtest.mjs) against the 42-country index (23.3M anchors, 90.2M addresses) on an M4 Max, 12 performance cores, with the load generator on the same machine. Requests per second, closed-loop at 96 connections:

| query shape | 1 thread | 8 threads | speedup | per thread |
| --- | ---: | ---: | ---: | ---: |
| reverse, filtered to a far-off country | 59,750 | 162,644 | 2.7x | 0.02 ms |
| reverse, lat/lon | 10,362 | 79,198 | 7.6x | 0.10 ms |
| street + house number | 569 | 3,701 | 6.5x | 2.2 ms |
| full city name | 491 | 3,350 | 6.8x | 2.4 ms |
| 5,000 distinct real names, one per request | - | 2,187 | - | 3.7 ms |
| all-common-word names | 183 | 1,292 | 7.1x | 6.2 ms |
| mixed traffic | 161 | 981 | 6.1x | 8.2 ms |
| 3-character autocomplete prefix | 93 | 572 | 6.2x | 14.0 ms |
| reverse at max radius and page size | 63 | 460 | 7.3x | 15.9 ms |

Every row but one cycles a handful of queries, which is the friendliest traffic there is for anything cached per thread. The `diverse` row does not: 5,000 distinct names sampled from the index, one per request, which is what a search box actually sends.

Scaling the mixed profile by thread count: 173, 323, 593, 863, 1050, 1219, 1397, 1513 rps at 1, 2, 4, 6, 8, 10, 12, 16 threads. That is 8.1x at twelve threads and 8.8x at sixteen, on a box with twelve performance cores and four efficiency cores that is also running the load generator - the curve bends where the machine runs out of cores, not where the server does. Resident memory over the same sweep, *idle*: 4.28, 4.40, 4.59, 4.61, 4.73, 4.94, 4.80, 5.37 GB - see the table above for what it reaches while serving.

The same sweep in a container, scaling the CPU allocation rather than the thread count, gives 154, 304, 561, 1010 rps at `--cpus` 1, 2, 4, 8 - so a deployment gets what it pays for, and `docker stats` shows 4.24, 4.37, 4.52, 4.84 GiB at rest, the index being shared rather than replicated.

**Reverse is essentially free** and text search is not, by two orders of magnitude. A deployment serving mostly map clicks and one serving mostly autocomplete need very different sizing, which is why the table is per shape and the blended figure carries a stated mix.

### The Expensive Tail

Two query shapes used to cost 100x what they should, and both turned out to be implementation, not the price of the answer. The measurements below are single-threaded and against the 42-country index.

**Names made entirely of common words.** "Rue de la Paix" took 249ms, of which 242ms was retrieval — it reranked only 78 candidates and returned 1,764. Its three complete tokens hold 1.1M, 2.3M and 1.2M postings, and membership was being tested by building a `Set` from each: 4.6M insertions to discard 4.6M of them. Posting lists are written in ascending anchor order, so membership is a binary search and needs nothing built at all; and the walk should start from whichever candidate set is smallest, which for this query is the last token. 249ms became 1.2ms, and "Rue du General de Gaulle" 191ms became 2.0ms. As a load profile it went from 200 to 1,310 requests a second.

**A reverse search filtered to a country that is nowhere near the point.** `country=pt` clicked on Berlin took 110ms against 0.04ms unfiltered — 2,750x — because the filter rejects every candidate, so the radius escalates to its 50km cap and the final sweep measures every point in a 100km box around a dense city before discarding all of them. The fix is to know where each country is: [`coverage()`](server/src/reverse.ts) records a bounding box per country in the pass it already makes at boot, built from anchor extents and every address hanging off them, so it can never rule out a match the search would have found. Four comparisons settle it. 110ms became 0.001ms, and over a sweep of the whole coverage box the mean went from 2.58ms to 0.008ms and the worst case from 179ms to 2.65ms.

What is *not* expensive, contrary to the obvious guess: clicking on nothing. A point in the mid-Atlantic, the Baltic, or the Arctic costs 0.01-0.28ms, less than a click on central Prague, because an empty region is where a k-d tree prunes hardest. Over 4,000 uniform points in the coverage box, reverse geocoding at the default radius averages 0.020ms with a worst case of 1.04ms. It follows that giving up when nothing is within a few hundred metres would buy nothing and cost a great deal: of the points that do get an answer, 82% get it from beyond 200m, and they are real answers — a village 0.2km from a field, a converter station 12.8km off the Dutch coast.

What remains, and is left alone deliberately: a reverse query that asks for 50 results within 50km from a point in open water near a dense coast really does have to sweep a 100km box, and costs ~16ms of thread time. That is under twice a three-character autocomplete, it needs the client to ask for both the maximum radius and the maximum page size, and every way of capping it - a visit budget, an early cut-off - trades a real result for the saving. The honest containment for that shape is load shedding on event-loop delay rather than second-guessing the query.

### Addresses That Are Not European

Two shapes the folding got wrong, both found by asking rather than assuming.

**The number leads in the English-speaking world.** "10 Downing Street" folded to `[10, downing]` - a name reading, since a leading digit was treated as part of the name on the grounds that "3 Maja" is a Polish street and "17 Novembre" a French one. But no street's *name* contains "10", so the query asked the index for something that cannot exist and got nothing back. Parsing now offers a leading-number reading too, last of the candidates: the whole-query reading still gets first refusal, so "3 Maja" resolves to Plac 3 Maja and "10 Downing Street" to 10 Downing Street, London.

**Japanese and Chinese are written without spaces.** The folder's last pass turns everything that is not a letter or a number into a separator, which finds no boundary at all in 東京都千代田区千代田: the whole address arrived as one token, so a query for 千代田区 would have had to reproduce the entire string to match anything. Runs of Han, Hiragana and Katakana are now cut into overlapping bigrams - 千代, 代田, 田区 - so a part of a name shares tokens with the whole of it, and the ordinary AND across query tokens does the rest. It is what Lucene's CJK analyzer does, and it needs no dictionary, which a geocoder rebuilt from a planet extract cannot carry. Hangul is deliberately left alone: Korean is written with spaces, so the existing split already finds its boundaries.

Two smaller things came with it. Folding moved from NFD to NFKD, so the full-width digits a Japanese address is written with ("１丁目") reach the ASCII ones, half-width katakana reaches full-width, and Ⅻ, ﬁ, ² and № become letters a keyboard can produce rather than characters nobody can type. And the two Japanese voicing marks are now spared from the diacritic strip: they are combining marks by category, but dropping U+3099 folds ば onto は, which is a different word, where dropping a háček is the whole point.

The script ranges are hard-coded rather than taken from `unicode.Is(unicode.Han, r)` and `\p{Script=Han}`, because those are Unicode-version dependent on each side and the two sides have to agree exactly, forever.

### The Fold Belongs in the Index

Scoring a candidate meant folding its name and every alias it carries - `TextDecoder`, NFD, a regex, a character loop, several allocations deep - and it happened per candidate, per request, per thread. It was expensive enough to need a cache, and that cache was ~140 MB per thread, replicated across the pool, each copy warming from cold independently.

But the fold is the same answer every time, and the term dictionary already contains it. So [`anchor_terms.bin`](ingest/internal/index/format.go) now stores, per anchor, the *term ids* its locality and each of its name variants fold to. Scoring compares integers: an exact query token is an id equality, a prefix token is a range check, because retrieval has already resolved the prefix to a range of the dictionary. Measured against 200,000 random anchors, reading the stored ids costs **45 ns a candidate where folding the names cost 2,579 ns** - the same token counts, 57x apart.

End to end the throughput gain is modest, and the honest reason is that the benchmark flatters what it replaced: cycling twelve queries gives a per-thread cache a ~100% hit rate, so the 2.6 µs was mostly not being paid. On the diverse profile, where it would have been, the new path is insensitive to it. What is unambiguous is the memory - ~290 MB a thread down to ~230 MB, for 0.6 GB of shared index - and what came with it:

**The artifact is now its own contract fixture.** The index contains what Go folded; the server folds the same names in TypeScript; a test compares them. Not 4,000 sampled names but 23.3 million real ones - and the first run found three bugs that the fixture had missed for the life of the project:

- `unicode.IsDigit` is category Nd, where the TypeScript port's `\p{N}` is Nd, Nl and No. "Třeboň Ⅱ" folded to one token in Go and two in TypeScript, so the index held a term the query never asked for. 6,465 anchors.
- Go lowercases Σ to σ wherever it stands; JavaScript applies the contextual rule and gives ς at the end of a word. Every Greek name in capitals folded two ways.
- Go sorts the term dictionary by code point; the server binary-searches it with JavaScript's `<`, which compares UTF-16 code units. The two disagree above the BMP, where a surrogate pair begins 0xD800 and sorts below everything from U+E000 up - so a lookup whose path crossed an astral term could take the wrong branch and come back empty. It is the kind of bug that stays invisible in Europe and would have arrived with the first planet build.

Two more turned up in the build itself, both caught by the same assertion: an anchor kept a higher-ranked duplicate's alternate names while its tokens were replaced, so it advertised aliases it was not indexed under; and `geoindex` trusted the token list serialized into the record stream, so a normalizer change needed a re-extract to take effect rather than a re-index. Both are fixed, and the fold-vector fixture keeps its job - it is just no longer the only thing standing between the two implementations.

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
- we could probably use less RAM when building - it'd be worth exploring optimizations there if we want to do planet scale builds
- incremental builds (ingesting changes rather than everything) could speed up production builds
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

Based on global OSM data alone, and a <8 GB index, it doesn't look like there'd be any need to shard geographically (OVH has servers with 2 TB of RAM, and AWS/ GCP have 32 TB servvers). Cheap generic servers can carry the world - and since the index is shared memory rather than a copy per thread, a bigger server is genuinely bought by the core rather than by the core-plus-a-copy-of-the-index.





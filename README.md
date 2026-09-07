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
make all COUNTRIES=@europe        # all 41, ~30 GB of extracts, 42m47s; building requires 31.1 GB of RAM
make serve                        # boots in 908 ms; runnning requires 4.86 GB of RAM
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

The server (`./server`, written in TypeScript) consumes a static index - never mutating it. All expensive operations are done once at build time, in the `ingest` pipeline written in Go: pbf decoding, way geometry resolution, Unicode folding, street grouping, deduplication.

### Ordered Lists over Single Unique Matches

The task reads (at least to me) as though each direction should return one precise match. This implementation is a superset of that.

This is a deliberate architecture decision, coming from how I imagine the main applications of a geocoder. If someone enters an address or place name, they probably won't do it perfectly and multiple places can have the same name/ share parts of names. And given a lat/lon, perhaps coming from a cursor click or finger tap on a point on a map, there could be a few candidate places matching the point selected by a human user.

Setting `limit=1` achieves the single match behaviour if desired, so this decision loses nothing. Enabling a longer list of candidate matches felt like the more useful approach.

### Why an Index

Photon and Pelias use ElasticSearch - that would be a reasonable choice. Against that: a geocoder answers a narrow set of query shapes, and building an index exactly for that can get results on a single process and single file rather than a cluster. It also achieves low RAM requirements and boot time in under a second, with lookup latency of less than a millisecond for a house number or a reverse lookup, and just a few milliseconds for text.

### Index Structure

The index is a directory of flat little-endian arrays and a small JSON manifest, laid out so that every file maps one-to-one onto a JavaScript typed array (see `ingest/internal/index/format.go`).

The whole shape follows from a single decision: the server never writes to the index, so nothing in it has to support insertion. That's a strong constraint - and it allows us to support autocomplete with fewer datastructures and less RAM.

Sorted arrays do the work of trees, and the same term dictionary serves both exact lookup and prefix range by binary search, which is what makes autocomplete cheap. Offsets do the work of pointers, so a term's posting list is a slice of one long array of ascending anchor ids and a multi-token query is a linear intersection. Anchor fields live in one array each rather than in records, so a query touches only the fields it actually reads. House numbers sit in sorted runs behind their anchor, keyed on the number's leading integer, so finding 248 on a street with thousands of addresses is another binary search. Coordinates are int32 fixed point at roughly a centimetre, which halves the space against float64, keeps comparisons exact, and lets point-in-polygon run directly on the stored integers.

The spatial structures are precomputed on the same principle. The k-d tree ships as a permutation of point ids with its structure implicit in their order, so the server builds nothing at startup. Loading is then a read and a cast rather than a parse - 119 ms for 14M addresses, 908 ms for 90M - and resident memory stays close to the artifact size.

### Geocoding

The geocoding follows from the data structure (well, also vice-versa).

A forward query is folded, split, looked up, then scored twice. Folding (`packages/core/src/normalize.ts`) strips diacritics, transliterates Cyrillic and expands street-type abbreviations, so "Plzen" and "Plzeň" reduce to the same token; the same rules run at build time in Go (`ingest/internal/norm/norm.go`), with a 4,000-name fixture generated by the Go side asserting the TypeScript reproduces it exactly. Parsing (`server/src/query.ts`) separates a house number from the name, since "3 Maja" is a street and "Marszalkowska 12" is not. Lookup (`server/src/terms.ts`) resolves every token but the last exactly and the last as a prefix range, then intersects the posting lists - that gives a candidate set and a text weight from array reads alone.

Scoring happens in two passes, with crude scoring providing an A*-style upper bound, because precise scoring is expensive: it has to fold each candidate's name and every alias it carries. The cheap pass (`server/src/ranking.ts`) multiplies the text weight by an importance prior, all array reads, so it can afford to run on every candidate. Each candidate gets an upper bound on what it could possibly score, candidates are visited in bound order, and the scan stops once the best remaining bound can't beat the worst result already held (`server/src/forward.ts`). A three-character prefix retrieves 23,251 candidates and only needs to fully scores 79 of them to guarantee finding the best. Within the winning anchor, the house number is then found inside it by binary search (`server/src/housenumber.ts`).

A misspelling gets one retry, and only after an exact search has found nothing (`server/src/fuzzy.ts`). A term within one edit of the query must share either its first half as a prefix or its second half as a suffix, so both halves are binary searches - the second against a reversed copy of the term dictionary.

Reverse geocoding asks two questions and uses a different structure for each. "Is this point within a polygon/ multipolygon?" uses a uniform cell grid for feature bounding boxes lookup, and ray casting on the stored integers (`server/src/geometry.ts`) confirms whether the point is within the polygon/ place. Those places are the first results returned, since the point is actually within them, ordered from smallest to largest since a particular lake within a park is assumed to be more informative than the park it is in. "What places are near this point?" is answered with a k-d tree search (`server/src/pointindex.ts`) from the query point, with places sorted by distance (`server/src/reverse.ts`).


## Tech Stack Rationale

### Ingest

The ingest pipeline is built in Go. It could have been done in Java, Rust or C++ (and could be ported to any of those languages), and I choose Go mostly on personal preference/ perceived readability and less frequent need for maintenance/ overhauls. The pipeline is just a batch job that reads 3.5-88 GB of binary input and writes a binary file. Its weight is in file operations, RAM and CPU computation. Go is particularly good for concurrency - the decode parallelises for free. `paulmach/osm` decodes pbf blobs across goroutines, and the scan phases sustain 870–1250% CPU on a 16-core machine, with the whole build averaging about 300%. And in practice my maintainability expectation seems to hold (though I haven't tested the counterfactual in Java/ C++) - there are only 2 external dependencies. The toolchain for formatting, vetting, testing and benchmarking is inbuilt and great.

Note: C, C++ and Rust without garbace collection would likely offer the best performance, at a code complexity and maintenance cost. Java would probably get similar computational performance to Go, with more complex and verbose code, more dependencies and higher maintenance cost. The Go ingest pipeline performance seems pretty good already, with further optimization possible within the language.

See the implementation at `./ingest`.

### Server

The server (`./server`) is implemented in TypeScript/ NodeJS. Many languages would work there, but TypeScript has important advantages over all others - everything downstream integrating with it is probably JavaScript.

See `./packages/core` - dependency-free and browser-buildable, supplying the response types and the index's query normalizer, simplifying (and improving robustness and completeness of) client any integrations.


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
- we are limited to just hundreds of queries per second currently by a single Node.js thread. So spawning and sharing workload across worker_threads would increase throughput.
- we could further increase throughput, if we were lucky enough to have to, by setting up horizontal scaling
- in production, observability beyond structured logs would be nice
- explore caching and CDN layer (e.g. for handling an autocomplete load)
- limit the damage from more expensive queries (e.g. lat/lon far from any places in the index is currently more painful than it needs to be - many queries like that could be a problem)
- more data beyond OSM
- it would be nice to have a frontend map UI consuming this API - to catch any bugs, get a gauge of its usefulness and prioritize further work

Based on global OSM data alone, and a <8 GB index, it doesn't look like there'd be any need to shard geographically (OVH has servers with 2 TB of RAM, and AWS/ GCP have 32 TB servvers). Cheap generic servers can carry the world. (But note the worker thread & horrizontal scaling points above.)





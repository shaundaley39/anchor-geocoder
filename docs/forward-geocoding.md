# Forward Geocoding

Text in, ranked places out. This document follows one query from the OSM tags
that made the index to the ordering of the answer, with a code link at each
step.

The short version: the build reduces OSM to *anchors* (a street, a settlement
or a POI) with *addresses* hanging off them, and reduces every name to folded
tokens with ids in a sorted dictionary. A query is folded the same way, its
tokens are looked up in that dictionary, the posting lists are intersected, and
the survivors are scored twice - once cheaply on numbers the artifact already
holds, once properly - with the cheap score serving as an upper bound on the
proper one so the search can stop early without losing the winner.


## 1. What we take from OSM, and what we leave

Extraction runs in four passes over each `.osm.pbf`, because the format is
ordered nodes-then-ways and a way's members are bare node ids
([`ingest/internal/pbf/extract.go:157`](../ingest/internal/pbf/extract.go#L157)).
Pass 0 finds multipolygon relations
([`relations.go:33`](../ingest/internal/pbf/relations.go#L33)), pass 1 selects
ways and records the node ids they need
([`passes.go:26`](../ingest/internal/pbf/passes.go#L26)), pass 2 streams nodes
([`passes.go:105`](../ingest/internal/pbf/passes.go#L105)), pass 3 rebuilds way
geometry ([`passes.go:168`](../ingest/internal/pbf/passes.go#L168)).

Four kinds of feature survive. Everything else in OSM is dropped at this point
and never reaches the index.

**Addresses.** Anything carrying `addr:housenumber`, `addr:conscriptionnumber`
or `addr:provisionalnumber`
([`extract.go:117`](../ingest/internal/pbf/extract.go#L117)). All three, because
Czech addresses often carry a conscription number and no plain house number.

**Streets.** A named `highway` whose value is one of ten routable classes -
motorway, trunk, primary, secondary, tertiary, unclassified, residential,
living_street, pedestrian, road
([`extract.go:127`](../ingest/internal/pbf/extract.go#L127),
[`:133`](../ingest/internal/pbf/extract.go#L133)). Service roads, tracks, paths,
cycleways and footways are omitted: they add "Parking Aisle" without adding
anywhere anyone searches for.

**Places.** A named `place` in ten settlement classes - city, town, village,
hamlet, suburb, quarter, neighbourhood, borough, isolated_dwelling,
municipality ([`extract.go:138`](../ingest/internal/pbf/extract.go#L138),
[`:144`](../ingest/internal/pbf/extract.go#L144)). Countries, states, counties,
regions, islands, localities and farms are omitted as standalone results.

**POIs.** Named features carrying one of fifteen allowlisted keys - amenity,
shop, tourism, leisure, historic, office, healthcare, craft, railway, aeroway,
public_transport, man_made, natural, waterway, mountain_pass
([`poi.go:24`](../ingest/internal/pbf/poi.go#L24)) - minus a per-key exclusion
list of values that are map furniture rather than destinations
([`poi.go:31`](../ingest/internal/pbf/poi.go#L31),
[`:105`](../ingest/internal/pbf/poi.go#L105)). The exclusions matter: "everything
named with a POI tag" is 332,648 features for Czechia alone, of which the top
of the distribution is 59,545 bus-stop platforms sharing their stop's name and
56,930 hiking guideposts. The test applied was whether a person would
plausibly type the name into a search box. Anything tagged `disused`,
`abandoned`, `demolished` or `was:*` is dropped as well.

Unnamed features are dropped everywhere except addresses, which are identified
by their number rather than a name.

One OSM feature can produce two records
([`convert.go:95`](../ingest/internal/model/convert.go#L95)): a restaurant with
an address becomes both a POI and an address point, since both are things
someone might search for. A place that is also a POI is emitted once, as the
POI, to avoid indexing it twice.

Geometry is simplified on the way in
([`passes.go:12`](../ingest/internal/pbf/passes.go#L12)). Rings smaller than 60 m
across keep only their centroid, since below that an outline cannot change a
ranking; the rest are simplified to a 10 m tolerance and capped at 48 points,
so one coastline cannot dominate the geometry blob.


## 2. What reaches the index, and in what shape

The record stream is reduced to two row types
([`ingest/internal/index/rows.go:11`](../ingest/internal/index/rows.go#L11),
[`:54`](../ingest/internal/index/rows.go#L54)): an **anchor** for anything
searchable by name, and an **address** for a house number hanging off one
([`anchor.go:29`](../ingest/internal/anchor/anchor.go#L29),
[`:205`](../ingest/internal/anchor/anchor.go#L205)). Text search runs over
anchors only. That is 173.8M addresses resolving to 58.5M anchors on the world
build, and it is why a house number is a binary search inside a matched street
rather than a document of its own.

Every file in the artifact is a flat little-endian array with no header, so the
server loads it with a read and a cast
([`format.go`](../ingest/internal/index/format.go) lists them all;
[`format.go:59`](../ingest/internal/index/format.go#L59) is the version the
server refuses to read past). Coordinates are int32 fixed point at 1e7, roughly
1.1 cm ([`format.go:81`](../ingest/internal/index/format.go#L81)), which halves
the largest arrays against float64 and keeps comparisons exact.

Per anchor, written by
[`builder.go:254`](../ingest/internal/index/builder.go#L254):

| file | type | what it holds |
| --- | --- | --- |
| `anchor_name`, `anchor_local` | uint32 | string ids of the name and its locality |
| `anchor_alt` | uint32 | string id of the alternate names, joined by U+001F |
| `anchor_cat` | uint32 | string id of the POI category, 0 otherwise |
| `anchor_lat`, `anchor_lon` | int32 | representative point |
| `anchor_min/max lat/lon` | int32 | bounding box, degenerate to the point when there is no extent |
| `anchor_flags` | uint8 | layer in the low nibble |
| `anchor_country` | uint8 | country id, its own array so the count can pass sixteen |
| `anchor_score` | float32 | importance prior, pre-multiplied at build time |
| `anchor_ntok` | uint8 | token count of the *shortest* name this anchor is known by |
| `anchor_addr_start/count` | uint32 | the anchor's run in the address arrays |
| `geom_off`, `geom`, `geom_closed` | uint32, int32, uint8 | vertex offsets, the vertices, and whether the outline is a ring |

Addresses are stored grouped by anchor and sorted by house number
([`builder.go:361`](../ingest/internal/index/builder.go#L361)) as `addr_num`
(string id), `addr_lat`, `addr_lon` and `addr_sortkey` (the leading integer of
the number, [`rows.go:66`](../ingest/internal/index/rows.go#L66)). There is
deliberately no `addr_anchor`: the owning anchor is recovered by binary search
over `anchor_addr_start`, which costs about 23 comparisons and saves 4 bytes per
address.

**The searchable text.** Which fields become tokens is decided by
[`SearchTokens`](../ingest/internal/model/convert.go#L259): the name, the
street, the place, the city, and every alternate name; plus the house number,
the Czech conscription and orientation numbers and the postcode for address and
POI layers. A query mixes these freely - "Pražská 248 Poděbrady" spans three -
so they are one deduplicated list per anchor.

Each of those strings is folded by
[`norm.IndexTokens`](../ingest/internal/norm/norm.go) and interned to a term id
([`builder.go:89`](../ingest/internal/index/builder.go#L89)). The inverted index
is then built from the ids
([`builder.go:391`](../ingest/internal/index/builder.go#L391)): `terms.bin`/`.idx`
is the sorted distinct dictionary, `post_off` slices `post` into a posting list
of ascending anchor ids per term. The dictionary is sorted in **UTF-16 code unit
order**, not code point order, because the server binary-searches it with
JavaScript's `<` and the two orders disagree above the BMP
([`builder.go`](../ingest/internal/index/builder.go), `sortUTF16`).

`terms_rev` is the same dictionary with every term reversed and re-sorted, which
turns a suffix search into a prefix search and is what spelling correction uses.

Finally, `anchor_terms`/`anchor_terms_off` holds, per anchor, the term ids its
own locality and each of its name variants fold to - locality first, then the
canonical name, then each alternate, separated by `TermSep`
([`format.go:63`](../ingest/internal/index/format.go#L63)). Scoring reads this
instead of folding a string per candidate.

Two numbers are computed at build time and never recomputed: the importance
prior per anchor ([`anchor.go:185`](../ingest/internal/anchor/anchor.go#L185) for
settlements, [`:104`](../ingest/internal/anchor/anchor.go#L104) for POIs, a flat
1 for streets), and `anchor_ntok`, the shortest name's token count
([`anchor.go:144`](../ingest/internal/anchor/anchor.go#L144)), which is what lets
the server bound relevance without folding anything.


## 3. Processing the query text

Folding is one function, ported to TypeScript and held to the Go original by a
fixture of 4,055 real names
([`packages/core/src/normalize.ts:152`](../packages/core/src/normalize.ts#L152)).
It lowercases, expands the characters decomposition cannot handle (ł, ß, æ, ø and the
rest, [`:13`](../packages/core/src/normalize.ts#L13)), transliterates Cyrillic
([`:45`](../packages/core/src/normalize.ts#L45)), applies NFKD and strips
combining marks - sparing the two Japanese voicing marks, since dropping a
dakuten folds ば onto は - lowercases again, because NFKD produces capitals the
first pass never saw, and turns everything that is not a letter or a number into
a separator.

[`tokens`](../packages/core/src/normalize.ts#L193) then splits on whitespace,
expands street-type abbreviations
([`:65`](../packages/core/src/normalize.ts#L65)), drops generic street-type words
([`:82`](../packages/core/src/normalize.ts#L82)) unless that would empty the
list, and cuts runs of Han, Hiragana and Katakana into overlapping bigrams
([`:130`](../packages/core/src/normalize.ts#L130)), which is the only way a
query for 千代田区 can share tokens with 東京都千代田区.

[`queryVariants`](../packages/core/src/normalize.ts#L335) then widens each token
to the spellings worth looking up: München also tries `muenchen`, Muenchen also
tries `munchen`, and a run of three or more `s` from a ß compound also tries two.

[`parseQuery`](../server/src/query.ts#L32) turns the token list into candidate
*readings*, best guess first, because a query can parse more than one way. A
trailing or medial digit-leading token is a house number
([`query.ts:60`](../server/src/query.ts#L60)) - "Marszalkowska 12", "Via Roma 1
Torino" - and a leading one is too, but only as a last resort, since "3 Maja" is
a Polish street and "17 Novembre" a French one. The caller takes the first
reading that finds anything.


## 4. From query text to candidate places

The dictionary is consulted once per search
([`resolveQuery`](../server/src/terms.ts#L31)). Every token but the last resolves
to exact term ids, one per spelling; the last resolves to prefix *ranges*, since
a half-typed word still has to match.

[`candidates`](../server/src/terms.ts#L102) then does the retrieval. The forms of
one token are ORed and the tokens themselves ANDed, so "Muenchen" and "munchen"
are one token with two ways in. Term weight is inverse document frequency with a
floor of 500 postings ([`terms.ts:57`](../server/src/terms.ts#L57),
[`:59`](../server/src/terms.ts#L59)): unfloored, IDF swings 2.4x between a
one-posting term and a 16,000-posting one, which was enough to put a shop branded
"Warsz" above Warszawa.

The prefix term is weighted by how much of the matched term the user actually
typed, discounted squared, because prefix expansion is a fallback and not an
equal alternative - without the discount "Prahatice" outscored "Praha".

Intersection walks the smallest candidate set and tests the rest by binary
search over the posting lists as they lie
([`holds`](../server/src/terms.ts#L77)). Which set is smallest is a property of
the query and is chosen per request: "Rue de la Paix" is carried by its last
token, "Nowa Wies 12" by its first. Building a `Set` per token instead cost the
length of each list rather than its logarithm, and that query spent 242 ms of
its 249 ms there.

A one-letter prefix can span a large slice of the index, so the prefix scan is
capped at twenty times the rerank limit. The exact-term lists still anchor the
result set, so the cap only loses long tail.


## 5. Scoring, the search, and why the top result is provably first

Scoring is in two stages because the two halves cost different amounts.

**The cheap score** ([`cheapScore`](../server/src/ranking.ts#L189)) is array
reads only: the text weight from retrieval, times the anchor's importance prior,
times a layer multiplier - a bare settlement name is more often the intent than
a POI sharing it, and a street inherits the standing of the place it runs
through - times a proximity boost if the caller supplied one
([`:181`](../server/src/ranking.ts#L181)). Every candidate can afford it.

**Relevance** ([`relevance`](../server/src/ranking.ts#L78)) is the expensive
half. It asks two questions per name variant: how much of the query this name
explains, with the locality at partial credit so adding a city helps rather than
dilutes; and how much of the name the query used. Matching is a multiset match -
each name token can be claimed once
([`claim`](../server/src/ranking.ts#L52)) - or "Praha Praha Praha" would count
three matches against a one-token name and outscore "Praha" itself. The product
is squared, an exactly and wholly matched name gets 2.5x, and an alternate name
is discounted to 0.9 because an alias is weaker evidence than the name a feature
actually goes by. The best variant wins, not the canonical one and not all of
them merged: canonical alone makes exonyms unrankable, merged makes Kraków's 26
alternate names read as one very long name.

Since the fold moved into the artifact, this compares term ids rather than
strings, and touches no text at all.

**The bound.** [`maxRelevance`](../server/src/ranking.ts#L167) is the most
`relevance` could return for an anchor, computed from `anchor_ntok` alone. The
argument is short: a query token counts toward the name or the locality but
never both, so `explained` is at most 1; a q-token query can use at most
`min(q, n)/n` of an n-token name; and only `n == q` can be an exact match, so the
2.5x applies only when `q >= n`. The artifact stores n for the *shortest* name
variant, which maximises both terms, so the result is a true ceiling.

**The search** ([`search`](../server/src/forward.ts#L127)) uses that ceiling as
an admissible heuristic. Every candidate gets `cheapScore * maxRelevance *
houseCeiling` as its bound ([`forward.ts:157`](../server/src/forward.ts#L157)),
candidates are visited in bound order through a max-heap, and the loop stops
when the k-th best *final* score exceeds the next candidate's bound
([`forward.ts:189`](../server/src/forward.ts#L189)). Nothing after that point can
enter the result, because nothing after that point can score above its own bound.
This is A\*'s admissibility argument, and it is why the answer is provably the
best one and not merely the best one found.

It matters that the bound is tight and not merely sound. A global 2.5 would be
sound and useless: for "Praha" it claims each of 9,496 candidates might be an
exact match. Using the stored token count puts most of them at 0.16 and pruning
starts working - a three-character prefix retrieves 23,251 candidates and fully
scores 79 of them.

Cutting at a fixed depth instead would be unsound. The omitted factors multiply
by up to 45, so a candidate ranked 400th on cheap score can finish first: the
Nádražní in Brno came 427th of 1,136 and was dropped from every query.

There is one documented exception. `MAX_RERANK`
([`forward.ts:37`](../server/src/forward.ts#L37)) is a hard ceiling of 10,000 full
scorings so a pathological query cannot run unbounded, and when it stops the scan
before the bound does, the guarantee lapses. The search says so by setting
`stats.cappedByLimit` ([`forward.ts:48`](../server/src/forward.ts#L48)).

Afterwards the house number is resolved inside the winning anchor by binary
search ([`housenumber.ts:60`](../server/src/housenumber.ts#L60)) and becomes the
largest single factor in the score - 18 for an exact match, 6 for a numeric one,
0.4 when the street exists and the number does not
([`housenumber.ts:48`](../server/src/housenumber.ts#L48)). Near-duplicates are
dropped ([`forward.ts:237`](../server/src/forward.ts#L237)): Karlův most is mapped
as an attraction several times along its length.

If nothing matched, and only then, the query is retried against the nearest real
spelling ([`fuzzy.ts:78`](../server/src/fuzzy.ts#L78)). A correctly spelled query
is never second-guessed.

The whole argument is checked rather than asserted: a test scores every candidate
exhaustively and compares the winner against the pruned search, over the built
index.


## 6. What can be adjusted

**Per request** ([`ForwardOptions`](../server/src/forward.ts#L24),
[`GeocodeQuery`](../packages/core/src/schema.ts)):

| parameter | effect |
| --- | --- |
| `limit` | 1 to 50, default 10. Also sets how hard the bound prunes |
| `country` | filters to one ISO 3166-1 alpha-2 code |
| `proximity=lat,lon` | multiplies the score by ~2x at the point, ~1.5x at 50 km, tending to 1 |
| `fuzzy: false` | suppresses the spelling-correction retry |

**Build-time priors**, which decide what "Praha" means when forty things are
called it: settlement class and population
([`anchor.go:185`](../ingest/internal/anchor/anchor.go#L185)), POI category
([`anchor.go:104`](../ingest/internal/anchor/anchor.go#L104)), and the flat 1 a
street gets. Changing these needs a re-index, not a rebuild of the record
stream.

**Ranking constants**, all in one file each:

| constant | file | what it trades |
| --- | --- | --- |
| `ALIAS_DISCOUNT` | [`ranking.ts:16`](../server/src/ranking.ts#L16) | exonyms findable against alt-name spam |
| layer multipliers | [`ranking.ts:189`](../server/src/ranking.ts#L189) | settlements and streets against POIs |
| `DF_FLOOR` | [`terms.ts:57`](../server/src/terms.ts#L57) | how much rarity is worth |
| `MAX_RERANK` | [`forward.ts:37`](../server/src/forward.ts#L37) | worst-case latency against the bound's guarantee |
| `DEDUP_HEADROOM` | [`forward.ts:45`](../server/src/forward.ts#L45) | pruning depth against duplicates lost |
| `DUPLICATE_RADIUS_M` | [`forward.ts:229`](../server/src/forward.ts#L229) | merging one feature mapped twice against merging two branches of a chain |
| `HOUSE_EXACT`, `HOUSE_NUMERIC`, `HOUSE_MISSING` | [`housenumber.ts:48`](../server/src/housenumber.ts#L48) | how much a matched number is worth |
| `MIN_LENGTH`, `MAX_CANDIDATES` | [`fuzzy.ts:6`](../server/src/fuzzy.ts#L6) | correction reach against guesswork |

**Normalizer tables**, which change what matches at all rather than how it
ranks, and which need a re-index because the index terms are folded by the same
code: abbreviations ([`normalize.ts:65`](../packages/core/src/normalize.ts#L65)),
generic street words ([`:82`](../packages/core/src/normalize.ts#L82)), the
singleton and Cyrillic tables ([`:13`](../packages/core/src/normalize.ts#L13),
[`:45`](../packages/core/src/normalize.ts#L45)), and the unspaced-script ranges
that decide what gets cut into bigrams
([`:104`](../packages/core/src/normalize.ts#L104)). Any change here must be made in
both implementations, and the fixture test will say so if it is not.

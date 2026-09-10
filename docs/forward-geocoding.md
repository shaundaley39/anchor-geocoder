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

If you want the mechanics rather than the outline, [§2 names the three
arrangements](#the-three-shapes-everything-is-stored-in) every file in the
artifact is built from, and [§4 walks a query through
them](#what-a-token-lookup-actually-reads) with the byte offsets it actually
reads.


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

### The three shapes everything is stored in

There are no records, no pointers and no trees in the artifact. Forty-odd files
are built out of three arrangements, and it is worth naming them because every
lookup in this document is one of the three.

**A column.** A fixed-width array indexed by id: `anchor_lat[id]`,
`anchor_score[id]`, `addr_sortkey[i]`. Reading field *f* of entity *i* is one
indexed load. Fields of one entity live in separate files rather than adjacent
in a record, so a query pays only for the fields it reads - a text search never
touches geometry.

**A blob and its bounds.** For anything variable-length: one concatenated blob,
plus an array of `n + 1` offsets into it. Item *i* is `blob[bounds[i],
bounds[i+1])`, which is again O(1) and again needs no pointer. The last offset
is the blob's length, which is why there are `n + 1` of them and no length
field anywhere. This is compressed sparse row, and it is used for the strings
(`strings.bin`/`.idx`), the term dictionary (`terms.bin`/`.idx`), the posting
lists (`post.bin` sliced by `post_off.bin`), each anchor's own term ids
(`anchor_terms.bin`/`_off.bin`), the outlines (`geom.bin`/`geom_off.bin`) and
the containment grid (`cell_items.bin` sliced by `cell_start`/`cell_count`).
In the server a slice is a typed-array `subarray`, which is a view: no copy, no
allocation.

**A sorted blob and its bounds.** The same, plus the invariant that the items
ascend. That single extra property is what makes the index searchable rather
than merely readable: lookup becomes binary search, and everything sharing a
prefix is *contiguous*, so a prefix is a range of ids rather than a set of
them.

The consequence worth stating outright, because the rest of the document leans
on it: **an id is a position**. A term id is the term's rank in the sorted
dictionary. So the same integer is at once the key into every parallel column,
a slice index into the posting blob, and an order-preserving encoding of the
string itself - which is why testing "does this term begin with `pra`" is two
integer comparisons against an interval, and never a string operation.

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

[`parseQuery`](../server/src/query.ts#L164) turns the token list into candidate
*readings*, best guess first, because a query can parse more than one way. A
trailing or medial number is a house number
([`houseNumbers`](../server/src/query.ts#L225)) - "Marszalkowska 12", "Via Roma
1 Torino" - and a leading one is too, but only as a last resort, since "3 Maja"
is a Polish street and "17 Novembre" a French one. The caller takes the first
reading that finds anything.

Two things are read off the raw query rather than the folded tokens, because
folding throws away the punctuation that decides them
([`numberRuns`](../server/src/query.ts#L81),
[`postcode`](../server/src/query.ts#L137)).

The first is the house number itself, and it is not one token. Folding splits a
number wherever its punctuation was and then discards the punctuation, so
"78-52", "213號", "5/B", "ev.223" and "334/36" all arrive as two tokens - and so
does "602 00", which is a postcode. Reading the first of those two asks for
house number 78 on a street whose name has to contain "52", which is how a
Queens address, a Taiwanese one, a Dutch one and a Czech evidenční number all
used to return nothing at all.

So the number is matched in the raw text as a *run*
([`RUN`](../server/src/query.ts#L62)): digits, optionally opened by an
abbreviation, followed by further digits and short letter suffixes joined by a
slash, hyphen, dot, semicolon, plus, or nothing. Spaces are allowed around a
joiner and before a single trailing letter, because "205 A" and "20 ter" are
written that way, but not before more digits, which is what leaves "602 00" to
the postcode rule. A comma is never a joiner: it is how a query separates the
address from the town.

Two guards keep a run from eating the street. A letter part is at most three
characters and has to end where the word does, so "12 Main" cannot read as
"12Ma"; and an ordinal is excluded outright
([`ORDINAL`](../server/src/query.ts#L69)), because "85th Street" is a street.
Each run is then mapped back onto the folded tokens it covers
([`spans`](../server/src/query.ts#L92)), which is what lets the reading remove
exactly those tokens from the name.

Measured against the index itself - take a real address, write it out the way
it is stored, ask for it back - this took the round trip from 88% to 98%, and
the shapes that were broken outright from 0% to 100%.

The second thing read off the raw query is the postcode. A postcode is barely
in the index at all: an anchor's token list is built from one of its records,
so a street carries at most one of its addresses' postcodes and usually none,
while a POI carries its own. Every token but the last has to match a term, so a postcode left in the
name matches the wrong things or nothing - "Städtle 17, 9490 Vaduz" used to
return the POIs on Städtle tagged with that postcode, and never the address.

A postcode is also digits, which is what a house number is, so only the shapes
a house number is not are stripped: "602 00" written with a space (Czech,
Slovak), "00-001" written with a hyphen (Polish), or a lone run of four to six
digits anywhere but the head of the query. Both readings are offered either
way. Looking without it costs nothing even when the guess is wrong: where that
run really was the house number, taking it out leaves the reading with no
number to find and it is dropped before it is searched.

Order matters more than it looks, because the caller takes the first reading
that finds *anything*. Every reading that takes a house number out comes before
every reading that does not, and the postcode-stripped reading comes before the
one that keeps it - otherwise a weak match on a query that still carries its
postcode wins before the good reading is ever tried.


## 4. From query text to candidate places

The figures in this section are from the four-country default build - Czechia,
Poland, Switzerland, Bosnia - which `make all` produces with no arguments, so
they can be reproduced rather than taken on trust. It holds 1,973,565 anchors,
13,984,420 addresses and a dictionary of 526,387 terms.

### What a token lookup actually reads

Take `praha`. The dictionary is a sorted blob and its bounds:
`terms.idx` is 526,388 uint32 offsets (2.0 MiB) and `terms.bin` is the 526,387
terms concatenated (4.3 MiB), in ascending order.

[`lowerBound`](../server/src/artifact.ts#L107) binary-searches it. Twenty
probes for half a million terms; each probe reads two offsets, decodes the
bytes between them, and compares. The comparison is on UTF-16 code units,
which is what JavaScript's `<` does, and is why the build sorts in that order
rather than by code point - the two disagree above the BMP, and a dictionary
sorted one way and searched the other is silently wrong for a fraction of its
entries.

What comes back is not a string and not a pointer. It is **350,887**: the
position of `praha` in sorted order. That number is the whole interface to the
rest of the index.

### What the id buys

The posting list is a slice, taken with two reads:

```
post_off[350_887]      = 5_337_148
post_off[350_887 + 1]  = 5_356_128
post.subarray(5_337_148, 5_356_128)   // 18,980 ascending anchor ids
```

No hashing, no decompression, no allocation - a `subarray` is a view onto the
shared buffer. Some real ones from that build:

| term | id | postings |
| --- | ---: | ---: |
| `praha` | 350,887 | 18,980 |
| `brno` | 61,565 | 8,126 |
| `nadrazni` | 297,335 | 1,155 |
| `horakove` | 183,179 | 223 |
| `milady` | 281,533 | 215 |

The ids are ascending within a list, which is the property intersection needs.

### A prefix is an interval, not a set

Because the dictionary is sorted, every term beginning with `pra` is
contiguous. [`prefixRange`](../server/src/artifact.ts#L98) returns the half-open
id range, again by binary search:

```
"pra" -> [350_468, 351_699)   1,231 terms, 36,141 postings
"b"   -> [ 30_883,  71_680)  40,797 terms, 479,418 postings
```

So autocomplete costs a binary search and a walk of a contiguous id range, and
- the part that matters later - "is this anchor's term a `pra` word?" reduces
to `id >= 350_468 && id < 351_699`. Two integer comparisons, no text.

### Turning several tokens into a candidate set

[`candidates`](../server/src/terms.ts#L102) does the retrieval. The forms of
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

What comes out is a `Map` from anchor id to a text weight - the summed IDF of
the tokens that matched, plus the prefix term's discounted weight. On the same
build:

| query | candidates | fully scored | top result |
| --- | ---: | ---: | --- |
| `Praha` | 18,982 | 5,500 | Praha |
| `Pra` | 34,460 | 93 | Praha |
| `Nadrazni Brno` | 17 | 17 | Nádražní |
| `Milady Horakove 36, Brno` | 35 | 35 | Milady Horákové |

### The other direction: what an anchor knows about itself

Retrieval answers *which anchors carry these tokens*. That is not enough to
rank them. It does not say how much of the anchor's own name the query covered
- "Praha" against Praha is a different thing from "Praha" against Praha-Bubny -
and it does not say whether a token landed on the name or merely on the
locality the anchor sits in.

So the artifact carries the inverted index and its transpose. `anchor_terms`,
sliced by `anchor_terms_off`, holds each anchor's *own* term ids: the locality
first, then each name variant, separated by `TermSep`
([`format.go:63`](../ingest/internal/index/format.go#L63)). For the street the
last query above resolves to:

```
anchor 903,712   "Milady Horákové" in "Brno"
anchor_terms[4_384_096, 4_384_100) = 61565 │ 281533 183179
                                     brno  │ milady horakove
```

Four uint32. The same integers the dictionary handed back at the start of the
search, stored the other way round. Scoring is then set arithmetic on
integers: [`claim`](../server/src/ranking.ts#L52) walks the anchor's ids and
asks whether each matches one of the query token's exact ids, or falls inside
one of its prefix intervals - the two comparisons from earlier. Nothing decodes
a string, nothing folds anything, and the two sides cannot disagree about what
a name folds to because only one of them ever folded it.

Claiming is what makes it a multiset match rather than a set match: each
position in the anchor's list can be consumed once, so "Praha Praha Praha"
scores three matches against a one-token name only if that name has three
tokens. Out of it come the two counts §5 needs - how many query tokens landed
in the name, and how many in the locality - and the anchor's own length, which
is just `vEnd - vStart`.

This is the whole answer to how a series of tokens becomes a scored place:
sorted dictionary turns each token into an integer, the posting blob turns
each integer into a set of anchors, intersection turns several sets into
candidates, and the transpose turns each candidate back into the integers it
was built from so the overlap can be counted both ways round.


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

It reads the transpose described above, so it compares term ids rather than
strings and touches no text at all. `inName` and `inLocality` are the two
counts `claim` produced; `nameLen` is `vEnd - vStart`, the length of the
variant being scored.

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

Afterwards the house number is resolved inside the winning anchor
([`resolveHouseNumber`](../server/src/housenumber.ts#L208)) and becomes the
largest single factor in the score - 18 where the query named the address, 6
where it named the right number in the wrong form, 3 for a Czech conscription
number written on its own, and 0.4 where the street exists and the number does
not ([`housenumber.ts:192`](../server/src/housenumber.ts#L192)).

The lookup is a binary search over the run, which is sorted on the leading
integer of each number
([`findHouseNumber`](../server/src/housenumber.ts#L110)) - the first digits
found anywhere in it, so "ev.223" sorts under 223 and stays reachable.

Comparison is on the *folded* form of both sides rather than the strings, which
is what makes the whole zoo of punctuation a non-problem once the query parser
has kept the number in one piece: "75 / A" and "75/A" fold alike, so do "334 /
36" and "334/36". The house number is the one field where every country writes
something different, and it is handled in one place with no country rules in
it at all - bar the composed-number reading below.

**Why the number is not simply a token.** It would be the obvious
simplification, and it is the expensive one. Addresses outnumber anchors three
to one - 173.8M against 58.5M - so every address would have to become a
searchable document carrying its street's and city's tokens as well as its
own, which is several gigabytes of extra postings on an 11 GB index. Worse,
numbers are the least selective terms there are: 4.77M addresses begin with
"1", where the README's worst existing term, "de", reaches 2.3M. Retrieval
would have to intersect that. As a lookup instead, the number never enters the
inverted index at all - it is a binary search inside the matched street's own
run, which averages seventeen addresses and is at most four for 42% of
streets.

Czechia and Slovakia number a building twice, and this is where most of the
work is. "334/36" is conscription number 334, which identifies the building
within the municipality, and orientation number 36, which is what is on the
door plate and on the envelope. There are three ways to write it, of which two
are addresses:

- **"Milady Horákové 334/36"** - the full form.
- **"Milady Horákové 36"** - the orientation number alone. Complete,
  unambiguous, and the form people actually write. Worth the same as the full
  form.
- **"Milady Horákové 334"** - the conscription number alone, which is not an
  address. It still identifies the building, so it is answered rather than
  refused, at a third of the weight.

The exception, and a common one: a building with no orientation number has only
a conscription number, and that is then the whole address. Those are stored as
a bare number and match exactly, so they never reach the third case - "Velká
Úpa 299" is an address like any other.

The run is sorted on the conscription number, which is the wrong half to sort
on and the one nobody writes, so the orientation number is found by a scan
comparing the digits after the slash, read off the stored bytes without
decoding them. That scan runs before the binary search's answer is accepted,
not after it: sorted order would otherwise answer "Bratislavská 6" with
whichever building happens to be conscription number 6. Runs average seventeen
addresses.

Elsewhere a slash separates something else (Polish "5/7" is building 5, flat
7), so the whole reading is scoped to the two countries whose addresses are
built this way
([`housenumber.ts:41`](../server/src/housenumber.ts#L41)). Outside them there
is no fallback to the second half at all. There used to be, and measuring it
is what removed it: over the whole index it changed the round trip by nothing
(869 of 885 either way) while answering "Marszałkowska 12/5" with
"Marszałkowska 3/5", which is a different building. The street on its own is
the more honest answer. Near-duplicates are
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
| `HOUSE_EXACT`, `HOUSE_NUMERIC`, `HOUSE_CONSCRIPTION`, `HOUSE_MISSING` | [`housenumber.ts:192`](../server/src/housenumber.ts#L192) | how much a matched number is worth |
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

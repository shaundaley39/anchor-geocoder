# Committed demo index

Liechtenstein, 12,547 addresses, 672 KB. Committed — unusually, since a build
artifact is not source — so that the API can be run with no download and no
build:

```bash
make demo
```

It exists because everything else needs a Geofabrik extract first, and the
smallest of those is still 3.45 MB with a four-minute pipeline behind it. This
is the whole system, end to end, on real OSM data, in about a second.

Regenerate it after any change to the artifact format:

```bash
make demo-index
```

`server/test/demo-index.test.ts` loads it in CI, so a format version bump that
forgets to regenerate this fails the build rather than shipping an index the
server refuses to read.

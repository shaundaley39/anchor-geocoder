/**
 * Loads the binary artifact produced by `ingest/cmd/geoindex`. Every file maps
 * onto one typed array, so loading is a read plus a view. The same data as
 * JavaScript objects would cost several GB and minutes of startup.
 *
 * The read lands in a `SharedArrayBuffer` per file, which is what lets the
 * worker threads in `pool.ts` be N views of one 4.4 GB index rather than N
 * copies of it. Nothing writes to the artifact after `loadBundle` returns, so
 * the sharing needs no synchronisation beyond that.
 */
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Layer codes, matching `ingest/internal/index`. */
export const LAYER_STREET = 0;
export const LAYER_PLACE = 1;
export const LAYER_POI = 2;

/** Fixed-point factor for coordinates; must match the Go `CoordScale`. */
export const COORD_SCALE = 1e7;

/** Layout version the server understands. */
export const SUPPORTED_VERSION = 9;

/**
 * Decoded strings kept per table per thread, so that a cache which would
 * otherwise grow to the size of the table has a ceiling. Measured against a
 * cap of 5,000 it is worth a few percent of throughput and costs well under a
 * gigabyte across a sixteen-thread pool — small next to the request heap, which
 * is what actually sets a pool's peak.
 */
const CACHE_ENTRIES = 500_000;

export interface Manifest {
  version: number;
  built_at: string;
  countries: string[];
  num_strings: number;
  num_anchors: number;
  num_addresses: number;
  num_terms: number;
  num_pois: number;
  num_shapes: number;
  kd_node_size: number;
  num_cells: number;
  num_vertices: number;
  num_postings: number;
  num_anchor_terms: number;
  country_ids: Record<string, number>;
  counts: Record<string, number>;
  bytes: Record<string, number>;
  duration: string;
}

/**
 * One concatenated UTF-8 blob plus offsets. Decoded lazily, since a request
 * touches a handful of strings and decoding all of them would undo the layout.
 *
 * The blob is shared between threads and the decoded strings cannot be, so the
 * cache is per thread and its size is multiplied by the pool. A slot per entry
 * would be 8 bytes x 13.9M strings x every thread — 2.5 GB of mostly empty
 * array across sixteen — where a map pays only for what was asked for. Capped
 * for the same reason `tokenCache` is: past the cap it stops caching and goes
 * back to decoding, which is merely the speed it had before any cache.
 */
export class StringTable {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly cache = new Map<number, string>();

  constructor(
    private readonly blob: Uint8Array,
    private readonly offsets: Uint32Array,
  ) {}

  get length(): number { return this.offsets.length - 1; }

  get(id: number): string {
    if (id < 0 || id >= this.length) return '';
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const start = this.offsets[id]!;
    const end = this.offsets[id + 1]!;
    const s = this.decoder.decode(this.blob.subarray(start, end));
    if (this.cache.size < CACHE_ENTRIES) this.cache.set(id, s);
    return s;
  }

  /** Terms are sorted, so this is a binary search rather than a scan. */
  prefixRange(prefix: string): [number, number] {
    const lo = this.lowerBound(prefix);
    // The upper bound is the first term that does not start with `prefix`.
    let hi = lo;
    while (hi < this.length && this.get(hi).startsWith(prefix)) hi++;
    return [lo, hi];
  }

  /** Index of the first term >= `target`. */
  lowerBound(target: string): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.get(mid) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Exact lookup; -1 when absent. */
  find(term: string): number {
    const i = this.lowerBound(term);
    return i < this.length && this.get(i) === term ? i : -1;
  }
}

export interface Artifact {
  manifest: Manifest;
  strings: StringTable;
  terms: StringTable;
  /** The terms again, each reversed and the set re-sorted, for suffix search. */
  termsRev: StringTable;
  /** Reversed-dictionary position -> term id. */
  termRevId: Uint32Array;

  /** Inverted index: postOff[t]..postOff[t+1] slices `post` into a posting list. */
  postOff: Uint32Array;
  post: Uint32Array;

  /**
   * Each anchor's own name and locality, as term ids, so scoring compares
   * integers instead of folding strings per candidate. `anchorTermsOff` slices
   * it per anchor; within a slice the sections are the locality, then each name
   * variant with the canonical one first, separated by TERM_SEP.
   *
   * This is the folding that `relevance` used to do at query time and cache per
   * thread. Doing it at build time costs ~500MB in the artifact, shared by every
   * thread, and removes both the work and the caches that hid it.
   */
  anchorTerms: Uint32Array;
  anchorTermsOff: Uint32Array;

  /** Anchors: struct-of-arrays, `numAnchors` entries. */
  anchorName: Uint32Array;
  anchorLocal: Uint32Array;
  anchorLat: Int32Array;
  anchorLon: Int32Array;
  anchorFlags: Uint8Array;
  /**
   * Country id per anchor. Its own array rather than a nibble of `anchorFlags`:
   * four bits caps at sixteen, and the next additions would have wrapped
   * silently into the layer bits.
   */
  anchorCountry: Uint8Array;
  anchorScore: Float32Array;
  /** POI category string id; 0 for non-POI anchors. */
  anchorCat: Uint32Array;
  /** String id of the anchor's alternate names, joined by ALT_SEP; 0 if none. */
  anchorAlt: Uint32Array;
  /**
   * Token count of the shortest name each anchor is known by. Lets the ranking
   * bound relevance without folding the name, which is the expensive part.
   */
  anchorNameTokens: Uint8Array;

  /** Bounding box per anchor, degenerate to its point when there is no extent. */
  anchorMinLat: Int32Array;
  anchorMinLon: Int32Array;
  anchorMaxLat: Int32Array;
  anchorMaxLon: Int32Array;

  /**
   * Simplified outlines. `geomOff` slices `geom` per anchor by *vertex* index;
   * `geomClosed` marks a ring, which can contain a point, from a street's
   * sampled points, which can only be measured to.
   */
  geom: Int32Array;
  geomOff: Uint32Array;
  geomClosed: Uint8Array;

  /**
   * Precomputed by the build, so boot is a read rather than a rebuild. `kdPerm`
   * is point ids in k-d order; the cell arrays are the containment grid as
   * sorted keys with a CSR of anchor ids.
   */
  kdPerm: Uint32Array;
  cellKey: Int32Array;
  cellStart: Uint32Array;
  cellCount: Uint32Array;
  cellItems: Uint32Array;
  anchorAddrStart: Uint32Array;
  anchorAddrCount: Uint32Array;

  /** Addresses: struct-of-arrays, grouped by anchor and sorted by house number. */
  addrNum: Uint32Array;
  addrLat: Int32Array;
  addrLon: Int32Array;
  addrSortKey: Uint32Array;

  /** Country code by numeric id, inverted from the manifest. */
  countryByID: string[];

  /**
   * Importance of each locality, by its name's string id, so an anchor can
   * inherit the standing of the place it is in. Without it the hundreds of
   * streets sharing a name are indistinguishable and "Unter den Linden 1"
   * resolves to an Austrian hamlet.
   *
   * Derived at boot: a projection of the place layer, one pass, and keeping it
   * out of the format means ranking can be retuned without a rebuild.
   */
  localityScore: Float32Array;
}

/**
 * Every file the artifact is made of, named once so the loader, the bundle and
 * the workers cannot disagree about what "the index" is.
 */
const FILES = [
  'strings.bin', 'strings.idx',
  'terms.bin', 'terms.idx',
  'terms_rev.bin', 'terms_rev.idx', 'term_rev_id.bin',
  'post_off.bin', 'post.bin',
  'anchor_terms.bin', 'anchor_terms_off.bin',
  'anchor_name.bin', 'anchor_local.bin', 'anchor_lat.bin', 'anchor_lon.bin',
  'anchor_flags.bin', 'anchor_country.bin', 'anchor_score.bin',
  'anchor_cat.bin', 'anchor_alt.bin', 'anchor_ntok.bin',
  'anchor_minlat.bin', 'anchor_minlon.bin', 'anchor_maxlat.bin', 'anchor_maxlon.bin',
  'geom.bin', 'geom_off.bin', 'geom_closed.bin',
  'kd_perm.bin',
  'cell_key.bin', 'cell_start.bin', 'cell_count.bin', 'cell_items.bin',
  'anchor_addr_start.bin', 'anchor_addr_count.bin',
  'addr_num.bin', 'addr_lat.bin', 'addr_lon.bin', 'addr_sortkey.bin',
] as const;

type FileName = typeof FILES[number];

/**
 * The index as bytes, in memory every thread can read.
 *
 * A `SharedArrayBuffer` is the whole point: the artifact is 4.4 GB for Europe
 * and strictly read-only after load, so N request threads must be N views of
 * one copy rather than N copies. It is also structured-cloneable, which is what
 * lets it reach a worker through `workerData` without being serialized.
 *
 * `localityScore` rides along because it is derived from the anchors in a pass
 * over all of them: computing it per thread would cost that pass and another
 * 56 MB each, for a result every thread would agree on.
 */
export interface ArtifactBundle {
  manifest: Manifest;
  files: Record<FileName, SharedArrayBuffer>;
  localityScore: SharedArrayBuffer;
}

/** Reads one file straight into shared memory — no intermediate Buffer. */
async function readShared(dir: string, name: string): Promise<SharedArrayBuffer> {
  const fh = await open(join(dir, name));
  try {
    const { size } = await fh.stat();
    const sab = new SharedArrayBuffer(size);
    const buf = Buffer.from(sab);
    // A single read can come up short on a large file, so this loops rather
    // than trusting one call to move 360 MB.
    let off = 0;
    while (off < size) {
      const { bytesRead } = await fh.read(buf, off, size - off, off);
      if (bytesRead === 0) throw new Error(`${name}: short read, ${off} of ${size} bytes`);
      off += bytesRead;
    }
    return sab;
  } finally {
    await fh.close();
  }
}

const u32 = (b: SharedArrayBuffer): Uint32Array => new Uint32Array(b);
const i32 = (b: SharedArrayBuffer): Int32Array => new Int32Array(b);
const f32 = (b: SharedArrayBuffer): Float32Array => new Float32Array(b);
const u8 = (b: SharedArrayBuffer): Uint8Array => new Uint8Array(b);

/** Reads the index off disk into shared memory. Once per process. */
export async function loadBundle(dir: string): Promise<ArtifactBundle> {
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8'),
  ) as Manifest;
  checkVersion(manifest);

  const loaded = await Promise.all(FILES.map((name) => readShared(dir, name)));
  const files = Object.fromEntries(
    FILES.map((name, i) => [name, loaded[i]!]),
  ) as Record<FileName, SharedArrayBuffer>;

  // One entry per string, so it is sized off the offset table rather than the
  // manifest: the projection below indexes it by name id.
  const numStrings = files['strings.idx'].byteLength / 4 - 1;
  const bundle: ArtifactBundle = {
    manifest, files,
    localityScore: new SharedArrayBuffer(4 * numStrings),
  };

  // Project the place layer onto a lookup by locality name id, writing through
  // a view of the shared buffer. Done before any worker exists, so no thread
  // can observe it half filled.
  const a = artifactFromBundle(bundle);
  for (let id = 0; id < manifest.num_anchors; id++) {
    if ((a.anchorFlags[id]! & 0x0f) !== LAYER_PLACE) continue;
    const nameID = a.anchorName[id]!;
    const score = a.anchorScore[id]!;
    if (score > a.localityScore[nameID]!) a.localityScore[nameID] = score;
  }
  return bundle;
}

function checkVersion(manifest: Manifest): void {
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `index artifact version ${manifest.version} is not supported ` +
      `(this server understands version ${SUPPORTED_VERSION}); rebuild with 'make index'`,
    );
  }
}

/**
 * Wraps a bundle in the typed views the query code reads. Allocates nothing of
 * consequence, so every thread can do it: the arrays are windows onto the same
 * bytes, and only the caches — the decoded strings and the folded tokens — are
 * per thread, which is what they should be.
 */
export function artifactFromBundle(bundle: ArtifactBundle): Artifact {
  const { manifest, files } = bundle;
  checkVersion(manifest);

  const countryByID: string[] = [];
  for (const [code, id] of Object.entries(manifest.country_ids)) countryByID[id] = code;

  const artifact: Artifact = {
    manifest,
    strings: new StringTable(u8(files['strings.bin']), u32(files['strings.idx'])),
    terms: new StringTable(u8(files['terms.bin']), u32(files['terms.idx'])),
    termsRev: new StringTable(u8(files['terms_rev.bin']), u32(files['terms_rev.idx'])),
    termRevId: u32(files['term_rev_id.bin']),
    postOff: u32(files['post_off.bin']),
    post: u32(files['post.bin']),
    anchorTerms: u32(files['anchor_terms.bin']),
    anchorTermsOff: u32(files['anchor_terms_off.bin']),
    anchorName: u32(files['anchor_name.bin']),
    anchorLocal: u32(files['anchor_local.bin']),
    anchorLat: i32(files['anchor_lat.bin']),
    anchorLon: i32(files['anchor_lon.bin']),
    anchorFlags: u8(files['anchor_flags.bin']),
    anchorCountry: u8(files['anchor_country.bin']),
    anchorScore: f32(files['anchor_score.bin']),
    anchorCat: u32(files['anchor_cat.bin']),
    anchorAlt: u32(files['anchor_alt.bin']),
    anchorNameTokens: u8(files['anchor_ntok.bin']),
    anchorMinLat: i32(files['anchor_minlat.bin']),
    anchorMinLon: i32(files['anchor_minlon.bin']),
    anchorMaxLat: i32(files['anchor_maxlat.bin']),
    anchorMaxLon: i32(files['anchor_maxlon.bin']),
    geom: i32(files['geom.bin']),
    geomOff: u32(files['geom_off.bin']),
    geomClosed: u8(files['geom_closed.bin']),
    kdPerm: u32(files['kd_perm.bin']),
    cellKey: i32(files['cell_key.bin']),
    cellStart: u32(files['cell_start.bin']),
    cellCount: u32(files['cell_count.bin']),
    cellItems: u32(files['cell_items.bin']),
    anchorAddrStart: u32(files['anchor_addr_start.bin']),
    anchorAddrCount: u32(files['anchor_addr_count.bin']),
    addrNum: u32(files['addr_num.bin']),
    addrLat: i32(files['addr_lat.bin']),
    addrLon: i32(files['addr_lon.bin']),
    addrSortKey: u32(files['addr_sortkey.bin']),
    countryByID,
    localityScore: f32(bundle.localityScore),
  };

  // Fail loudly at boot rather than producing wrong answers per request.
  if (artifact.anchorName.length !== manifest.num_anchors) {
    throw new Error(
      `anchor array length ${artifact.anchorName.length} != manifest ${manifest.num_anchors}`,
    );
  }
  if (artifact.addrNum.length !== manifest.num_addresses) {
    throw new Error(
      `address array length ${artifact.addrNum.length} != manifest ${manifest.num_addresses}`,
    );
  }
  if (artifact.anchorTermsOff.length !== manifest.num_anchors + 1) {
    throw new Error(
      `anchor term offsets ${artifact.anchorTermsOff.length} ` +
      `!= manifest ${manifest.num_anchors} + 1`,
    );
  }
  if (artifact.anchorTerms.length !== manifest.num_anchor_terms) {
    throw new Error(
      `anchor term array length ${artifact.anchorTerms.length} ` +
      `!= manifest ${manifest.num_anchor_terms}`,
    );
  }
  return artifact;
}

/** Load and wrap in one step: the single-threaded path, and what tests use. */
export async function loadArtifact(dir: string): Promise<Artifact> {
  return artifactFromBundle(await loadBundle(dir));
}

/** Joins an anchor's alternate names inside one interned string. */
export const ALT_SEP = '\x1f';

/**
 * Sentinels in `anchorTerms`, mirroring `ingest/internal/index`. Both sit above
 * any term id, so neither can be mistaken for one.
 */
export const TERM_SEP = 0xFFFFFFFF;
/** A token the dictionary does not hold: it occupies its place in the name, and
 * so still counts against how much of the name a query used, but matches
 * nothing. */
export const TERM_MISSING = 0xFFFFFFFE;

export const layerOf = (flags: number): number => flags & 0x0f;

/**
 * The anchor owning address `i`, by binary search over `anchorAddrStart`.
 * Storing it would cost 4 bytes per address — 244MB — to save ~23 comparisons.
 */
export function anchorOfAddress(a: Artifact, i: number): number {
  let lo = 0;
  let hi = a.anchorAddrStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (a.anchorAddrStart[mid]! <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
export const toDeg = (fixed: number): number => fixed / COORD_SCALE;

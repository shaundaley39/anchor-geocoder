/**
 * Loads the binary artifact produced by `ingest/cmd/geoindex`. Every file maps
 * onto one typed array, so loading is a read plus a view. The same data as
 * JavaScript objects would cost several GB and minutes of startup.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Layer codes, matching `ingest/internal/index`. */
export const LAYER_STREET = 0;
export const LAYER_PLACE = 1;
export const LAYER_POI = 2;

/** Fixed-point factor for coordinates; must match the Go `CoordScale`. */
export const COORD_SCALE = 1e7;

/** Layout version the server understands. */
export const SUPPORTED_VERSION = 8;

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
  country_ids: Record<string, number>;
  counts: Record<string, number>;
  bytes: Record<string, number>;
  duration: string;
}

/** One concatenated UTF-8 blob plus offsets. Decoded lazily, since a request
 * touches a handful of strings and decoding all of them would undo the layout. */
export class StringTable {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly cache: (string | undefined)[];

  constructor(
    private readonly blob: Uint8Array,
    private readonly offsets: Uint32Array,
  ) {
    this.cache = new Array<string | undefined>(offsets.length - 1);
  }

  get length(): number { return this.offsets.length - 1; }

  get(id: number): string {
    if (id < 0 || id >= this.length) return '';
    const hit = this.cache[id];
    if (hit !== undefined) return hit;
    const start = this.offsets[id]!;
    const end = this.offsets[id + 1]!;
    const s = this.decoder.decode(this.blob.subarray(start, end));
    this.cache[id] = s;
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

async function view(dir: string, name: string): Promise<Buffer> {
  return readFile(join(dir, name));
}

/** Reinterprets a Buffer as a typed array without copying. */
function asU32(b: Buffer): Uint32Array {
  return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
function asI32(b: Buffer): Int32Array {
  return new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
function asF32(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

export async function loadArtifact(dir: string): Promise<Artifact> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `index artifact version ${manifest.version} is not supported ` +
      `(this server understands version ${SUPPORTED_VERSION}); rebuild with 'make index'`,
    );
  }

  const [
    stringsBin, stringsIdx, termsBin, termsIdx,
    termsRevBin, termsRevIdx, termRevId,
    postOff, post,
    aName, aLocal, aLat, aLon, aFlags, aCountry, aScore, aCat, aAlt, aNTok,
    aMinLat, aMinLon, aMaxLat, aMaxLon, gGeom, gOff, gClosed,
    kdPerm, cKey, cStart, cCount, cItems,
    aStart, aCount,
    dNum, dLat, dLon, dSort,
  ] = await Promise.all([
    view(dir, 'strings.bin'), view(dir, 'strings.idx'),
    view(dir, 'terms.bin'), view(dir, 'terms.idx'),
    view(dir, 'terms_rev.bin'), view(dir, 'terms_rev.idx'),
    view(dir, 'term_rev_id.bin'),
    view(dir, 'post_off.bin'), view(dir, 'post.bin'),
    view(dir, 'anchor_name.bin'), view(dir, 'anchor_local.bin'),
    view(dir, 'anchor_lat.bin'), view(dir, 'anchor_lon.bin'),
    view(dir, 'anchor_flags.bin'), view(dir, 'anchor_country.bin'),
    view(dir, 'anchor_score.bin'),
    view(dir, 'anchor_cat.bin'), view(dir, 'anchor_alt.bin'),
    view(dir, 'anchor_ntok.bin'),
    view(dir, 'anchor_minlat.bin'), view(dir, 'anchor_minlon.bin'),
    view(dir, 'anchor_maxlat.bin'), view(dir, 'anchor_maxlon.bin'),
    view(dir, 'geom.bin'), view(dir, 'geom_off.bin'), view(dir, 'geom_closed.bin'),
    view(dir, 'kd_perm.bin'),
    view(dir, 'cell_key.bin'), view(dir, 'cell_start.bin'),
    view(dir, 'cell_count.bin'), view(dir, 'cell_items.bin'),
    view(dir, 'anchor_addr_start.bin'), view(dir, 'anchor_addr_count.bin'),
    view(dir, 'addr_num.bin'), view(dir, 'addr_lat.bin'), view(dir, 'addr_lon.bin'),
    view(dir, 'addr_sortkey.bin'),
  ]);

  const countryByID: string[] = [];
  for (const [code, id] of Object.entries(manifest.country_ids)) countryByID[id] = code;

  const artifact: Artifact = {
    manifest,
    strings: new StringTable(stringsBin, asU32(stringsIdx)),
    terms: new StringTable(termsBin, asU32(termsIdx)),
    termsRev: new StringTable(termsRevBin, asU32(termsRevIdx)),
    termRevId: asU32(termRevId),
    postOff: asU32(postOff),
    post: asU32(post),
    anchorName: asU32(aName),
    anchorLocal: asU32(aLocal),
    anchorLat: asI32(aLat),
    anchorLon: asI32(aLon),
    anchorFlags: new Uint8Array(aFlags.buffer, aFlags.byteOffset, aFlags.byteLength),
    anchorCountry: new Uint8Array(aCountry.buffer, aCountry.byteOffset, aCountry.byteLength),
    anchorScore: asF32(aScore),
    anchorCat: asU32(aCat),
    anchorAlt: asU32(aAlt),
    anchorNameTokens: new Uint8Array(aNTok.buffer, aNTok.byteOffset, aNTok.byteLength),
    anchorMinLat: asI32(aMinLat),
    anchorMinLon: asI32(aMinLon),
    anchorMaxLat: asI32(aMaxLat),
    anchorMaxLon: asI32(aMaxLon),
    geom: asI32(gGeom),
    geomOff: asU32(gOff),
    geomClosed: new Uint8Array(gClosed.buffer, gClosed.byteOffset, gClosed.byteLength),
    kdPerm: asU32(kdPerm),
    cellKey: asI32(cKey),
    cellStart: asU32(cStart),
    cellCount: asU32(cCount),
    cellItems: asU32(cItems),
    anchorAddrStart: asU32(aStart),
    anchorAddrCount: asU32(aCount),
    addrNum: asU32(dNum),
    addrLat: asI32(dLat),
    addrLon: asI32(dLon),
    addrSortKey: asU32(dSort),
    countryByID,
    localityScore: new Float32Array(0), // filled in below
  };

  // Project the place layer onto a lookup by locality name id.
  const localityScore = new Float32Array(artifact.strings.length);
  for (let id = 0; id < manifest.num_anchors; id++) {
    if ((artifact.anchorFlags[id]! & 0x0f) !== LAYER_PLACE) continue;
    const nameID = artifact.anchorName[id]!;
    const score = artifact.anchorScore[id]!;
    if (score > localityScore[nameID]!) localityScore[nameID] = score;
  }
  artifact.localityScore = localityScore;

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
  return artifact;
}

/** Joins an anchor's alternate names inside one interned string. */
export const ALT_SEP = '\x1f';

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

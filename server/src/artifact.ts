/**
 * Loads the binary index artifact produced by `ingest/cmd/geoindex`.
 *
 * Every file maps onto exactly one typed array, so loading is a read plus a
 * view — no parsing, no per-record objects. That is the whole reason the
 * artifact is shaped this way: 11.6M addresses as JavaScript objects would cost
 * several GB and minutes of startup, whereas the same data as struct-of-arrays
 * is ~254MB of buffers that the OS page cache can hand over directly.
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
export const SUPPORTED_VERSION = 4;

export interface Manifest {
  version: number;
  built_at: string;
  countries: string[];
  num_strings: number;
  num_anchors: number;
  num_addresses: number;
  num_terms: number;
  num_pois: number;
  num_postings: number;
  country_ids: Record<string, number>;
  counts: Record<string, number>;
  bytes: Record<string, number>;
  duration: string;
}

/**
 * A string table: one concatenated UTF-8 blob plus an offset array. Strings are
 * decoded lazily on access, because a request touches a handful of them and
 * decoding all 416,885 up front would undo the point of the layout.
 */
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

  /**
   * Returns the id range [lo, hi) of terms sharing `prefix`.
   *
   * Terms are stored sorted, so a prefix match is two binary searches rather
   * than a scan of 127,039 terms. This is what makes autocomplete on the final
   * query token cheap.
   */
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
   * Country id per anchor, indexing `countryByID`.
   *
   * Its own array rather than the high nibble of `anchorFlags`: four bits caps
   * at sixteen countries and the index already covers fourteen, so the next
   * additions would have silently wrapped into the layer bits.
   */
  anchorCountry: Uint8Array;
  anchorScore: Float32Array;
  /** POI category string id; 0 for non-POI anchors. */
  anchorCat: Uint32Array;
  /** String id of the anchor's alternate names, joined by ALT_SEP; 0 if none. */
  anchorAlt: Uint32Array;
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
   * Importance of each locality, indexed by its name's string id.
   *
   * Street and POI anchors all carry the same flat prior, so among the hundreds
   * of streets sharing a name there is nothing to rank on and the winner is
   * arbitrary: "Unter den Linden 1" resolved to a hamlet in Austria rather than
   * Berlin. This gives every anchor the standing of the place it is in.
   *
   * Derived at boot rather than stored: it is a projection of the place layer
   * already in the artifact, costs one pass over the anchors, and keeping it
   * out of the format means the ranking can be retuned without a rebuild.
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
    postOff, post,
    aName, aLocal, aLat, aLon, aFlags, aCountry, aScore, aCat, aAlt, aStart, aCount,
    dNum, dLat, dLon, dSort,
  ] = await Promise.all([
    view(dir, 'strings.bin'), view(dir, 'strings.idx'),
    view(dir, 'terms.bin'), view(dir, 'terms.idx'),
    view(dir, 'post_off.bin'), view(dir, 'post.bin'),
    view(dir, 'anchor_name.bin'), view(dir, 'anchor_local.bin'),
    view(dir, 'anchor_lat.bin'), view(dir, 'anchor_lon.bin'),
    view(dir, 'anchor_flags.bin'), view(dir, 'anchor_country.bin'),
    view(dir, 'anchor_score.bin'),
    view(dir, 'anchor_cat.bin'), view(dir, 'anchor_alt.bin'),
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

/** Separator joining an anchor's alternate names inside one interned string. */
export const ALT_SEP = '\x1f';

export const layerOf = (flags: number): number => flags & 0x0f;

/**
 * The anchor owning address `i`.
 *
 * Addresses are stored grouped by anchor, so this is a binary search over
 * `anchorAddrStart` for the last anchor whose run begins at or before `i` —
 * ~23 comparisons. Storing it explicitly would cost 4 bytes per address, which
 * is 244MB across the indexed region, to save that.
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

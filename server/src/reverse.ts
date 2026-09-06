/**
 * Reverse geocoding: a click on the map to the places at and around it.
 *
 * # The model
 *
 * A click asks "what is here", and the honest answer is a short ranked list
 * rather than a single feature: the building the user meant may not be mapped,
 * or may be the second-nearest thing. So results come back in two tiers.
 *
 *   1. Features whose outline *contains* the click, smallest area first.
 *      If you are standing inside something, that is where you are; and of two
 *      nested regions the smaller is the more specific answer — an open-air
 *      theatre in the corner of a park before the park itself.
 *   2. Everything else, by distance.
 *
 * Containment beats proximity outright. A restaurant 25m away is somewhere the
 * user is *not*, so it ranks below the park they are standing in — but directly
 * below it, ahead of anything further away.
 *
 * # Filter and refine
 *
 * Two indexes, because the two tiers ask different questions.
 *
 * A k-d tree over every point — 61M addresses plus 10.2M anchors — answers
 * "what is near". It cannot answer "what am I inside": the Englischer Garten is
 * 3.7km long, so a click at its north end sits ~2km from the stored centroid
 * and no proximity search with a sane radius would ever reach it.
 *
 * So containment gets its own index: a uniform grid over anchor bounding boxes,
 * where a feature is registered in every cell its box overlaps. A click looks
 * up one cell to get its candidates — the filter — and each candidate is then
 * tested against its actual simplified outline — the refine. The box alone
 * would not do: a diagonal or crescent-shaped feature fills a fraction of it.
 */
import { PointIndex } from './pointindex.js';
import { type Artifact, toDeg, anchorOfAddress } from './artifact.js';
import { haversineMetres } from './forward.js';
import { type GeocodeResult, anchorResult, addressResult } from './result.js';
import {
  containsPoint, distanceToShape, distanceToBBox, hasShape, ringAreaM2,
} from './geometry.js';

/** Geographic extent of the indexed data, in degrees. */
export interface BBox {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}

/**
 * Containment grid geometry. These mirror `ingest/internal/index/kdtree.go` and
 * are part of the artifact format: the build lists a feature in every cell its
 * bounding box touches, and a lookup here has to compute the same key. Changing
 * either constant requires a format version bump.
 */
const EXTENT_CELL_DEG = 0.05;   // ~5.5km
const CELL_ORIGIN = 4096;
const CELL_STRIDE = 16384;

/** Exposed so the format contract test can assert these against the Go writer. */
export const CELL_CONSTANTS = {
  deg: EXTENT_CELL_DEG, origin: CELL_ORIGIN, stride: CELL_STRIDE,
} as const;

export interface ReverseIndex {
  tree: PointIndex;
  bbox: BBox;
  /** Number of address points; ids at or above this index anchors. */
  addressCount: number;
}

function cellKey(lat: number, lon: number): number {
  const x = Math.floor(lon / EXTENT_CELL_DEG) + CELL_ORIGIN;
  const y = Math.floor(lat / EXTENT_CELL_DEG) + CELL_ORIGIN;
  return y * CELL_STRIDE + x;
}

/** Index of a cell key in the sorted key array, or -1. */
function findCell(a: Artifact, key: number): number {
  let lo = 0;
  let hi = a.cellKey.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = a.cellKey[mid]!;
    if (v === key) return mid;
    if (v < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Assembles the reverse index from the artifact.
 *
 * Both spatial structures are precomputed by the build, so this is a scan for
 * the coverage box and nothing else. It used to partition 15.9M points into a
 * k-d tree (~3.0s) and construct the containment grid (~2.4s) — startup work
 * that every replica repeated on every deploy and rollback, to recompute a pure
 * function of data already in the file.
 */
export function buildReverseIndex(a: Artifact): ReverseIndex {
  const nAddr = a.manifest.num_addresses;

  // One tree over addresses and anchors alike. Anchors have to be in it or a
  // click can never return a park, a station or a street — only the nearest
  // doorway, which is what the first version of this did.
  //
  // Point ids below nAddr index the address arrays; at or above it, the anchor
  // arrays. The tree reads coordinates through these accessors rather than
  // copying them, which on the four-country build saved 128MB of duplicate.
  const getY = (id: number) => (id < nAddr ? a.addrLat[id]! : a.anchorLat[id - nAddr]!);
  const getX = (id: number) => (id < nAddr ? a.addrLon[id]! : a.anchorLon[id - nAddr]!);
  const tree = PointIndex.fromPermutation(
    a.kdPerm, getX, getY, a.manifest.kd_node_size,
  );

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < nAddr; i++) {
    const lat = a.addrLat[i]!;
    const lon = a.addrLon[i]!;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  return {
    tree,
    addressCount: nAddr,
    bbox: {
      minLat: toDeg(minLat), maxLat: toDeg(maxLat),
      minLon: toDeg(minLon), maxLon: toDeg(maxLon),
    },
  };
}

export function inBBox(b: BBox, lat: number, lon: number): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

/**
 * Detects the classic lat/lon transposition.
 *
 * The forward response returns `center` in GeoJSON order, [lon, lat], while the
 * reverse parameters are named lat and lon. Reading one straight into the other
 * transposes them, and for this region the result is off Somalia. Reported only
 * when the given point is outside coverage AND the swapped one is inside it, so
 * a genuine query from elsewhere is never second-guessed.
 */
export function looksTransposed(b: BBox, lat: number, lon: number): boolean {
  return !inBBox(b, lat, lon) && inBBox(b, lon, lat);
}

export interface ReverseOptions {
  limit?: number;
  /** Maximum search radius in metres for the proximity tier. */
  radius?: number;
  country?: string;
}

const M_PER_DEG_LAT = 111_320;

/** How many containing regions may occupy the head of the list. */
const MAX_CONTAINING = 4;

interface Candidate {
  /** Anchor id, or -1 when this is a bare address point. */
  anchorID: number;
  /** Address index, or -1 when this is an anchor. */
  addrIdx: number;
  distance: number;
  /** Ring area in m², only for containing regions. */
  area: number;
  containing: boolean;
}

/**
 * Returns the places at and around a point, containing regions first.
 */
export function reverse(
  a: Artifact, idx: ReverseIndex, lat: number, lon: number, opts: ReverseOptions = {},
): GeocodeResult[] {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const maxRadius = Math.min(opts.radius ?? 5_000, 50_000);
  const wantCountry = opts.country
    ? a.manifest.country_ids[opts.country.toLowerCase()]
    : undefined;

  const okCountry = (anchorID: number) =>
    wantCountry === undefined || a.anchorCountry[anchorID] === wantCountry;

  // ---- tier 1: regions containing the click ------------------------------
  const containing: Candidate[] = [];
  const seenAnchor = new Set<number>();
  const cell = findCell(a, cellKey(lat, lon));
  if (cell >= 0) {
    const from = a.cellStart[cell]!;
    const len = a.cellCount[cell]!;
    for (let i = from; i < from + len; i++) {
      const id = a.cellItems[i]!;
      if (seenAnchor.has(id) || !okCountry(id)) continue;
      if (distanceToBBox(a, id, lat, lon) > 0) continue;   // filter: the box
      if (!containsPoint(a, id, lat, lon)) continue;        // refine: the ring
      seenAnchor.add(id);
      containing.push({
        anchorID: id, addrIdx: -1, distance: 0,
        area: ringAreaM2(a, id), containing: true,
      });
    }
  }
  // Smallest first: the more specific region is the better answer.
  containing.sort((x, y) => x.area - y.area);
  const head = containing.slice(0, MAX_CONTAINING);

  // ---- tier 2: everything else, by distance -------------------------------
  // Containing regions past the cap are not discarded — they join the
  // proximity tier at distance zero, so they sit at its head rather than
  // disappearing from the results altogether.
  const near: Candidate[] = containing.slice(MAX_CONTAINING)
    .map((c) => ({ ...c, containing: false }));
  const scale = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  let radius = 150;

  const overflow = near.length;
  while (radius <= maxRadius) {
    near.length = overflow;
    const dLat = radius / M_PER_DEG_LAT;
    const dLon = dLat / scale;
    idx.tree.range(
      Math.round((lon - dLon) * 1e7), Math.round((lat - dLat) * 1e7),
      Math.round((lon + dLon) * 1e7), Math.round((lat + dLat) * 1e7),
      (i) => {
      if (i < idx.addressCount) {
        const anchorID = anchorOfAddress(a, i);
        if (!okCountry(anchorID)) return;
        const d = haversineMetres(lat, lon, toDeg(a.addrLat[i]!), toDeg(a.addrLon[i]!));
        if (d <= radius) {
          near.push({ anchorID, addrIdx: i, distance: d, area: 0, containing: false });
        }
        return;
      }
      const id = i - idx.addressCount;
      if (seenAnchor.has(id) || !okCountry(id)) return;
      // Where a shape exists, measure to it rather than to the representative
      // point: a click at one end of a 2km street is not 1km from the street.
      const d = hasShape(a, id)
        ? distanceToShape(a, id, lat, lon)
        : haversineMetres(lat, lon, toDeg(a.anchorLat[id]!), toDeg(a.anchorLon[id]!));
      if (d <= radius) {
        near.push({ anchorID: id, addrIdx: -1, distance: d, area: 0, containing: false });
      }
      });
    if (near.length + head.length >= limit) break;
    if (radius >= maxRadius) break;
    radius = Math.min(radius * 4, maxRadius);
  }

  near.sort((x, y) => x.distance - y.distance);

  const out: GeocodeResult[] = [];
  for (const c of [...head, ...near]) {
    if (out.length >= limit) break;
    out.push(toResult(a, c));
  }
  return out;
}

function toResult(a: Artifact, c: Candidate): GeocodeResult {
  // Containing regions are ordered by area, everything else by distance, so the
  // two tiers need different scores; both are monotonically decreasing.
  const score = c.containing ? 1000 / (1 + c.area / 1e4) : 1 / (1 + c.distance);
  const extra: Partial<GeocodeResult> = {
    score,
    distance: Math.round(c.distance * 10) / 10,
    ...(c.containing ? { containing: true, areaM2: Math.round(c.area) } : {}),
  };
  return c.addrIdx >= 0
    ? addressResult(a, c.addrIdx, c.anchorID, score, extra)
    : anchorResult(a, c.anchorID, score, extra);
}

/**
 * Reverse geocoding: a click to the places at and around it.
 *
 * Two tiers. Outlines containing the click come first, smallest area first,
 * since the smaller of two nested regions is the more specific answer.
 * Everything else follows by distance — a restaurant 25m away is somewhere the
 * user is not.
 *
 * Two indexes, because the tiers ask different questions. A k-d tree over points
 * answers "what is near" but not "what am I inside": a large park's centroid can
 * be kilometres from the click. Containment gets a grid over bounding boxes,
 * filtered by cell and refined against the outline.
 */
import { PointIndex } from './pointindex.js';
import { type Artifact, toDeg, anchorOfAddress } from './artifact.js';
import { type GeocodeResult, anchorResult, addressResult } from './result.js';
import {
  containsPoint, distanceToShape, distanceToBBox, hasShape, ringAreaM2,
  haversineMetres,
} from './geometry.js';

/** Geographic extent of the indexed data, in degrees. */
export interface BBox {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}

/**
 * Containment grid geometry, mirroring `ingest/internal/index/kdtree.go`. Part
 * of the format: the build lists a feature in every cell its box touches and a
 * lookup recomputes the key, so a change needs a version bump.
 * `test/format.contract.test.ts` asserts these against the Go values.
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
  /** Extent of each country's data, by country id; null where it has none. */
  countryBBox: (BBox | null)[];
}

/** What one pass over the data can say about where it is. */
export interface Coverage {
  bbox: BBox;
  byCountry: (BBox | null)[];
}

function cellKey(lat: number, lon: number): number {
  const x = Math.floor(lon / EXTENT_CELL_DEG) + CELL_ORIGIN;
  const y = Math.floor(lat / EXTENT_CELL_DEG) + CELL_ORIGIN;
  return y * CELL_STRIDE + x;
}

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

/** Grows a fixed-point box to hold a point. */
function extend(b: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  lat: number, lon: number): void {
  if (lat < b.minLat) b.minLat = lat;
  if (lat > b.maxLat) b.maxLat = lat;
  if (lon < b.minLon) b.minLon = lon;
  if (lon > b.maxLon) b.maxLon = lon;
}

const EMPTY = (): { minLat: number; maxLat: number; minLon: number; maxLon: number } =>
  ({ minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity });

/**
 * Where the data is: overall, and per country.
 *
 * One pass, because it is the one part of the boot that is real work and every
 * thread would reach the same answer, so the pool does it once and hands the
 * result to the workers.
 *
 * The per-country boxes exist to answer "could there be anything of this
 * country near this point" before searching for it. Built from anchor extents
 * and every address hanging off them rather than from anchor centroids, so the
 * answer is never a false no — it is used to skip work, and skipping work that
 * would have found something is a wrong result, not an optimisation.
 */
export function coverage(a: Artifact): Coverage {
  const all = EMPTY();
  const byCountry = Array.from({ length: 256 }, EMPTY);

  // Addresses are grouped behind the anchor they hang off and the grouping is a
  // partition, so walking anchors reaches every address exactly once and the
  // overall box comes out of the same walk. It stays address-only, as it was:
  // it is the coverage the API reports and the transposition check tests
  // against, and anchor extents reach places no address does.
  for (let id = 0; id < a.manifest.num_anchors; id++) {
    const c = byCountry[a.anchorCountry[id]!]!;
    extend(c, a.anchorMinLat[id]!, a.anchorMinLon[id]!);
    extend(c, a.anchorMaxLat[id]!, a.anchorMaxLon[id]!);
    const from = a.anchorAddrStart[id]!;
    const to = from + a.anchorAddrCount[id]!;
    for (let i = from; i < to; i++) {
      const lat = a.addrLat[i]!;
      const lon = a.addrLon[i]!;
      extend(c, lat, lon);
      extend(all, lat, lon);
    }
  }

  const deg = (b: ReturnType<typeof EMPTY>): BBox | null => (b.minLat === Infinity ? null : {
    minLat: toDeg(b.minLat), maxLat: toDeg(b.maxLat),
    minLon: toDeg(b.minLon), maxLon: toDeg(b.maxLon),
  });
  return { bbox: deg(all)!, byCountry: byCountry.map(deg) };
}

/** The overall box on its own, for callers that want nothing else. */
export function coverageBBox(a: Artifact): BBox {
  return coverage(a).bbox;
}

/** Both spatial structures arrive precomputed, so this is a scan for the
 * coverage box and nothing else. Building them here cost 5.4s of startup, on
 * every replica on every deploy. */
export function buildReverseIndex(a: Artifact, cov?: Coverage): ReverseIndex {
  const nAddr = a.manifest.num_addresses;

  // Addresses and anchors in one tree: without the anchors a click can only
  // return the nearest doorway, never a park or a station. Ids below nAddr index
  // the address arrays, at or above them the anchors. Read through accessors
  // rather than copied, which saves 128MB.
  const getY = (id: number) => (id < nAddr ? a.addrLat[id]! : a.anchorLat[id - nAddr]!);
  const getX = (id: number) => (id < nAddr ? a.addrLon[id]! : a.anchorLon[id - nAddr]!);
  const tree = PointIndex.fromPermutation(
    a.kdPerm, getX, getY, a.manifest.kd_node_size,
  );

  const c = cov ?? coverage(a);
  return { tree, addressCount: nAddr, bbox: c.bbox, countryBBox: c.byCountry };
}

export function inBBox(b: BBox, lat: number, lon: number): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

/**
 * Detects the classic lat/lon transposition: GeoJSON `center` is [lon, lat]
 * while the parameters are named lat and lon, so feeding one into the other
 * lands this region off Somalia. Only reported when the given point is outside
 * coverage and the swapped one is inside, so genuine queries are not
 * second-guessed.
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
const MAX_CONTAINING = 3;

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

/** Places at and around a point, containing regions first. */
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

  // A filter that nothing nearby can satisfy is the expensive case, because the
  // radius escalates to its cap looking for a match and the last sweep measures
  // every point in a 100km box before discarding it: country=pt clicked on
  // Berlin cost 110ms against 0.04ms unfiltered. The country's own extent
  // settles it in four comparisons, and settles it exactly — the box is built
  // from anchor extents and their addresses, so it cannot rule out a match that
  // the search would have found.
  if (wantCountry !== undefined) {
    const box = idx.countryBBox[wantCountry];
    if (box === undefined || box === null) return [];
    const padLat = maxRadius / M_PER_DEG_LAT;
    const padLon = padLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
    if (lat < box.minLat - padLat || lat > box.maxLat + padLat
      || lon < box.minLon - padLon || lon > box.maxLon + padLon) return [];
  }

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
  // Regions past the cap join the proximity tier at distance zero rather than
  // disappearing.
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
      // Measure to the shape: a click at one end of a 2km street is not 1km
      // from the street.
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
  // The tiers order by different things, so they score differently; both are
  // monotonically decreasing.
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

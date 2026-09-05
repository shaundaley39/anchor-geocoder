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
import KDBush from 'kdbush';
import { type Artifact, toDeg, anchorOfAddress, layerOf, LAYER_PLACE } from './artifact.js';
import { type GeocodeResult, haversineMetres, anchorBBox } from './forward.js';
import {
  containsPoint, distanceToShape, distanceToBBox, hasShape, isClosed, ringAreaM2,
} from './geometry.js';

/** Geographic extent of the indexed data, in degrees. */
export interface BBox {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}

/**
 * Cell size of the containment grid, in degrees (~5.5km).
 *
 * A feature is listed in every cell its bounding box touches, so small cells
 * multiply large features across many entries while large cells return too many
 * candidates per lookup. At this size a city park occupies one or two cells and
 * a lookup returns a handful of candidates.
 */
const EXTENT_CELL_DEG = 0.05;

/** Features whose box is smaller than this are found by the k-d tree anyway. */
const MIN_EXTENT_M = 30;

export interface ReverseIndex {
  tree: KDBush;
  bbox: BBox;
  /** Number of address points; ids at or above this index anchors. */
  addressCount: number;
  /**
   * Containment grid as a flat CSR: `cellRuns` maps a cell key to the
   * [start, length] of its slice of `cellItems`. Flat rather than a map of
   * arrays because there are millions of entries and one typed array costs a
   * fraction of the per-object overhead.
   */
  cellRuns: Map<number, [number, number]>;
  cellItems: Uint32Array;
}

function cellKey(lat: number, lon: number): number {
  const x = Math.floor(lon / EXTENT_CELL_DEG) + 4096;
  const y = Math.floor(lat / EXTENT_CELL_DEG) + 4096;
  return y * 16384 + x;
}

export function buildReverseIndex(a: Artifact): ReverseIndex {
  const nAddr = a.manifest.num_addresses;
  const nAnchor = a.manifest.num_anchors;

  // One tree over addresses and anchors alike. Anchors have to be in it or a
  // click can never return a park, a station or a street — only the nearest
  // doorway, which is what the first version of this did.
  const tree = new KDBush(nAddr + nAnchor, 64, Int32Array);

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < nAddr; i++) {
    const lat = a.addrLat[i]!;
    const lon = a.addrLon[i]!;
    tree.add(lon, lat);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  for (let id = 0; id < nAnchor; id++) {
    tree.add(a.anchorLon[id]!, a.anchorLat[id]!);
  }
  tree.finish();

  // Containment grid, built as a counting sort so it is one flat array rather
  // than several million small ones.
  const counts = new Map<number, number>();
  const visit = (fn: (key: number, id: number) => void) => {
    for (let id = 0; id < nAnchor; id++) {
      if (!hasShape(a, id) || !isClosed(a, id)) continue;
      const lo = toDeg(a.anchorMinLat[id]!);
      const hi = toDeg(a.anchorMaxLat[id]!);
      const lw = toDeg(a.anchorMinLon[id]!);
      const hw = toDeg(a.anchorMaxLon[id]!);
      if ((hi - lo) * 111_320 < MIN_EXTENT_M && (hw - lw) * 111_320 < MIN_EXTENT_M) continue;
      for (let y = Math.floor(lo / EXTENT_CELL_DEG); y <= Math.floor(hi / EXTENT_CELL_DEG); y++) {
        for (let x = Math.floor(lw / EXTENT_CELL_DEG); x <= Math.floor(hw / EXTENT_CELL_DEG); x++) {
          fn((y + 4096) * 16384 + (x + 4096), id);
        }
      }
    }
  };
  visit((key) => counts.set(key, (counts.get(key) ?? 0) + 1));

  const cellRuns = new Map<number, [number, number]>();
  let running = 0;
  for (const [key, n] of counts) {
    cellRuns.set(key, [running, n]);
    running += n;
  }
  const cellItems = new Uint32Array(running);
  const cursor = new Map<number, number>();
  for (const [key, [s0]] of cellRuns) cursor.set(key, s0);
  visit((key, id) => {
    const at = cursor.get(key)!;
    cellItems[at] = id;
    cursor.set(key, at + 1);
  });

  return {
    tree,
    addressCount: nAddr,
    cellRuns,
    cellItems,
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
  const run = idx.cellRuns.get(cellKey(lat, lon));
  if (run !== undefined) {
    const [from, len] = run;
    for (let i = from; i < from + len; i++) {
      const id = idx.cellItems[i]!;
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
    const hits = idx.tree.range(
      Math.round((lon - dLon) * 1e7), Math.round((lat - dLat) * 1e7),
      Math.round((lon + dLon) * 1e7), Math.round((lat + dLat) * 1e7),
    );

    for (const i of hits) {
      if (i < idx.addressCount) {
        const anchorID = anchorOfAddress(a, i);
        if (!okCountry(anchorID)) continue;
        const d = haversineMetres(lat, lon, toDeg(a.addrLat[i]!), toDeg(a.addrLon[i]!));
        if (d <= radius) {
          near.push({ anchorID, addrIdx: i, distance: d, area: 0, containing: false });
        }
        continue;
      }
      const id = i - idx.addressCount;
      if (seenAnchor.has(id) || !okCountry(id)) continue;
      // Where a shape exists, measure to it rather than to the representative
      // point: a click at one end of a 2km street is not 1km from the street.
      const d = hasShape(a, id)
        ? distanceToShape(a, id, lat, lon)
        : haversineMetres(lat, lon, toDeg(a.anchorLat[id]!), toDeg(a.anchorLon[id]!));
      if (d <= radius) {
        near.push({ anchorID: id, addrIdx: -1, distance: d, area: 0, containing: false });
      }
    }
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
  const anchorID = c.anchorID;
  const flags = a.anchorFlags[anchorID]!;
  const isAddr = c.addrIdx >= 0;
  const layer = isAddr
    ? 'address' as const
    : layerOf(flags) === LAYER_PLACE ? 'place' as const
      : layerOf(flags) === 2 ? 'poi' as const : 'street' as const;
  const category = !isAddr && layerOf(flags) === 2
    ? a.strings.get(a.anchorCat[anchorID]!)
    : undefined;

  return {
    id: isAddr ? `addr:${c.addrIdx}` : `anchor:${anchorID}`,
    layer,
    name: a.strings.get(a.anchorName[anchorID]!),
    locality: a.strings.get(a.anchorLocal[anchorID]!),
    ...(isAddr ? { houseNumber: a.strings.get(a.addrNum[c.addrIdx]!) } : {}),
    country: a.countryByID[a.anchorCountry[anchorID]!] ?? '',
    ...(category ? { category } : {}),
    lat: isAddr ? toDeg(a.addrLat[c.addrIdx]!) : toDeg(a.anchorLat[anchorID]!),
    lon: isAddr ? toDeg(a.addrLon[c.addrIdx]!) : toDeg(a.anchorLon[anchorID]!),
    score: c.containing ? 1000 / (1 + c.area / 1e4) : 1 / (1 + c.distance),
    distance: Math.round(c.distance * 10) / 10,
    ...(c.containing ? { containing: true, areaM2: Math.round(c.area) } : {}),
    ...(isAddr ? {} : anchorBBox(a, anchorID) ? { bbox: anchorBBox(a, anchorID)! } : {}),
  };
}

/**
 * Reverse geocoding: a point to the nearest addresses.
 *
 * Uses a static k-d tree over all 11.6M address points. `kdbush` is the right
 * fit because it builds over flat typed arrays and stores its index the same
 * way — no per-point JavaScript objects, so 11.6M points cost ~140MB and no GC
 * pressure, versus several GB and a stalling heap for an array of objects.
 *
 * The tree is built at boot rather than serialized. It takes a few seconds,
 * which is cheaper than adding a bespoke serialization format to the artifact
 * and keeps the artifact independent of kdbush's internal layout.
 */
import KDBush from 'kdbush';
import { type Artifact, toDeg, anchorOfAddress } from './artifact.js';
import { type GeocodeResult, haversineMetres } from './forward.js';

/** Geographic extent of the indexed data, in degrees. */
export interface BBox {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}

export interface ReverseIndex {
  tree: KDBush;
  bbox: BBox;
}

export function buildReverseIndex(a: Artifact): ReverseIndex {
  const n = a.manifest.num_addresses;
  // Int32Array coordinates: the tree indexes the raw fixed-point values, so no
  // float conversion happens during the build and precision is exact.
  const tree = new KDBush(n, 64, Int32Array);

  // The coverage extent comes free from a loop we are already running, and
  // powers the swapped-coordinate hint below.
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < n; i++) {
    const lat = a.addrLat[i]!;
    const lon = a.addrLon[i]!;
    tree.add(lon, lat);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  tree.finish();

  return {
    tree,
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
 * This is the most common mistake made against any geocoding API, and this one
 * invites it: the forward response returns `center` in GeoJSON order, which is
 * [lon, lat], while the reverse parameters are named `lat` and `lon`. Reading
 * the array left to right into the parameters transposes them, and for Czechia
 * and Poland the result — around 16°N 49°E — is off Somalia, so the honest
 * answer is an empty list and the user is left guessing.
 *
 * Returns true only when the given point is outside coverage AND the swapped
 * one is inside it, so a genuine query from outside the region is never
 * second-guessed.
 */
export function looksTransposed(b: BBox, lat: number, lon: number): boolean {
  return !inBBox(b, lat, lon) && inBBox(b, lon, lat);
}

/**
 * Degrees of longitude per degree of latitude at this latitude.
 *
 * The k-d tree is built in raw lat/lon, where a degree of longitude is shorter
 * than a degree of latitude everywhere but the equator (~0.64x at Poland's
 * latitude). Searching a square box in that space is therefore an ellipse on
 * the ground, so the box is widened in longitude to guarantee it encloses the
 * true circle. Results are still ranked by real great-circle distance.
 */
function lonScale(lat: number): number {
  return Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
}

export interface ReverseOptions {
  limit?: number;
  /** Maximum search radius in metres. */
  radius?: number;
  country?: string;
}

const M_PER_DEG_LAT = 111_320;

/**
 * Returns the nearest address points, closest first.
 *
 * Rather than a single fixed radius, the search grows: most queries land in a
 * populated area and are satisfied by the first small box, while a query in the
 * middle of a forest widens until it finds something or hits the cap. That
 * keeps the common case fast without failing the sparse one.
 */
export function reverse(
  a: Artifact, idx: ReverseIndex, lat: number, lon: number, opts: ReverseOptions = {},
): GeocodeResult[] {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const maxRadius = Math.min(opts.radius ?? 5_000, 50_000);
  const wantCountry = opts.country
    ? a.manifest.country_ids[opts.country.toLowerCase()]
    : undefined;

  const scale = lonScale(lat);
  let radius = 150;
  let found: { idx: number; dist: number }[] = [];

  while (radius <= maxRadius) {
    const dLat = (radius / M_PER_DEG_LAT);
    const dLon = dLat / scale;

    const minLat = Math.round((lat - dLat) * 1e7);
    const maxLat = Math.round((lat + dLat) * 1e7);
    const minLon = Math.round((lon - dLon) * 1e7);
    const maxLon = Math.round((lon + dLon) * 1e7);

    const hits = idx.tree.range(minLon, minLat, maxLon, maxLat);
    if (hits.length > 0) {
      found = [];
      for (const i of hits) {
        if (wantCountry !== undefined &&
            a.anchorCountry[anchorOfAddress(a, i)] !== wantCountry) continue;
        const d = haversineMetres(lat, lon, toDeg(a.addrLat[i]!), toDeg(a.addrLon[i]!));
        // The box is a square in degree space; discard the corners that fall
        // outside the true circle so the radius means what it says.
        if (d <= radius) found.push({ idx: i, dist: d });
      }
      if (found.length >= limit) break;
    }
    if (radius >= maxRadius) break;
    radius = Math.min(radius * 4, maxRadius);
  }

  found.sort((x, y) => x.dist - y.dist);

  return found.slice(0, limit).map(({ idx: i, dist }) => {
    const anchorID = anchorOfAddress(a, i);
    return {
      id: `addr:${i}`,
      layer: 'address' as const,
      name: a.strings.get(a.anchorName[anchorID]!),
      locality: a.strings.get(a.anchorLocal[anchorID]!),
      houseNumber: a.strings.get(a.addrNum[i]!),
      country: a.countryByID[a.anchorCountry[anchorID]!] ?? '',
      lat: toDeg(a.addrLat[i]!),
      lon: toDeg(a.addrLon[i]!),
      score: 1 / (1 + dist),
      distance: Math.round(dist * 10) / 10,
    };
  });
}

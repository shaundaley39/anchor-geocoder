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
import { type Artifact, toDeg, countryOf } from './artifact.js';
import { type GeocodeResult, haversineMetres } from './forward.js';

export interface ReverseIndex {
  tree: KDBush;
}

export function buildReverseIndex(a: Artifact): ReverseIndex {
  const n = a.manifest.num_addresses;
  // Int32Array coordinates: the tree indexes the raw fixed-point values, so no
  // float conversion happens during the build and precision is exact.
  const tree = new KDBush(n, 64, Int32Array);
  for (let i = 0; i < n; i++) tree.add(a.addrLon[i]!, a.addrLat[i]!);
  tree.finish();
  return { tree };
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
        if (wantCountry !== undefined) {
          const flags = a.anchorFlags[a.addrAnchor[i]!]!;
          if (countryOf(flags) !== wantCountry) continue;
        }
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
    const anchorID = a.addrAnchor[i]!;
    const flags = a.anchorFlags[anchorID]!;
    return {
      id: `addr:${i}`,
      layer: 'address' as const,
      name: a.strings.get(a.anchorName[anchorID]!),
      locality: a.strings.get(a.anchorLocal[anchorID]!),
      houseNumber: a.strings.get(a.addrNum[i]!),
      country: a.countryByID[countryOf(flags)] ?? '',
      lat: toDeg(a.addrLat[i]!),
      lon: toDeg(a.addrLon[i]!),
      score: 1 / (1 + dist),
      distance: Math.round(dist * 10) / 10,
    };
  });
}

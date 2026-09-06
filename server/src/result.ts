/**
 * Turning an index row into an API result.
 *
 * Forward and reverse both do this, and they used to do it separately: three
 * near-identical builders, each mapping the layer code to a name, deciding
 * whether a category applies, and assembling a bounding box. The copies had
 * already drifted — one of them tested `layerOf(flags) === 2` against a literal
 * rather than the constant, which is exactly the line that breaks silently if
 * the layer codes ever move.
 */
import {
  type Artifact, layerOf, toDeg, LAYER_STREET, LAYER_PLACE, LAYER_POI,
} from './artifact.js';

export type Layer = 'address' | 'street' | 'place' | 'poi';

export interface GeocodeResult {
  id: string;
  layer: Layer;
  name: string;
  locality: string;
  houseNumber?: string;
  /** OSM classification for POIs, e.g. "amenity=restaurant". */
  category?: string;
  country: string;
  lat: number;
  lon: number;
  score: number;
  /** Metres from the query point; reverse geocoding only. */
  distance?: number;
  /** True when the query point falls inside this feature's outline. */
  containing?: boolean;
  /** Area of the containing region in m², which is what orders tier one. */
  areaM2?: number;
  /** Bounding box as [minLon, minLat, maxLon, maxLat], for the UI to zoom to. */
  bbox?: [number, number, number, number];
}

/** Layer code to the name the API uses. */
export function layerName(code: number): Exclude<Layer, 'address'> {
  switch (code) {
    case LAYER_PLACE: return 'place';
    case LAYER_POI:   return 'poi';
    case LAYER_STREET: return 'street';
    default:          return 'street';
  }
}

/**
 * The anchor's extent as a GeoJSON bbox, or undefined when it has none.
 *
 * Degenerate boxes — every anchor without a shape stores its own point twice —
 * are suppressed: a zero-area bbox tells a UI nothing and would make it zoom to
 * a pinpoint.
 */
export function anchorBBox(
  a: Artifact, id: number,
): [number, number, number, number] | undefined {
  const minLat = a.anchorMinLat[id]!;
  const maxLat = a.anchorMaxLat[id]!;
  const minLon = a.anchorMinLon[id]!;
  const maxLon = a.anchorMaxLon[id]!;
  if (minLat === maxLat && minLon === maxLon) return undefined;
  return [toDeg(minLon), toDeg(minLat), toDeg(maxLon), toDeg(maxLat)];
}

/**
 * Fields every result carries, whether it names an anchor or an address.
 *
 * `withExtent` is false for address points: they have no extent of their own,
 * and the anchor's box describes the whole street, which is not what the caller
 * asked about.
 */
function common(a: Artifact, anchorID: number, withExtent: boolean) {
  const bbox = withExtent ? anchorBBox(a, anchorID) : undefined;
  return {
    name: a.strings.get(a.anchorName[anchorID]!),
    locality: a.strings.get(a.anchorLocal[anchorID]!),
    country: a.countryByID[a.anchorCountry[anchorID]!] ?? '',
    ...(bbox ? { bbox } : {}),
  };
}

/** A street, place or POI in its own right. */
export function anchorResult(
  a: Artifact, id: number, score: number,
  extra: Partial<GeocodeResult> = {},
): GeocodeResult {
  const code = layerOf(a.anchorFlags[id]!);
  const category = code === LAYER_POI ? a.strings.get(a.anchorCat[id]!) : undefined;
  return {
    id: `anchor:${id}`,
    layer: layerName(code),
    ...common(a, id, true),
    ...(category ? { category } : {}),
    lat: toDeg(a.anchorLat[id]!),
    lon: toDeg(a.anchorLon[id]!),
    score,
    ...extra,
  };
}

/** One address point, named by the anchor it hangs off. */
export function addressResult(
  a: Artifact, addrIdx: number, anchorID: number, score: number,
  extra: Partial<GeocodeResult> = {},
): GeocodeResult {
  return {
    id: `addr:${addrIdx}`,
    layer: 'address',
    ...common(a, anchorID, false),
    houseNumber: a.strings.get(a.addrNum[addrIdx]!),
    lat: toDeg(a.addrLat[addrIdx]!),
    lon: toDeg(a.addrLon[addrIdx]!),
    score,
    ...extra,
  };
}

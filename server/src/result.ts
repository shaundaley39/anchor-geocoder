/**
 * Shared by forward and reverse. They used to do this separately and the copies
 * had drifted: one tested `layerOf(flags) === 2` against a literal rather than
 * the constant, the sort of line that breaks silently if layer codes move.
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

export function layerName(code: number): Exclude<Layer, 'address'> {
  switch (code) {
    case LAYER_PLACE: return 'place';
    case LAYER_POI:   return 'poi';
    case LAYER_STREET: return 'street';
    default:          return 'street';
  }
}

/** Degenerate boxes are suppressed: an anchor with no shape stores its own point
 * twice, and a zero-area bbox makes a UI zoom to a pinpoint. */
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

/** `withExtent` is false for address points, since the anchor's box describes
 * the whole street rather than the address. */
function common(a: Artifact, anchorID: number, withExtent: boolean) {
  const bbox = withExtent ? anchorBBox(a, anchorID) : undefined;
  return {
    name: a.strings.get(a.anchorName[anchorID]!),
    locality: a.strings.get(a.anchorLocal[anchorID]!),
    country: a.countryByID[a.anchorCountry[anchorID]!] ?? '',
    ...(bbox ? { bbox } : {}),
  };
}

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

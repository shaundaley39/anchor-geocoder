/**
 * GeoJSON rendering.
 *
 * The response is a FeatureCollection shaped after the conventional geocoding
 * API, so the endpoint is a drop-in for anything already speaking that dialect.
 */
import type { GeocodeResult } from './forward.js';

export interface Feature {
  type: 'Feature';
  id: string;
  /** [minLon, minLat, maxLon, maxLat]; absent for features with no extent. */
  bbox?: [number, number, number, number];
  place_type: string[];
  text: string;
  place_name: string;
  center: [number, number];
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
  relevance: number;
}

/** Renders the one-line human-facing form, skipping absent components. */
export function placeName(r: GeocodeResult): string {
  const head = r.houseNumber ? `${r.name} ${r.houseNumber}` : r.name;
  const parts = [head];
  // Suppress a locality identical to the name, so a village address anchored on
  // its own name does not render "Velká Úpa 42, Velká Úpa".
  if (r.locality && r.locality.toLowerCase() !== r.name.toLowerCase()) {
    parts.push(r.locality);
  }
  parts.push(r.country.toUpperCase());
  return parts.filter(Boolean).join(', ');
}

export function toFeature(r: GeocodeResult): Feature {
  const coords: [number, number] = [
    Math.round(r.lon * 1e7) / 1e7,
    Math.round(r.lat * 1e7) / 1e7,
  ];
  const props: Record<string, unknown> = {
    layer: r.layer,
    name: r.name,
    country: r.country,
  };
  if (r.locality) props['locality'] = r.locality;
  if (r.category !== undefined) props['category'] = r.category;
  if (r.houseNumber !== undefined) props['house_number'] = r.houseNumber;
  if (r.distance !== undefined) props['distance_m'] = r.distance;
  if (r.containing) {
    props['containing'] = true;
    props['area_m2'] = r.areaM2;
  }

  return {
    type: 'Feature',
    id: r.id,
    // A UI zooming to a result needs its extent, not just a point: fitting the
    // map to a point for a city-sized answer is wrong. Matches the conventional
    // response, which carries center and bbox alongside a Point geometry.
    ...(r.bbox ? { bbox: r.bbox } : {}),
    place_type: [r.layer],
    text: r.houseNumber ? `${r.name} ${r.houseNumber}` : r.name,
    place_name: placeName(r),
    center: coords,
    geometry: { type: 'Point', coordinates: coords },
    properties: props,
    relevance: Math.round(r.score * 1e4) / 1e4,
  };
}

export function toFeatureCollection(
  results: GeocodeResult[], query: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'FeatureCollection',
    query,
    features: results.map(toFeature),
    attribution: '© OpenStreetMap contributors (ODbL)',
  };
}

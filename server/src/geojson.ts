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
  if (r.houseNumber !== undefined) props['house_number'] = r.houseNumber;
  if (r.distance !== undefined) props['distance_m'] = r.distance;

  return {
    type: 'Feature',
    id: r.id,
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

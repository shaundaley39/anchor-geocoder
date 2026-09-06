/** Shaped after the conventional geocoding API, so the endpoint is a drop-in for
 * anything already speaking that dialect. */
import type { GeocodeResult } from './result.js';
import type {
  Feature, FeatureCollection, FeatureProperties,
} from '@anchor-geocoder/core';

/** One-line human-facing form, skipping absent components. */
export function placeName(r: GeocodeResult): string {
  const head = r.houseNumber ? `${r.name} ${r.houseNumber}` : r.name;
  const parts = [head];
  // Suppressed when it repeats the name, or a village address renders as
  // "Velká Úpa 42, Velká Úpa".
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
  const props: FeatureProperties = {
    layer: r.layer,
    name: r.name,
    country: r.country,
    ...(r.locality ? { locality: r.locality } : {}),
    ...(r.category !== undefined ? { category: r.category } : {}),
    ...(r.houseNumber !== undefined ? { house_number: r.houseNumber } : {}),
    ...(r.distance !== undefined ? { distance_m: r.distance } : {}),
    ...(r.containing ? { containing: true, area_m2: r.areaM2 ?? 0 } : {}),
  };

  return {
    type: 'Feature',
    id: r.id,
    // A UI needs the extent to zoom to, not just a point.
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
  results: GeocodeResult[], query: FeatureCollection['query'],
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    query,
    features: results.map(toFeature),
    attribution: '© OpenStreetMap contributors (ODbL)',
  };
}

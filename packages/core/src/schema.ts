/**
 * The API contract, as TypeBox schemas.
 *
 * One definition per shape, from which three things derive: the runtime
 * validation Fastify applies to every request, the TypeScript types the server
 * and client both import, and the OpenAPI document. They cannot drift, because
 * there is nothing to keep in step.
 */
import { Type, type Static } from '@sinclair/typebox';

export const LAYERS = ['address', 'street', 'place', 'poi'] as const;

export const Layer = Type.Union(
  LAYERS.map((l) => Type.Literal(l)),
  { $id: 'Layer', description: 'What kind of feature a result describes.' },
);
export type Layer = Static<typeof Layer>;

/** [minLon, minLat, maxLon, maxLat], GeoJSON order. */
export const BBox = Type.Tuple(
  [Type.Number(), Type.Number(), Type.Number(), Type.Number()],
  { $id: 'BBox', description: 'Extent as [minLon, minLat, maxLon, maxLat].' },
);
export type BBox = Static<typeof BBox>;

export const FeatureProperties = Type.Object({
  layer: Layer,
  name: Type.String({ description: 'The feature\'s own name.' }),
  country: Type.String({ description: 'ISO 3166-1 alpha-2, lowercase.' }),
  locality: Type.Optional(Type.String({ description: 'Settlement the feature is in.' })),
  house_number: Type.Optional(Type.String({ description: 'As written: "12A", "248/39".' })),
  category: Type.Optional(Type.String({
    description: 'OSM classification for POIs, e.g. "amenity=restaurant".',
  })),
  distance_m: Type.Optional(Type.Number({
    description: 'Metres from the query point. Reverse results only.',
  })),
  containing: Type.Optional(Type.Boolean({
    description: 'The query point falls inside this feature\'s outline.',
  })),
  area_m2: Type.Optional(Type.Number({
    description: 'Area of a containing region, which is what orders them.',
  })),
}, { $id: 'FeatureProperties', additionalProperties: false });
export type FeatureProperties = Static<typeof FeatureProperties>;

export const Point = Type.Object({
  type: Type.Literal('Point'),
  coordinates: Type.Tuple([Type.Number(), Type.Number()]),
}, { $id: 'Point', additionalProperties: false });

export const Feature = Type.Object({
  type: Type.Literal('Feature'),
  id: Type.String(),
  bbox: Type.Optional(Type.Ref(BBox)),
  place_type: Type.Array(Layer),
  text: Type.String({ description: 'Short label: the name, plus a house number.' }),
  place_name: Type.String({ description: 'Full one-line rendering.' }),
  center: Type.Tuple([Type.Number(), Type.Number()], {
    description: '[lon, lat] — GeoJSON order, the reverse of the lat/lon parameters.',
  }),
  geometry: Type.Ref(Point),
  properties: Type.Ref(FeatureProperties),
  relevance: Type.Number({ description: 'Ranking score. Comparable within one response only.' }),
}, { $id: 'Feature', additionalProperties: false });
export type Feature = Static<typeof Feature>;

export const QueryEcho = Type.Object({
  type: Type.Union([Type.Literal('forward'), Type.Literal('reverse')]),
  q: Type.Optional(Type.String()),
  lat: Type.Optional(Type.Number()),
  lon: Type.Optional(Type.Number()),
  radius: Type.Optional(Type.Number()),
  proximity: Type.Optional(Type.Object({ lat: Type.Number(), lon: Type.Number() })),
  corrected: Type.Optional(Type.String({
    description:
      'Set when the query matched nothing as typed and was retried against the '
      + 'nearest real spelling. The features are for this text, not for q — show '
      + 'it as "showing results for ...".',
  })),
  hint: Type.Optional(Type.String({
    description: 'Advice when a query returned nothing for a diagnosable reason.',
  })),
}, { $id: 'QueryEcho', additionalProperties: true });

export const FeatureCollection = Type.Object({
  type: Type.Literal('FeatureCollection'),
  query: Type.Ref(QueryEcho),
  features: Type.Array(Type.Ref(Feature)),
  attribution: Type.String(),
}, { $id: 'FeatureCollection', additionalProperties: false });
export type FeatureCollection = Static<typeof FeatureCollection>;

export const ErrorResponse = Type.Object({
  error: Type.String(),
  message: Type.String(),
  hint: Type.Optional(Type.String()),
  statusCode: Type.Optional(Type.Number()),
  retry_after_seconds: Type.Optional(Type.Number()),
}, { $id: 'ErrorResponse', additionalProperties: true });
export type ErrorResponse = Static<typeof ErrorResponse>;

/**
 * Query parameters.
 *
 * `q` and `lat`/`lon` are mutually exclusive, which JSON Schema can express but
 * not readably, so the handler checks it and the description says so. Numbers
 * are declared as numbers: Fastify coerces the strings a querystring carries,
 * so range checks happen in validation rather than by hand.
 */
export const GeocodeQuery = Type.Object({
  q: Type.Optional(Type.String({
    minLength: 1, maxLength: 200,
    description: 'Free-text query. The final token is matched as a prefix, for autocomplete.',
  })),
  lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  lon: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  country: Type.Optional(Type.String({
    minLength: 2, maxLength: 2,
    description: 'Restrict to one country, by ISO 3166-1 alpha-2 code.',
  })),
  radius: Type.Optional(Type.Number({
    minimum: 1, maximum: 50_000,
    description: 'Reverse search radius in metres.',
  })),
  proximity: Type.Optional(Type.String({
    pattern: '^-?\\d+(\\.\\d+)?,-?\\d+(\\.\\d+)?$',
    description: 'Bias forward results toward "lat,lon".',
  })),
}, { $id: 'GeocodeQuery', additionalProperties: false });
export type GeocodeQuery = Static<typeof GeocodeQuery>;

export const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  version: Type.Number(),
  built_at: Type.String(),
  countries: Type.Array(Type.String()),
  anchors: Type.Integer(),
  addresses: Type.Integer(),
  bbox: Type.Object({
    minLat: Type.Number(), maxLat: Type.Number(),
    minLon: Type.Number(), maxLon: Type.Number(),
  }),
}, { $id: 'HealthResponse', additionalProperties: false });
export type HealthResponse = Static<typeof HealthResponse>;

/** Registered on the server so `$ref`s resolve, and walked to build the spec. */
export const SHARED_SCHEMAS = [
  Layer, BBox, FeatureProperties, Point, Feature,
  QueryEcho, FeatureCollection, ErrorResponse, GeocodeQuery, HealthResponse,
];

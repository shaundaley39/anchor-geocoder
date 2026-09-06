/**
 * The routes themselves, registered onto an app the caller has already
 * configured. Kept apart from `server.ts` so that what the API *does* is not
 * interleaved with how the process is wired up — and so a route can be
 * exercised against a bare Fastify instance, without the plugin stack.
 */
import type {
  FastifyInstance, RawServerDefault, FastifyBaseLogger,
} from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  GeocodeQuery, FeatureCollection, ErrorResponse, HealthResponse,
  type GeocodeQuery as GeocodeQueryType,
  type FeatureCollection as FeatureCollectionType,
} from '@anchor-geocoder/core';
import { type Artifact } from './artifact.js';
import { forward } from './forward.js';
import { reverse, looksTransposed, type ReverseIndex } from './reverse.js';
import { toFeatureCollection } from './geojson.js';

function badRequest(message: string, hint?: string) {
  return { statusCode: 400, error: 'bad_request', message, ...(hint ? { hint } : {}) };
}

/**
 * An app whose schemas are TypeBox, which is what makes `req.query` typed from
 * the same object that validates it and generates the OpenAPI document.
 */
export type TypedApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export function registerRoutes(
  app: TypedApp, artifact: Artifact, reverseIndex: ReverseIndex,
): void {
  app.get('/health', {
    schema: {
      tags: ['operations'],
      summary: 'Liveness, and what the loaded index contains.',
      response: { 200: HealthResponse },
    },
  }, async () => ({
    status: 'ok' as const,
    version: artifact.manifest.version,
    built_at: artifact.manifest.built_at,
    countries: artifact.manifest.countries,
    anchors: artifact.manifest.num_anchors,
    addresses: artifact.manifest.num_addresses,
    bbox: reverseIndex.bbox,
  }));

  app.get('/openapi.json', {
    schema: { tags: ['operations'], summary: 'The OpenAPI 3.1 document.' },
  }, async () => app.swagger());

  app.get('/v1/geocode', {
    schema: {
      tags: ['geocoding'],
      summary: 'Forward or reverse geocode, depending on the parameters given.',
      description:
        'Supply `q` for forward geocoding, or `lat` and `lon` for reverse. They are ' +
        'mutually exclusive; to bias a text search toward a point, use `proximity`.\n\n' +
        'Note that GeoJSON `center` and `geometry.coordinates` are `[lon, lat]`, the ' +
        'reverse of the `lat`/`lon` parameters.',
      querystring: GeocodeQuery,
      response: {
        200: FeatureCollection,
        400: ErrorResponse,
        429: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    const { q, country } = req.query as GeocodeQueryType;
    const lat = req.query.lat ?? null;
    const lon = req.query.lon ?? null;
    const limit = req.query.limit;
    const started = process.hrtime.bigint();

    const hasText = typeof q === 'string' && q.trim() !== '';
    const hasPoint = lat !== null && lon !== null;

    if (!hasText && !hasPoint) {
      return reply.code(400).send(badRequest(
        'provide either q= for forward geocoding or lat= and lon= for reverse',
        '/v1/geocode?q=Marszalkowska+12  or  /v1/geocode?lat=52.2297&lon=21.0122',
      ));
    }
    if (hasText && hasPoint) {
      return reply.code(400).send(badRequest(
        'q= and lat=/lon= are mutually exclusive; use proximity= to bias a text search',
        '/v1/geocode?q=Nadrazni&proximity=50.0755,14.4378',
      ));
    }
    if (country !== undefined && artifact.manifest.country_ids[country.toLowerCase()] === undefined) {
      return reply.code(400).send(badRequest(
        `unknown country "${country}"`,
        `this index covers: ${artifact.manifest.countries.join(', ')}`,
      ));
    }

    let results;
    let echo: FeatureCollectionType['query'];

    if (hasPoint) {
      const radius = req.query.radius;
      results = reverse(artifact, reverseIndex, lat, lon, {
        ...(limit !== undefined ? { limit } : {}),
        ...(radius !== undefined ? { radius } : {}),
        ...(country !== undefined ? { country } : {}),
      });
      echo = { type: 'reverse', lat, lon, ...(radius !== undefined ? { radius } : {}) };

      // Outside coverage is not an error, so this stays a 200 — but if the
      // transposed point is inside, say so rather than leaving them guessing.
      if (results.length === 0 && looksTransposed(reverseIndex.bbox, lat, lon)) {
        echo.hint =
          `no results at lat=${lat}, lon=${lon}, but lat=${lon}, lon=${lat} is ` +
          `inside the indexed area — lat and lon may be transposed. Note that ` +
          `GeoJSON "center" and "coordinates" are [lon, lat], the reverse of ` +
          `these parameters.`;
      }
    } else {
      // Shape is enforced by the schema's pattern, so this cannot be NaN.
      let proximity: { lat: number; lon: number } | undefined;
      if (req.query.proximity) {
        const [pLat, pLon] = req.query.proximity.split(',').map(Number) as [number, number];
        proximity = { lat: pLat, lon: pLon };
      }
      const out = forward(artifact, q!, {
        ...(limit !== undefined ? { limit } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(proximity !== undefined ? { proximity } : {}),
      });
      results = out.results;
      echo = { type: 'forward', ...(q !== undefined ? { q } : {}), ...(proximity ? { proximity } : {}) };
      // The answer is for a different string than the one asked for, so say so
      // rather than letting the caller assume their spelling was found.
      if (out.corrected !== null) echo.corrected = out.corrected;
    }

    const micros = Number(process.hrtime.bigint() - started) / 1000;
    reply.header('x-query-time-ms', (micros / 1000).toFixed(3));
    (req as { geocodeResults?: number }).geocodeResults = results.length;
    return toFeatureCollection(results, echo);
  });

}

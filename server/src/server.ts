/**
 * The HTTP surface: one endpoint serving both geocoding directions.
 *
 * Forward and reverse return the same feature shape, so
 * /v1/geocode dispatches on which parameters are present rather than exposing
 * /search and /reverse. `q` means forward, `lat`+`lon` means reverse.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { type Artifact } from './artifact.js';
import { forward } from './forward.js';
import { reverse, looksTransposed, type ReverseIndex } from './reverse.js';
import { toFeatureCollection } from './geojson.js';

export interface ServerDeps {
  artifact: Artifact;
  reverseIndex: ReverseIndex;
}

interface GeocodeQuery {
  q?: string;
  lat?: string;
  lon?: string;
  limit?: string;
  country?: string;
  radius?: string;
  proximity?: string;
}

function badRequest(message: string, hint?: string) {
  return { error: 'bad_request', message, ...(hint ? { hint } : {}) };
}

/** Parses a numeric parameter, returning null when absent or malformed. */
function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { artifact, reverseIndex } = deps;

  app.get('/health', async () => ({
    status: 'ok',
    version: artifact.manifest.version,
    built_at: artifact.manifest.built_at,
    countries: artifact.manifest.countries,
    anchors: artifact.manifest.num_anchors,
    addresses: artifact.manifest.num_addresses,
    bbox: reverseIndex.bbox,
  }));

  app.get<{ Querystring: GeocodeQuery }>('/v1/geocode', async (req, reply) => {
    const { q, country } = req.query;
    const lat = num(req.query.lat);
    const lon = num(req.query.lon);
    const limit = num(req.query.limit) ?? undefined;
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
    if (hasPoint) {
      if (lat < -90 || lat > 90) {
        return reply.code(400).send(badRequest(`lat ${lat} is out of range [-90, 90]`));
      }
      if (lon < -180 || lon > 180) {
        return reply.code(400).send(badRequest(`lon ${lon} is out of range [-180, 180]`));
      }
    }
    if (country !== undefined && artifact.manifest.country_ids[country.toLowerCase()] === undefined) {
      return reply.code(400).send(badRequest(
        `unknown country "${country}"`,
        `this index covers: ${artifact.manifest.countries.join(', ')}`,
      ));
    }

    let results;
    let echo: Record<string, unknown>;

    if (hasPoint) {
      const radius = num(req.query.radius) ?? undefined;
      results = reverse(artifact, reverseIndex, lat, lon, {
        ...(limit !== undefined ? { limit } : {}),
        ...(radius !== undefined ? { radius } : {}),
        ...(country !== undefined ? { country } : {}),
      });
      echo = { type: 'reverse', lat, lon, ...(radius !== undefined ? { radius } : {}) };

      // Empty is a legitimate answer for a point outside coverage, so this
      // stays a 200 — but if the transposed point *is* inside coverage, say so
      // rather than leaving the caller to guess.
      if (results.length === 0 && looksTransposed(reverseIndex.bbox, lat, lon)) {
        echo['hint'] =
          `no results at lat=${lat}, lon=${lon}, but lat=${lon}, lon=${lat} is ` +
          `inside the indexed area — lat and lon may be transposed. Note that ` +
          `GeoJSON "center" and "coordinates" are [lon, lat], the reverse of ` +
          `these parameters.`;
      }
    } else {
      let proximity: { lat: number; lon: number } | undefined;
      if (req.query.proximity) {
        const [pLat, pLon] = req.query.proximity.split(',').map(Number);
        if (pLat === undefined || pLon === undefined ||
            !Number.isFinite(pLat) || !Number.isFinite(pLon)) {
          return reply.code(400).send(badRequest(
            'proximity must be "lat,lon"', 'proximity=50.0755,14.4378',
          ));
        }
        proximity = { lat: pLat, lon: pLon };
      }
      results = forward(artifact, q!, {
        ...(limit !== undefined ? { limit } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(proximity !== undefined ? { proximity } : {}),
      });
      echo = { type: 'forward', q, ...(proximity ? { proximity } : {}) };
    }

    const micros = Number(process.hrtime.bigint() - started) / 1000;
    reply.header('x-query-time-ms', (micros / 1000).toFixed(3));
    return toFeatureCollection(results, echo);
  });

  return app;
}

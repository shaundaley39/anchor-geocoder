/**
 * One endpoint serving both directions. `/v1/geocode` dispatches
 * on which parameters are present: `q` forward, `lat`+`lon` reverse.
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { type Artifact } from './artifact.js';
import { forward } from './forward.js';
import { reverse, looksTransposed, type ReverseIndex } from './reverse.js';
import { toFeatureCollection } from './geojson.js';

export interface ServerDeps {
  artifact: Artifact;
  reverseIndex: ReverseIndex;
  /** Overrides for the production middleware; tests disable rate limiting. */
  options?: ServerOptions;
}

export interface ServerOptions {
  /** Origins allowed to call the API. `true` allows any; the default. */
  corsOrigin?: FastifyServerOptions extends never ? never : boolean | string[];
  /** Requests per window per client. 0 disables rate limiting entirely. */
  rateLimitMax?: number;
  rateLimitWindow?: string;
  logger?: boolean | Record<string, unknown>;
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

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { artifact, reverseIndex, options = {} } = deps;

  const app = Fastify({
    // Structured JSON with a request id. Health checks are excluded below:
    // they fire every 30s and would otherwise dominate the log.
    logger: options.logger ?? {
      level: process.env['LOG_LEVEL'] ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req(r) {
          return { method: r.method, url: r.url, remoteAddress: r.ip };
        },
      },
    },
    // Replaced by the onResponse hook below, which carries the result count
    // and the handler's own timing. (Fastify 6 moves this to logController.)
    disableRequestLogging: true,
    trustProxy: true, // honour X-Forwarded-For behind a load balancer
  });

  // A geocoding endpoint is called from browsers by definition, so it is
  // useless without this. Open by default because the data is public and there
  // is no auth; CORS_ORIGIN narrows it.
  const originEnv = process.env['CORS_ORIGIN'];
  await app.register(cors, {
    origin: options.corsOrigin ??
      (originEnv && originEnv !== '*' ? originEnv.split(',') : true),
    methods: ['GET', 'OPTIONS'],
    maxAge: 86_400,
  });

  // The exposure is one client saturating the single Node thread, not the
  // per-request cost. Sized for autocomplete: one request per keystroke
  // debounced at ~150ms is 6-7 req/s in bursts, and behind NAT many users share
  // an address — throttling someone mid-word is the one thing this must not do.
  // A blunt per-IP cap suits an unauthenticated endpoint; finer wants API keys
  // and a shared store (the plugin takes Redis).
  const maxReq = options.rateLimitMax ?? Number(process.env['RATE_LIMIT_MAX'] ?? 600);
  if (maxReq > 0) {
    await app.register(rateLimit, {
      max: maxReq,
      timeWindow: options.rateLimitWindow ?? process.env['RATE_LIMIT_WINDOW'] ?? '1 minute',
      // Never throttle health checks, or the runtime kills the service under
      // exactly the load it should survive.
      allowList: (req) => req.url.startsWith('/health'),
      // statusCode must be in the payload: the plugin raises this as an error,
      // and without it Fastify reports 500 rather than 429.
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: 'rate_limited',
        message: `too many requests; limit is ${ctx.max} per ${ctx.after}`,
        retry_after_seconds: Math.ceil(ctx.ttl / 1000),
      }),
    });
  }

  // One structured line per request, with the timing the handler measured.
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/health')) return;
    req.log.info({
      method: req.method,
      path: req.routeOptions.url ?? req.url,
      status: reply.statusCode,
      duration_ms: Number(reply.elapsedTime.toFixed(3)),
      query_type: (req.query as GeocodeQuery).q !== undefined ? 'forward' : 'reverse',
      results: (req as { geocodeResults?: number }).geocodeResults,
    }, 'request');
  });

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

      // Outside coverage is not an error, so this stays a 200 — but if the
      // transposed point is inside, say so rather than leaving them guessing.
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
    (req as { geocodeResults?: number }).geocodeResults = results.length;
    return toFeatureCollection(results, echo);
  });

  return app;
}

/** Process wiring: the Fastify instance, its plugins and request logging. The
 * routes are in `routes.ts`. */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  SHARED_SCHEMAS,
  type GeocodeQuery as GeocodeQueryType,
} from '@anchor-geocoder/core';
import { type Artifact } from './artifact.js';
import { type ReverseIndex } from './reverse.js';
import { registerRoutes } from './routes.js';

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

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { artifact, reverseIndex, options = {} } = deps;

  const app = Fastify({
    // Health checks are excluded below: they fire every 30s and would otherwise
    // dominate the log.
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
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Registered once and referenced by $id, so the OpenAPI document and the
  // validators are the same objects.
  for (const schema of SHARED_SCHEMAS) app.addSchema(schema);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Geocoding API',
        version: String(artifact.manifest.version),
        description:
          'Forward and reverse geocoding over OpenStreetMap data, on one endpoint. ' +
          '`q` searches by text; `lat` and `lon` search by position.',
      },
      servers: [{ url: '/' }],
      tags: [{ name: 'geocoding' }, { name: 'operations' }],
    },
    // Without this the components come out as def-0, def-1, which is useless to
    // anyone generating a client from the document.
    refResolver: {
      buildLocalReference: (json, _base, _fragment, i) =>
        (json.$id as string | undefined) ?? `def-${String(i)}`,
    },
  });
  await app.register(scalar, { routePrefix: '/docs' });

  // A geocoding endpoint is called from browsers by definition. Open by default
  // because the data is public and there is no auth; CORS_ORIGIN narrows it.
  const originEnv = process.env['CORS_ORIGIN'];
  await app.register(cors, {
    origin: options.corsOrigin ??
      (originEnv && originEnv !== '*' ? originEnv.split(',') : true),
    methods: ['GET', 'OPTIONS'],
    maxAge: 86_400,
  });

  // The exposure is one client saturating the single Node thread, not the
  // per-request cost. Sized for autocomplete: a keystroke debounced at 150ms is
  // 6-7 req/s in bursts, and behind NAT many users share an address. Throttling
  // someone mid-word is the one thing this must not do.
  const maxReq = options.rateLimitMax ?? Number(process.env['RATE_LIMIT_MAX'] ?? 600);
  if (maxReq > 0) {
    await app.register(rateLimit, {
      max: maxReq,
      timeWindow: options.rateLimitWindow ?? process.env['RATE_LIMIT_WINDOW'] ?? '1 minute',
      // Or the runtime kills the service under exactly the load it should survive.
      allowList: (req) => req.url.startsWith('/health'),
      // statusCode must be in the payload: the plugin raises this as an error, and
      // without it Fastify reports 500 rather than 429.
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: 'rate_limited',
        message: `too many requests; limit is ${ctx.max} per ${ctx.after}`,
        retry_after_seconds: Math.ceil(ctx.ttl / 1000),
      }),
    });
  }

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/health')) return;
    req.log.info({
      method: req.method,
      path: req.routeOptions.url ?? req.url,
      status: reply.statusCode,
      duration_ms: Number(reply.elapsedTime.toFixed(3)),
      query_type: (req.query as GeocodeQueryType).q !== undefined ? 'forward' : 'reverse',
      results: (req as { geocodeResults?: number }).geocodeResults,
    }, 'request');
  });

  registerRoutes(app, artifact, reverseIndex);

  return app;
}

/** Process wiring: the Fastify instance, its plugins and request logging. The
 * routes are in `routes.ts`. */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
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
  /**
   * Supplies the HTTP server rather than letting Fastify create one. The worker
   * threads need the server object itself, because they listen on a descriptor
   * the pool hands them rather than on a port of their own.
   */
  serverFactory?: FastifyServerOptions['serverFactory'];
}

/**
 * A request whose target carries raw UTF-8, re-dispatched with it encoded.
 *
 * Node's HTTP parser rejects a request line containing bytes above 0x7F with
 * HPE_INVALID_URL, before any of this service runs, and Fastify turns that into
 * a bare 400 "Client Error". Strictly the parser is right: RFC 3986 says a URI
 * is ASCII and the rest is percent-encoded, which is what every HTTP client
 * library does for you. But a geocoder is asked for "Milady Horákové" and
 * "東京都千代田区" all day, `curl` sends what it is given, and nginx, Apache and
 * Go's net/http all pass those bytes through - Node is the strict one.
 *
 * So the packet is repaired rather than the parser relaxed: only for this one
 * error, only for a complete GET request line, only for the bytes that caused
 * it, and only to be handed straight back to the same routing and validation
 * any other request gets. Relaxing the parser instead means accepting the
 * header framing it also guards, which is request smuggling behind a proxy, and
 * this service sets `trustProxy`.
 *
 * The repaired request does not keep the connection alive. It arrived on a
 * socket whose parser has already given up on it.
 */
function repairTarget(raw: Buffer): { url: string; headers: Record<string, string> } | null {
  const text = raw.toString('latin1');
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return null; // the head never finished; nothing to repair
  const [line, ...rest] = text.slice(0, end).split('\r\n');

  // GET only, and only a whole request line: anything else is a different
  // problem and gets the default treatment.
  const m = /^GET (\S+) HTTP\/1\.[01]$/.exec(line ?? '');
  if (m === null) return null;
  const target = m[1]!;
  if (!/[\u0080-\u00ff]/.test(target)) return null; // some other invalid char

  let url = '';
  for (const ch of target) {
    const c = ch.charCodeAt(0);
    url += c >= 0x80 ? `%${c.toString(16).toUpperCase().padStart(2, '0')}` : ch;
  }

  const headers: Record<string, string> = {};
  for (const h of rest) {
    const i = h.indexOf(':');
    // Read back as UTF-8: the whole packet was taken as latin1 so the bytes
    // would survive, and a header value is the one place they might not be
    // ASCII either.
    if (i > 0) {
      headers[h.slice(0, i).trim().toLowerCase()] =
        Buffer.from(h.slice(i + 1).trim(), 'latin1').toString('utf8');
    }
  }
  return { url, headers };
}

/** What Fastify would have sent, with something in it worth reading. */
function badRequestPacket(hint: string): string {
  const body = JSON.stringify({
    statusCode: 400, error: 'bad_request', message: 'malformed HTTP request', hint,
  });
  return 'HTTP/1.1 400 Bad Request\r\n' +
    'content-type: application/json; charset=utf-8\r\n' +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    'connection: close\r\n\r\n' + body;
}

function onClientError(app: FastifyInstance | null, err: Error, socket: Socket): void {
  if (socket.destroyed) return;
  const raw = (err as { rawPacket?: Buffer }).rawPacket;
  const fixed = app !== null && (err as { code?: string }).code === 'HPE_INVALID_URL'
    && raw !== undefined ? repairTarget(raw) : null;

  if (fixed === null) {
    socket.end(badRequestPacket(
      'the request line could not be parsed; percent-encode anything outside ASCII',
    ));
    return;
  }

  app!.inject({
    method: 'GET', url: fixed.url, headers: fixed.headers,
    // Carried through so rate limiting and logging see the real client rather
    // than the loopback this is dispatched over.
    ...(socket.remoteAddress !== undefined ? { remoteAddress: socket.remoteAddress } : {}),
  }).then((res) => {
    if (socket.destroyed) return;
    const head = [`HTTP/1.1 ${res.statusCode} ${STATUS_CODES[res.statusCode] ?? 'OK'}`];
    for (const [k, v] of Object.entries(res.headers)) {
      // Framing is ours to state, since this reply is not going through the
      // server's own writer.
      if (k === 'connection' || k === 'content-length' || k === 'transfer-encoding') continue;
      if (v !== undefined) head.push(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
    }
    head.push(`content-length: ${res.rawPayload.length}`, 'connection: close', '', '');
    socket.end(Buffer.concat([Buffer.from(head.join('\r\n'), 'latin1'), res.rawPayload]));
  }).catch(() => {
    if (!socket.destroyed) socket.end(badRequestPacket('the request could not be served'));
  });
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { artifact, reverseIndex, options = {} } = deps;

  // Assigned immediately below; the handler is built before the instance it
  // needs, so it reads the reference rather than closing over the value.
  let instance: FastifyInstance | null = null;

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
    clientErrorHandler: (err, socket) => { onClientError(instance, err, socket); },
    ...(options.serverFactory ? { serverFactory: options.serverFactory } : {}),
  }).withTypeProvider<TypeBoxTypeProvider>();

  instance = app;

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

  // Sized for autocomplete: a keystroke debounced at 150ms is 6-7 req/s in
  // bursts, and behind NAT many users share an address. Throttling someone
  // mid-word is the one thing this must not do.
  //
  // The counter is per thread, so with a pool the ceiling is per thread too and
  // the aggregate a client could reach is up to workers x max. Deliberate: the
  // limit exists so one client cannot saturate the service, and dividing it
  // instead would throttle a real user mid-word, since keep-alive pins them to
  // one thread and they would get a sixteenth of the budget.
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

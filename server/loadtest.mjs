/**
 * Closed-loop throughput harness for a running server.
 *
 * `bench.mts` measures one query in isolation, which is the latency floor and
 * says nothing about how many of them a box can serve at once. This drives the
 * HTTP API at a fixed concurrency until it stops getting faster, which is the
 * number that decides how many replicas a deployment needs.
 *
 * Plain JavaScript, unlike everything else here, for one reason: the client has
 * to be multi-threaded or it becomes the bottleneck before the server does, and
 * a worker thread gets a fresh module loader that cannot read a `.mts` entry.
 *
 *   node loadtest.mjs --url http://127.0.0.1:3000 --connections 64 --duration 10
 *   node loadtest.mjs --profile autocomplete --connections 128 --clients 6
 *
 * Concurrency is the whole shape of the result: too little and the server is
 * idle between requests, too much and the queue only adds latency. Sweep it.
 */
import http from 'node:http';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

// ---------------------------------------------------------------- queries ---

/**
 * Each profile is a different cost, and the spread between them is the point:
 * the same server answers 'address' and 'autocomplete' an order of magnitude
 * apart, so a single throughput figure without a stated mix is meaningless.
 */
const CITIES = ['Praha', 'Warszawa', 'Brno', 'Krakow', 'Gdansk', 'Lodz',
  'Wroclaw', 'Ostrava', 'Plzen', 'Poznan', 'Muenchen', 'Koeln', 'Wien'];
const PREFIXES = ['War', 'Pra', 'Kra', 'Gda', 'Wro', 'Lod', 'Bru', 'Ost',
  'Poz', 'Szc', 'Mue', 'Ber'];
const STREETS = ['Marszalkowska', 'Nadrazni', 'Hauptstrasse', 'Nowa Wies',
  'Karlova', 'Bahnhofstrasse'];
/**
 * Queries whose every token is one of the commonest words in its language, so
 * the posting lists barely intersect and the reranker runs to its cap. Kept out
 * of `mixed` and measured on their own: two of these in a six-query rotation
 * moved the blended figure by 20x, which says more about the rotation than
 * about the server.
 */
const HEAVY = ['Rue de la Paix', 'Via Roma 5', 'Rue du General de Gaulle',
  'Piazza del Popolo'];
const POINTS = [[52.2297, 21.0122], [50.0755, 14.4378], [48.2082, 16.3738],
  [52.52, 13.405], [45.4642, 9.19], [59.3293, 18.0686]];
/** Open water, ice and empty mountain: inside the coverage box, far from data. */
const AWKWARD = [[55.90, 19.20], [53.20, 3.30], [43.30, 14.60], [46.55, 8.05],
  [74.0, 20.0], [52.724, 4.331], [35.0, 18.0], [61.0, 31.5]];

const PROFILES = {
  /** Three characters into a search box: the widest posting scan there is. */
  autocomplete: (i) => `/v1/geocode?q=${encodeURIComponent(PREFIXES[i % PREFIXES.length])}&limit=10`,
  /** A complete, popular, highly ambiguous name. */
  city: (i) => `/v1/geocode?q=${encodeURIComponent(CITIES[i % CITIES.length])}&limit=10`,
  /** Street plus number: selective, and the cheapest thing the API does. */
  address: (i) => {
    const s = STREETS[i % STREETS.length];
    return `/v1/geocode?q=${encodeURIComponent(`${s} ${(i % 90) + 1}`)}&limit=10`;
  },
  /** A click on the map. */
  reverse: (i) => {
    const [lat, lon] = POINTS[i % POINTS.length];
    return `/v1/geocode?lat=${lat}&lon=${lon}&limit=10`;
  },
  /** The tail: multi-token names made entirely of very common words. */
  heavy: (i) => `/v1/geocode?q=${encodeURIComponent(HEAVY[i % HEAVY.length])}&limit=10`,
  /**
   * Reverse geocoding asked the awkward way: the widest radius, the largest
   * page, and points that are mostly nowhere near anything. What a bored client
   * would send, rather than what a map would.
   */
  'reverse-wide': (i) => {
    const [lat, lon] = AWKWARD[i % AWKWARD.length];
    return `/v1/geocode?lat=${lat}&lon=${lon}&limit=50&radius=50000`;
  },
  /** The same, filtered to a country nowhere near the point. */
  'reverse-filtered': (i) => {
    const [lat, lon] = POINTS[i % POINTS.length];
    return `/v1/geocode?lat=${lat}&lon=${lon}&limit=50&radius=50000&country=pt`;
  },
};

/** What a search box in front of a map actually sends, roughly. */
const MIXED_WEIGHTS = [
  ['autocomplete', 5], ['address', 3], ['city', 1], ['reverse', 1],
];
PROFILES.mixed = (() => {
  const bag = [];
  for (const [name, n] of MIXED_WEIGHTS) for (let i = 0; i < n; i++) bag.push(name);
  return (i) => PROFILES[bag[i % bag.length]](i);
})();

// ----------------------------------------------------------------- client ---

function runClient({ url, connections, durationMs, warmupMs, profile, seed }) {
  const target = new URL(url);
  const path = PROFILES[profile];
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: connections,
    maxFreeSockets: connections,
  });

  let n = seed;
  let done = 0;
  let failed = 0;
  let statusOther = 0;
  let bytes = 0;
  // Preallocated: growing an array of a million samples mid-measurement shows
  // up in the measurement.
  const lat = new Float64Array(4_000_000);
  let latN = 0;
  let measuring = false;
  let stop = false;

  return new Promise((resolve) => {
    const one = () => {
      if (stop) return;
      const started = performance.now();
      const req = http.get(
        { agent, host: target.hostname, port: target.port, path: path(n++) },
        (res) => {
          if (res.statusCode !== 200) statusOther++;
          res.on('data', (c) => { bytes += c.length; });
          res.on('end', () => {
            if (measuring) {
              done++;
              if (latN < lat.length) lat[latN++] = performance.now() - started;
            }
            one();
          });
        },
      );
      req.on('error', () => { failed++; setTimeout(one, 5); });
    };

    for (let i = 0; i < connections; i++) one();

    setTimeout(() => {
      measuring = true;
      setTimeout(() => {
        stop = true;
        agent.destroy();
        resolve({
          done, failed, statusOther, bytes,
          latencies: lat.subarray(0, latN).slice(),
        });
      }, durationMs);
    }, warmupMs);
  });
}

// ------------------------------------------------------------------- main ---

if (!isMainThread) {
  runClient(workerData).then((r) => parentPort.postMessage(r, [r.latencies.buffer]));
} else {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };

  const url = arg('url', 'http://127.0.0.1:3000');
  const connections = Number(arg('connections', 64));
  const durationMs = Number(arg('duration', 10)) * 1000;
  const warmupMs = Number(arg('warmup', 3)) * 1000;
  const clients = Number(arg('clients', Math.min(6, Math.max(2, availableParallelism() >> 2))));
  const profiles = arg('profile', 'mixed').split(',');
  // A profile that leaves the server with a backlog poisons the next one: after
  // the heavy queries a single-threaded server is still working when the run
  // ends, and the next profile's first requests are reset rather than served.
  const gapMs = Number(arg('gap', 5)) * 1000;
  const label = arg('label', '');

  const health = await fetch(new URL('/health', url)).then((r) => r.json());
  console.log(
    `target ${url}${label ? ` [${label}]` : ''}: ` +
    `${health.anchors.toLocaleString()} anchors, ${health.addresses.toLocaleString()} addresses`,
  );
  console.log(
    `${clients} client threads, ${connections} connections, ` +
    `${durationMs / 1000}s measured after ${warmupMs / 1000}s warmup\n`,
  );
  console.log('  profile        rps        p50      p95      p99     max   errors');

  const results = {};
  for (const profile of profiles) {
    if (profile !== profiles[0]) await new Promise((r) => setTimeout(r, gapMs));
    const per = Math.floor(connections / clients);
    const spread = Array.from({ length: clients }, (_, i) => per + (i < connections % clients ? 1 : 0));

    const t0 = performance.now();
    const parts = await Promise.all(spread.map((conns, i) => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), {
        workerData: { url, connections: conns, durationMs, warmupMs, profile, seed: i * 9973 },
      });
      w.once('message', (m) => { resolve(m); void w.terminate(); });
      w.once('error', reject);
    })));
    const elapsed = (performance.now() - t0 - warmupMs) / 1000;

    const done = parts.reduce((s, p) => s + p.done, 0);
    const failed = parts.reduce((s, p) => s + p.failed, 0);
    const other = parts.reduce((s, p) => s + p.statusOther, 0);
    const all = Float64Array.from(parts.flatMap((p) => Array.from(p.latencies)));
    all.sort();
    const pct = (p) => (all.length ? all[Math.min(all.length - 1, Math.floor(all.length * p))] : NaN);
    const rps = done / elapsed;
    results[profile] = { rps, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) };

    // Loud, because the harness will otherwise happily report six figures of
    // throughput that is entirely 429s: the default rate limit is 600/min, so a
    // load test wants RATE_LIMIT_MAX=0 on the server.
    if (failed + other > done * 0.01) {
      console.log(`  !! ${failed + other} of ${done + failed + other} requests did not return 200`);
    }
    console.log(
      `  ${profile.padEnd(13)}${Math.round(rps).toLocaleString().padStart(7)}` +
      `${pct(0.5).toFixed(2).padStart(10)}ms${pct(0.95).toFixed(2).padStart(7)}ms` +
      `${pct(0.99).toFixed(2).padStart(7)}ms${(all[all.length - 1] ?? NaN).toFixed(0).padStart(6)}ms` +
      `${String(failed + other).padStart(9)}`,
    );
  }

  if (process.env.LOADTEST_JSON) {
    console.log(`\nJSON ${JSON.stringify({ label, clients, connections, results })}`);
  }
}

import { loadArtifact, toDeg } from './src/artifact.js';
import { forward } from './src/forward.js';
import { buildReverseIndex, reverse } from './src/reverse.js';

const a = await loadArtifact('../build/index');
const rev = buildReverseIndex(a);

function pct(xs: number[], p: number) { return xs[Math.floor(xs.length * p)]!; }
function bench(label: string, n: number, fn: (i: number) => void) {
  for (let i = 0; i < 200; i++) fn(i);              // warm
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now(); fn(i); ts.push(performance.now() - t);
  }
  ts.sort((x, y) => x - y);
  console.log(`  ${label.padEnd(34)} p50 ${pct(ts,.5).toFixed(3)}ms  p95 ${pct(ts,.95).toFixed(3)}ms  p99 ${pct(ts,.99).toFixed(3)}ms`);
}

const cities = ['Praha','Warszawa','Brno','Krakow','Gdansk','Lodz','Wroclaw','Ostrava','Plzen','Poznan'];
const prefixes = ['War','Pra','Kra','Gda','Wro','Lod','Bru','Ost','Poz','Szc'];

console.log('forward:');
bench('exact city name', 2000, i => forward(a, cities[i % cities.length]!, { limit: 10 }));
bench('3-char autocomplete prefix', 2000, i => forward(a, prefixes[i % prefixes.length]!, { limit: 10 }));
bench('street + house number', 2000, i => forward(a, `Marszalkowska ${1 + i % 90}`, { limit: 10 }));
bench('two-token street', 2000, i => forward(a, `Nowa Wies ${1 + i % 50}`, { limit: 10 }));
bench('no match', 1000, () => forward(a, 'zzzqqqxxvv', { limit: 10 }));

console.log('reverse (points sampled from the index):');
const n = a.manifest.num_addresses;
const pts: [number, number][] = [];
for (let i = 0; i < 4000; i++) {
  const j = (i * 2_917_331) % n;
  pts.push([toDeg(a.addrLat[j]!), toDeg(a.addrLon[j]!)]);
}
bench('dense: k=5', 3000, i => reverse(a, rev, pts[i % pts.length]![0], pts[i % pts.length]![1], { limit: 5 }));
bench('dense: k=1', 3000, i => reverse(a, rev, pts[i % pts.length]![0], pts[i % pts.length]![1], { limit: 1 }));
bench('sparse (offset ~5km)', 1000, i => {
  const p = pts[i % pts.length]!; return reverse(a, rev, p[0] + 0.05, p[1] + 0.05, { limit: 5 });
});
bench('empty ocean, 50km cap', 200, () => reverse(a, rev, 30, -40, { limit: 5, radius: 50000 }));
console.log(`\nrss ${(process.memoryUsage().rss/1e6).toFixed(0)}MB`);

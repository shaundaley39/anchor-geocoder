/**
 * The k-d tree borrows its coordinates, which makes it cheap but also ours to
 * get right. Everything compares against brute force: a tree bug returns a
 * plausible subset, not an error.
 */
import { describe, it, expect } from 'vitest';
import { PointIndex } from '../src/pointindex.js';

function build(pts: [number, number][], nodeSize = 8) {
  const xs = Int32Array.from(pts.map((p) => p[0]));
  const ys = Int32Array.from(pts.map((p) => p[1]));
  return new PointIndex(pts.length, (i) => xs[i]!, (i) => ys[i]!, nodeSize);
}

function brute(pts: [number, number][], b: [number, number, number, number]): number[] {
  const [minX, minY, maxX, maxY] = b;
  const out: number[] = [];
  pts.forEach(([x, y], i) => {
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(i);
  });
  return out.sort((p, q) => p - q);
}

function collect(idx: PointIndex, b: [number, number, number, number]): number[] {
  const out: number[] = [];
  idx.range(b[0], b[1], b[2], b[3], (id) => out.push(id));
  return out.sort((p, q) => p - q);
}

describe('PointIndex', () => {
  it('matches brute force on random boxes over random points', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pts: [number, number][] = [];
    for (let i = 0; i < 5000; i++) {
      pts.push([Math.round(rnd() * 1e6), Math.round(rnd() * 1e6)]);
    }
    const idx = build(pts);
    for (let q = 0; q < 400; q++) {
      const x1 = Math.round(rnd() * 1e6);
      const y1 = Math.round(rnd() * 1e6);
      const w = Math.round(rnd() * 2e5);
      const h = Math.round(rnd() * 2e5);
      const box: [number, number, number, number] = [x1, y1, x1 + w, y1 + h];
      expect(collect(idx, box)).toEqual(brute(pts, box));
    }
  });

  it('handles heavy duplicate coordinates', () => {
    // Quickselect on a mostly-constant axis is where a partition bug shows up.
    const pts: [number, number][] = [];
    for (let i = 0; i < 2000; i++) pts.push([i % 3, 7]);
    const idx = build(pts);
    const box: [number, number, number, number] = [1, 7, 2, 7];
    expect(collect(idx, box)).toEqual(brute(pts, box));
  });

  it('handles collinear points', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 1000; i++) pts.push([i, 0]);
    const idx = build(pts);
    const box: [number, number, number, number] = [250, -1, 750, 1];
    expect(collect(idx, box)).toEqual(brute(pts, box));
  });

  it('returns everything for an all-covering box, and nothing for a disjoint one', () => {
    const pts: [number, number][] = Array.from({ length: 500 }, (_, i) => [i, i * 2]);
    const idx = build(pts);
    expect(collect(idx, [-1, -1, 1000, 2000]).length).toBe(500);
    expect(collect(idx, [10_000, 10_000, 20_000, 20_000])).toEqual([]);
  });

  it('handles empty and single-point indexes', () => {
    expect(collect(new PointIndex(0, () => 0, () => 0), [0, 0, 1, 1])).toEqual([]);
    const one = build([[5, 5]]);
    expect(collect(one, [0, 0, 10, 10])).toEqual([0]);
    expect(collect(one, [6, 6, 10, 10])).toEqual([]);
  });

  it('is inclusive on box edges', () => {
    const idx = build([[10, 10]]);
    expect(collect(idx, [10, 10, 10, 10])).toEqual([0]);
  });

  it('works across leaf-size boundaries', () => {
    for (const n of [1, 7, 8, 9, 63, 64, 65, 200]) {
      const pts: [number, number][] = Array.from({ length: n }, (_, i) => [i * 3, (n - i) * 5]);
      const idx = build(pts, 8);
      const box: [number, number, number, number] = [0, 0, n * 2, n * 3];
      expect(collect(idx, box), `n=${n}`).toEqual(brute(pts, box));
    }
  });
});

/**
 * Unit tests for the refine half of the reverse query.
 *
 * These build a synthetic artifact holding only the geometry arrays, so the
 * containment and distance maths can be checked against shapes with known
 * answers — a square, an L, a line — rather than against whatever OSM happens
 * to contain.
 */
import { describe, it, expect } from 'vitest';
import type { Artifact } from '../src/artifact.js';
import {
  containsPoint, distanceToShape, ringAreaM2, distanceToBBox, hasShape,
} from '../src/geometry.js';

/** Builds an artifact carrying just the geometry of the given shapes. */
function fake(shapes: { pts: [number, number][]; closed: boolean }[]): Artifact {
  const geom: number[] = [];
  const off: number[] = [0];
  const closed: number[] = [];
  const minLat: number[] = [], maxLat: number[] = [];
  const minLon: number[] = [], maxLon: number[] = [];
  for (const s of shapes) {
    for (const [lat, lon] of s.pts) {
      geom.push(Math.round(lat * 1e7), Math.round(lon * 1e7));
    }
    off.push(geom.length / 2);
    closed.push(s.closed ? 1 : 0);
    minLat.push(Math.round(Math.min(...s.pts.map((p) => p[0])) * 1e7));
    maxLat.push(Math.round(Math.max(...s.pts.map((p) => p[0])) * 1e7));
    minLon.push(Math.round(Math.min(...s.pts.map((p) => p[1])) * 1e7));
    maxLon.push(Math.round(Math.max(...s.pts.map((p) => p[1])) * 1e7));
  }
  return {
    geom: Int32Array.from(geom),
    geomOff: Uint32Array.from(off),
    geomClosed: Uint8Array.from(closed),
    anchorMinLat: Int32Array.from(minLat),
    anchorMaxLat: Int32Array.from(maxLat),
    anchorMinLon: Int32Array.from(minLon),
    anchorMaxLon: Int32Array.from(maxLon),
  } as unknown as Artifact;
}

// A 0.01deg square at 50N: roughly 1.11km x 0.72km.
const SQUARE: [number, number][] = [[50, 14], [50, 14.01], [50.01, 14.01], [50.01, 14]];

describe('containsPoint', () => {
  const a = fake([{ pts: SQUARE, closed: true }]);

  it('accepts an interior point', () => {
    expect(containsPoint(a, 0, 50.005, 14.005)).toBe(true);
  });

  it('rejects points outside on every side', () => {
    for (const [lat, lon] of [[49.99, 14.005], [50.02, 14.005],
                              [50.005, 13.99], [50.005, 14.02]] as const) {
      expect(containsPoint(a, 0, lat, lon)).toBe(false);
    }
  });

  /**
   * The case a bounding box cannot express: an L-shaped feature fills only part
   * of its box, so the notch must read as outside even though the box contains
   * it. This is the whole reason the refine step exists.
   */
  it('rejects the notch of an L-shaped ring that its bbox would accept', () => {
    const L: [number, number][] = [
      [50, 14], [50, 14.02], [50.01, 14.02], [50.01, 14.01],
      [50.02, 14.01], [50.02, 14],
    ];
    const b = fake([{ pts: L, closed: true }]);
    expect(containsPoint(b, 0, 50.005, 14.005)).toBe(true);   // in the foot
    expect(containsPoint(b, 0, 50.015, 14.005)).toBe(true);   // in the upright
    expect(containsPoint(b, 0, 50.015, 14.015)).toBe(false);  // the notch
    // ...and the bbox alone would wrongly accept that notch:
    expect(distanceToBBox(b, 0, 50.015, 14.015)).toBe(0);
  });

  it('never reports containment for an open shape', () => {
    const line = fake([{ pts: SQUARE, closed: false }]);
    expect(containsPoint(line, 0, 50.005, 14.005)).toBe(false);
  });
});

describe('distanceToShape', () => {
  it('measures to the boundary of a ring', () => {
    const a = fake([{ pts: SQUARE, closed: true }]);
    // 0.001 deg of latitude south of the bottom edge is ~111m.
    const d = distanceToShape(a, 0, 49.999, 14.005);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(125);
  });

  it('measures to the nearest segment of an open line, not to its endpoints', () => {
    // A 2km east-west line; the query sits 111m north of its midpoint.
    const line: [number, number][] = [[50, 14], [50, 14.028]];
    const a = fake([{ pts: line, closed: false }]);
    const d = distanceToShape(a, 0, 50.001, 14.014);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(125);
  });

  it('is zero-ish on the boundary itself', () => {
    const a = fake([{ pts: SQUARE, closed: true }]);
    expect(distanceToShape(a, 0, 50, 14.005)).toBeLessThan(1);
  });

  it('returns Infinity when there is no shape', () => {
    const a = fake([]);
    expect(distanceToShape(a, 0, 50, 14)).toBe(Infinity);
    expect(hasShape(a, 0)).toBe(false);
  });
});

describe('ringAreaM2', () => {
  it('matches the analytic area of a known square', () => {
    const a = fake([{ pts: SQUARE, closed: true }]);
    // 0.01deg lat = 1113m; 0.01deg lon at 50N = 1113 * cos(50) = 715m.
    const expected = 1113.2 * 1113.2 * Math.cos((50 * Math.PI) / 180);
    expect(ringAreaM2(a, 0)).toBeGreaterThan(expected * 0.97);
    expect(ringAreaM2(a, 0)).toBeLessThan(expected * 1.03);
  });

  it('orders nested rings smallest first', () => {
    const outer: [number, number][] = [[50, 14], [50, 14.1], [50.1, 14.1], [50.1, 14]];
    const inner: [number, number][] = [[50.04, 14.04], [50.04, 14.05],
                                        [50.05, 14.05], [50.05, 14.04]];
    const a = fake([{ pts: outer, closed: true }, { pts: inner, closed: true }]);
    expect(containsPoint(a, 0, 50.045, 14.045)).toBe(true);
    expect(containsPoint(a, 1, 50.045, 14.045)).toBe(true);
    expect(ringAreaM2(a, 1)).toBeLessThan(ringAreaM2(a, 0));
  });
});

/**
 * Query-time geometry: containment and distance against the simplified shapes
 * stored in the artifact.
 *
 * This is the refine half of a filter-and-refine spatial query. The bounding
 * box index narrows a click to a handful of candidates cheaply; these functions
 * then decide, exactly, whether the click is inside a feature and how far it is
 * from one it is outside. A box alone cannot do that — a diagonal or
 * crescent-shaped feature occupies a fraction of its box, so "inside the box"
 * is emphatically not "inside the park".
 */
import { type Artifact, toDeg } from './artifact.js';

const M_PER_DEG_LAT = 111_320;

/** Metres per degree of longitude at a given latitude. */
export function lonMetres(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Does an anchor have a stored outline? */
export function hasShape(a: Artifact, id: number): boolean {
  return a.geomOff[id + 1]! > a.geomOff[id]!;
}

/** Is the anchor's outline a closed ring (containment applies) or a point set? */
export function isClosed(a: Artifact, id: number): boolean {
  return a.geomClosed[id] === 1;
}

/**
 * Point-in-polygon by ray casting (crossing number).
 *
 * Works on the raw fixed-point integers: the test is a sequence of comparisons
 * and one cross-product per edge, all of which are sign-preserving under a
 * uniform scale, so converting to degrees first would cost precision and time
 * for nothing.
 *
 * Longitude convergence does not matter either — shrinking every x coordinate
 * by the same factor cannot move a point across an edge.
 */
export function containsPoint(a: Artifact, id: number, lat: number, lon: number): boolean {
  if (!isClosed(a, id)) return false;
  const start = a.geomOff[id]!;
  const end = a.geomOff[id + 1]!;
  const n = end - start;
  if (n < 3) return false;

  const y = Math.round(lat * 1e7);
  const x = Math.round(lon * 1e7);

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = a.geom[2 * (start + i)]!;
    const xi = a.geom[2 * (start + i) + 1]!;
    const yj = a.geom[2 * (start + j)]!;
    const xj = a.geom[2 * (start + j) + 1]!;
    if ((yi > y) !== (yj > y)) {
      // x of the edge at height y, compared without dividing.
      const t = (xj - xi) * (y - yi) - (x - xi) * (yj - yi);
      if (yj > yi ? t > 0 : t < 0) inside = !inside;
    }
  }
  return inside;
}

/** Squared distance in metres from a point to a segment, in a local planar frame. */
function segDistSq(
  py: number, px: number,
  ay: number, ax: number, by: number, bx: number,
): number {
  const dy = by - ay;
  const dx = bx - ax;
  let t = 0;
  const len = dy * dy + dx * dx;
  if (len > 0) t = Math.max(0, Math.min(1, ((py - ay) * dy + (px - ax) * dx) / len));
  const cy = ay + t * dy;
  const cx = ax + t * dx;
  return (py - cy) ** 2 + (px - cx) ** 2;
}

/**
 * Distance in metres from a click to an anchor's outline, or 0 if inside a ring.
 *
 * For a ring the distance is to the boundary; for a street's sampled points it
 * is to the nearest segment between consecutive samples. Both are measured in a
 * local planar frame centred on the query, which is accurate to well under a
 * metre at the scales a click cares about and avoids a haversine per edge.
 */
export function distanceToShape(
  a: Artifact, id: number, lat: number, lon: number,
): number {
  const start = a.geomOff[id]!;
  const end = a.geomOff[id + 1]!;
  const n = end - start;
  if (n === 0) return Infinity;

  const kx = lonMetres(lat) / 1e7;
  const ky = M_PER_DEG_LAT / 1e7;
  const py = Math.round(lat * 1e7) * ky;
  const px = Math.round(lon * 1e7) * kx;

  if (n === 1) {
    const y = a.geom[2 * start]! * ky;
    const x = a.geom[2 * start + 1]! * kx;
    return Math.hypot(py - y, px - x);
  }

  let best = Infinity;
  const closed = isClosed(a, id);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    const ay = a.geom[2 * (start + i)]! * ky;
    const ax = a.geom[2 * (start + i) + 1]! * kx;
    const by = a.geom[2 * (start + j)]! * ky;
    const bx = a.geom[2 * (start + j) + 1]! * kx;
    const d = segDistSq(py, px, ay, ax, by, bx);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * Area of an anchor's ring in square metres, via the shoelace formula.
 *
 * Used to order the regions a click falls inside, smallest first: standing in
 * an open-air theatre in the corner of a park, the theatre is the better answer
 * and the park the broader context. Computed on demand and memoized rather than
 * stored — only the handful of regions containing a given click ever need it.
 */
const areaCache = new Map<number, number>();

export function ringAreaM2(a: Artifact, id: number): number {
  const hit = areaCache.get(id);
  if (hit !== undefined) return hit;

  const start = a.geomOff[id]!;
  const n = a.geomOff[id + 1]! - start;
  let area = 0;
  if (n >= 3) {
    const lat0 = toDeg(a.geom[2 * start]!);
    const kx = lonMetres(lat0) / 1e7;
    const ky = M_PER_DEG_LAT / 1e7;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = a.geom[2 * (start + i)]! * ky;
      const xi = a.geom[2 * (start + i) + 1]! * kx;
      const yj = a.geom[2 * (start + j)]! * ky;
      const xj = a.geom[2 * (start + j) + 1]! * kx;
      area += xj * yi - xi * yj;
    }
    area = Math.abs(area) / 2;
  }
  if (areaCache.size < 100_000) areaCache.set(id, area);
  return area;
}

/** Distance in metres from a point to an anchor's bounding box; 0 if inside. */
export function distanceToBBox(
  a: Artifact, id: number, lat: number, lon: number,
): number {
  const minLat = toDeg(a.anchorMinLat[id]!);
  const maxLat = toDeg(a.anchorMaxLat[id]!);
  const minLon = toDeg(a.anchorMinLon[id]!);
  const maxLon = toDeg(a.anchorMaxLon[id]!);
  const dLat = lat < minLat ? minLat - lat : lat > maxLat ? lat - maxLat : 0;
  const dLon = lon < minLon ? minLon - lon : lon > maxLon ? lon - maxLon : 0;
  return Math.hypot(dLat * M_PER_DEG_LAT, dLon * lonMetres(lat));
}

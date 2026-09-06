/**
 * The refine half of a filter-and-refine spatial query: containment and
 * distance against the simplified shapes in the artifact.
 *
 * The bounding box narrows a click to a few candidates; these decide exactly.
 * A box alone cannot — a crescent occupies a fraction of its box, so "inside
 * the box" is not "inside the park".
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
 * Point-in-polygon by ray casting, on the raw fixed-point integers: every
 * comparison and cross-product is sign-preserving under a uniform scale, so
 * converting to degrees would cost precision for nothing. Longitude convergence
 * cannot move a point across an edge either.
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

/** Squared distance from a point to a segment, in a local planar frame. */
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
 * Distance in metres from a click to an anchor's outline.
 *
 * A ring is measured edge by edge. An open shape is measured to its nearest
 * *vertex*, and that distinction is load-bearing: a street's stored points are
 * way midpoints in extract order — a sample, not a traversal — so joining them
 * draws segments the road does not follow. Measuring along those changed the
 * answer for 26.6% of streets and under-reported by up to 300m.
 *
 * Vertex distance errs by about half the sample spacing, and over-estimates,
 * which is the safe direction. Computed in a local planar frame, accurate to
 * well under a metre here and cheaper than a haversine per edge.
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

  if (!isClosed(a, id)) {
    // Unordered sample points: nearest vertex, no segments. See above.
    for (let i = 0; i < n; i++) {
      const y = a.geom[2 * (start + i)]! * ky;
      const x = a.geom[2 * (start + i) + 1]! * kx;
      const d = (py - y) ** 2 + (px - x) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  // A ring is a real traversal, so edges are meaningful.
  for (let i = 0; i < n; i++) {
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
 * Ring area in m², by the shoelace formula. Orders the regions a click falls
 * inside, smallest first — the theatre in the corner of the park before the
 * park. Computed on demand: only the few containing regions need it.
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

import { EPS, interiorPoint, pointInPolygon, polygonArea, segmentsIntersect, type Pt } from './vec';

type Tri = [number, number, number];

const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function pointInTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/** Ear-clipping triangulation for a simple, counter-clockwise polygon. */
export function triangulate(poly: Pt[]): Tri[] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  const tris: Tri[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n + 10) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length];
      const i1 = idx[k];
      const i2 = idx[(k + 1) % idx.length];
      const a = poly[i0];
      const b = poly[i1];
      const c = poly[i2];
      if (cross(a, b, c) <= EPS) continue;
      let isEar = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTriangle(poly[j], a, b, c)) {
          isEar = false;
          break;
        }
      }
      if (!isEar) continue;
      tris.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/** True when the boundaries of two contours touch or cross anywhere. */
export function contoursCross(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * True only when the outlines really cut through each other. Touching along an
 * edge or at a corner is allowed: a zero offset means the contours share a
 * boundary, which is a valid notch or a flush added volume.
 */
export function contoursProperlyCross(a: Pt[], b: Pt[]): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return Math.abs(v) < EPS ? 0 : v > 0 ? 1 : -1;
  };
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      const o1 = side(a1, a2, b1);
      const o2 = side(a1, a2, b2);
      const o3 = side(b1, b2, a1);
      const o4 = side(b1, b2, a2);
      if (o1 * o2 < 0 && o3 * o4 < 0) return true;
    }
  }
  return false;
}

/**
 * How many of the other contours enclose this one. Even depth = solid area,
 * odd depth = void, so a contour inside a void becomes an island again.
 *
 * Offsets may be zero, so the contours can share a boundary. A vertex would then
 * be ambiguous; an interior probe stays unambiguous.
 */
export function nestingDepth(polys: Pt[][], index: number): number {
  if (!polys[index]?.length) return 0;
  const probe = interiorPoint(polys[index]);
  let depth = 0;
  for (let i = 0; i < polys.length; i++) {
    if (i !== index && pointInPolygon(probe, polys[i])) depth++;
  }
  return depth;
}

export type SlabMetrics = {
  areaMm2: number;
  perimeterMm: number;
  volumeMm3: number;
  avgThickness: number;
  valid: boolean;
};

/**
 * Volume of a slab with a per-vertex thickness field, integrated over the
 * triangulation with linear interpolation inside every triangle.
 */
export function slabMetrics(poly: Pt[], thickness: number[]): SlabMetrics {
  const areaMm2 = polygonArea(poly);
  let perimeterMm = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    perimeterMm += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const mean =
    thickness.length > 0 ? thickness.reduce((s, v) => s + v, 0) / thickness.length : 0;

  if (areaMm2 <= 0) {
    return { areaMm2: 0, perimeterMm, volumeMm3: 0, avgThickness: mean, valid: false };
  }

  const tris = triangulate(poly);
  let volumeMm3 = 0;
  if (tris.length === poly.length - 2) {
    for (const [i, j, k] of tris) {
      const a = poly[i];
      const b = poly[j];
      const c = poly[k];
      const ta = Math.abs(a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) / 2;
      const h = (thickness[i] + thickness[j] + thickness[k]) / 3;
      volumeMm3 += ta * h;
    }
  } else {
    // Fallback for pathological polygons: mean thickness over the area.
    volumeMm3 = areaMm2 * mean;
  }

  return {
    areaMm2,
    perimeterMm,
    volumeMm3,
    avgThickness: areaMm2 > 0 ? volumeMm3 / areaMm2 : mean,
    valid: volumeMm3 > 0,
  };
}

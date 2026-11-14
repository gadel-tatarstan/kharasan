export type Pt = { x: number; y: number };
export type Rect = { x0: number; y0: number; x1: number; y1: number };

export const pt = (x: number, y: number): Pt => ({ x, y });
export const EPS = 1e-6;

export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const normalize = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Signed area. Positive = counter-clockwise in a y-down screen space convention we normalise away. */
export function signedArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export const polygonArea = (poly: Pt[]) => Math.abs(signedArea(poly));

export function isCCW(poly: Pt[]): boolean {
  return signedArea(poly) > 0;
}

export function ensureCCW(poly: Pt[]): Pt[] {
  return isCCW(poly) ? poly.slice() : poly.slice().reverse();
}

export function boundsOf(points: Pt[]): Rect {
  if (!points.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

export const rectCenter = (r: Rect): Pt => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
export const rectW = (r: Rect) => r.x1 - r.x0;
export const rectH = (r: Rect) => r.y1 - r.y0;

/**
 * A point strictly inside a simple polygon. Contours are allowed to share
 * boundaries (zero offsets), so a vertex is no longer a reliable probe: it may
 * sit exactly on another contour. The midpoint of the longest edge, nudged to
 * the interior, always lies inside.
 */
export function interiorPoint(poly: Pt[]): Pt {
  if (!poly.length) return { x: 0, y: 0 };
  let edge = 0;
  let edgeLen = -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > edgeLen) {
      edgeLen = len;
      edge = i;
    }
  }
  const a = poly[edge];
  const b = poly[(edge + 1) % poly.length];
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const box = boundsOf(poly);
  const eps = Math.max(1e-6, Math.max(box.x1 - box.x0, box.y1 - box.y0) * 1e-6);
  const sign = signedArea(poly) >= 0 ? 1 : -1;
  const nx = -(b.y - a.y) * sign;
  const ny = (b.x - a.x) * sign;
  const len = Math.hypot(nx, ny) || 1;
  return { x: m.x + (nx / len) * eps, y: m.y + (ny / len) * eps };
}

/** Orientation of a triplet: 1 = clockwise, -1 = counter-clockwise, 0 = collinear. */
function orient(a: Pt, b: Pt, c: Pt): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(v) < EPS) return 0;
  return v > 0 ? 1 : -1;
}

function onSegment(a: Pt, b: Pt, p: Pt): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/**
 * Proper intersection / touch test between two segments.
 * `touch` counts shared endpoints and collinear overlaps as intersections.
 */
export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/** True when the two segments lie on one line and share a positive-length run. */
export function collinearOverlap(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const horizontal =
    Math.abs(a.y - b.y) < EPS && Math.abs(c.y - d.y) < EPS && Math.abs(a.y - c.y) < EPS;
  const vertical =
    Math.abs(a.x - b.x) < EPS && Math.abs(c.x - d.x) < EPS && Math.abs(a.x - c.x) < EPS;
  if (!horizontal && !vertical) return false;
  const [a0, a1] = horizontal
    ? [Math.min(a.x, b.x), Math.max(a.x, b.x)]
    : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  const [b0, b1] = horizontal
    ? [Math.min(c.x, d.x), Math.max(c.x, d.x)]
    : [Math.min(c.y, d.y), Math.max(c.y, d.y)];
  return Math.min(a1, b1) - Math.max(a0, b0) > EPS;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** True when the polygon has no self-intersections and no repeated vertices. */
export function isSimplePolygon(poly: Pt[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const c = poly[j];
      const d = poly[(j + 1) % n];
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      // non adjacent edges must not touch at all
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return dist(p, a);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

export function dedupe(points: Pt[], minDist: number): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (!out.length || dist(out[out.length - 1], p) >= minDist) {
      out.push(p);
    }
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) < minDist) out.pop();
  return out;
}

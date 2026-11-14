import { dedupe, dist, ensureCCW, isSimplePolygon, polygonArea, type Pt } from './vec';

export type FitFailure =
  | 'too-few-points'
  | 'self-intersection'
  | 'degenerate'
  | 'impossible';

export type FitResult =
  | { ok: true; poly: Pt[]; dropped: number }
  | { ok: false; reason: FitFailure };

export const failText: Record<FitFailure, string> = {
  'too-few-points':
    'Нужно минимум 3 точки: после них четвёртый угол достраивается сам. Поставьте ещё точку.',
  'self-intersection':
    'Стороны контура пересекаются. Такую плиту нельзя залить одним контуром — уберите пересечение.',
  degenerate:
    'Точки стоят слишком близко друг к другу: один из отрезков получился нулевой длины. Разнесите точки.',
  impossible:
    'Из этих точек нельзя построить контур с прямыми углами. Попробуйте упростить форму.',
};

type Axis = 'H' | 'V';

const classifyEdge = (a: Pt, b: Pt): Axis =>
  Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'H' : 'V';

const axisOfPattern = (index: number, first: Axis): Axis =>
  index % 2 === 0 ? first : first === 'H' ? 'V' : 'H';

/** Removes one vertex of the shortest edge to get an even vertex count. */
function dropShortestEdge(points: Pt[]): Pt[] {
  const n = points.length;
  let best = 0;
  let bestLen = Infinity;
  for (let i = 0; i < n; i++) {
    const len = dist(points[i], points[(i + 1) % n]);
    if (len < bestLen) {
      bestLen = len;
      best = i;
    }
  }
  // Drop the endpoint of the shortest edge that has the shorter neighbouring edge:
  // that removes the least meaningful corner first.
  const prev = (best - 1 + n) % n;
  const next = (best + 2) % n;
  const prevEdge = dist(points[prev], points[best]);
  const nextEdge = dist(points[(best + 1) % n], points[next]);
  const dropIndex = prevEdge <= nextEdge ? best : (best + 1) % n;
  return points.filter((_, i) => i !== dropIndex);
}

function chooseFirstAxis(points: Pt[], cls: Axis[]): Axis {
  const n = points.length;
  const score = (first: Axis) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (axisOfPattern(i, first) !== cls[i]) s += dist(points[i], points[(i + 1) % n]);
    }
    return s;
  };
  const scoreH = score('H');
  const scoreV = score('V');
  if (Math.abs(scoreH - scoreV) < 1e-9) return cls[0];
  return scoreH < scoreV ? 'H' : 'V';
}

/**
 * Snaps a rough polygon to a rectilinear one.
 *
 * Insight: a closed orthogonal polygon always alternates horizontal and vertical
 * edges, so horizontal edges pair up vertices (a perfect matching) and so do
 * vertical ones. That means every vertex gets its Y from its horizontal edge and
 * its X from its vertical edge — no linear system, no iterations, and every edge
 * is exactly axis aligned afterwards.
 */
export function fitOrthogonalPolygon(raw: Pt[], minDist: number): FitResult {
  let points = dedupe(raw, minDist);
  if (points.length < 4) return { ok: false, reason: 'too-few-points' };

  let dropped = raw.length - points.length;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (points.length < 4) return { ok: false, reason: 'too-few-points' };
    if (points.length % 2 === 1) {
      points = dropShortestEdge(points);
      dropped++;
      continue;
    }

    const cls = points.map((p, i) => classifyEdge(p, points[(i + 1) % points.length]));
    const first = chooseFirstAxis(points, cls);
    const n = points.length;
    const xs = new Array<number>(n);
    const ys = new Array<number>(n);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = points[i];
      const b = points[j];
      if (axisOfPattern(i, first) === 'H') {
        const y = (a.y + b.y) / 2;
        ys[i] = y;
        ys[j] = y;
      } else {
        const x = (a.x + b.x) / 2;
        xs[i] = x;
        xs[j] = x;
      }
    }

    const poly: Pt[] = points.map((_, i) => ({ x: xs[i], y: ys[i] }));

    // A zero-length edge means two sketch points were effectively on the same
    // coordinate line — tighten the tolerance and fit again.
    let minEdge = Infinity;
    for (let i = 0; i < n; i++) minEdge = Math.min(minEdge, dist(poly[i], poly[(i + 1) % n]));
    if (minEdge < minDist * 0.5) {
      const before = points.length;
      points = dedupe(points, minDist * 1.6);
      dropped += before - points.length;
      if (points.length === before) return { ok: false, reason: 'degenerate' };
      continue;
    }

    if (polygonArea(poly) < 1e-6) return { ok: false, reason: 'degenerate' };

    if (!isSimplePolygon(poly)) {
      // Try again with a slightly different parity start; the other alternation
      // is often the shape the user actually meant.
      const other: Axis = first === 'H' ? 'V' : 'H';
      const altXs = new Array<number>(n);
      const altYs = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = points[i];
        const b = points[j];
        if (axisOfPattern(i, other) === 'H') {
          const y = (a.y + b.y) / 2;
          altYs[i] = y;
          altYs[j] = y;
        } else {
          const x = (a.x + b.x) / 2;
          altXs[i] = x;
          altXs[j] = x;
        }
      }
      const alt = points.map((_, i) => ({ x: altXs[i], y: altYs[i] }));
      if (polygonArea(alt) > 1e-6 && isSimplePolygon(alt)) {
        return { ok: true, poly: ensureCCW(alt), dropped };
      }
      return { ok: false, reason: 'self-intersection' };
    }

    return { ok: true, poly: ensureCCW(poly), dropped };
  }

  return { ok: false, reason: 'impossible' };
}

/** Snaps a point to the dominant axis of the previous one — keeps sketches clean. */
export function orthoSnap(from: Pt | null, to: Pt): Pt {
  if (!from) return to;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return dx >= dy ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
}

import type { Pt } from './vec';

export type HeightRect = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Height of the concrete at a world point inside the rect (mm). */
  heightAt: (p: Pt) => number;
};

export type UnionResult = {
  /** Area of the union in mm². */
  areaMm2: number;
  /** Volume of the union in mm³, integrating the per-rect height fields. */
  volumeMm3: number;
  /** Outline of the union as closed polygons (world mm). */
  outline: Pt[][];
  rects: { x0: number; y0: number; x1: number; y1: number }[];
};

/**
 * Grid lines closer than this are the same line (millimetres).
 *
 * Rectangle bounds are computed from sums of millimetre lengths, so two sides
 * that must meet can differ by tiny floating-point noise. Keeping such a pair
 * as separate grid lines leaves a hairline crack of zero width in the union;
 * the boundary walk then traces both sides of the crack and the winding numbers
 * cancel, which used to paint holes and drop whole bands. One micron is far
 * below any real concrete dimension, so merging at this scale is safe.
 */
const COORD_TOL = 1e-3;

const uniqSorted = (values: number[]): number[] => {
  const sorted = values.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (!out.length || Math.abs(out[out.length - 1] - v) > COORD_TOL) out.push(v);
  }
  return out;
};

const lowerBound = (arr: number[], value: number): number => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    // Same tolerance as `uniqSorted`, otherwise a value that belongs to a
    // merged cluster would land one cell past its representative line.
    if (arr[m] < value - COORD_TOL) lo = m + 1;
    else hi = m;
  }
  return lo;
};

/**
 * Exact union of axis-aligned rectangles using coordinate compression.
 *
 * The strip is modelled as a set of rectangles (one per segment, extended at
 * mitred joints). Because every rectangle is axis aligned, a compressed grid
 * covers the union exactly — no clipping library needed, and the same pass
 * gives the area, the milled volume and a clean outline for rendering.
 */
export function unionAxisRects(rects: HeightRect[]): UnionResult {
  if (!rects.length) {
    return { areaMm2: 0, volumeMm3: 0, outline: [], rects: [] };
  }

  const xs = uniqSorted(rects.flatMap((r) => [r.x0, r.x1]));
  const ys = uniqSorted(rects.flatMap((r) => [r.y0, r.y1]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) {
    return { areaMm2: 0, volumeMm3: 0, outline: [], rects: [] };
  }

  const cellRects: number[][] = Array.from({ length: nx * ny }, () => []);
  for (let ri = 0; ri < rects.length; ri++) {
    const r = rects[ri];
    const i0 = lowerBound(xs, r.x0);
    const i1 = lowerBound(xs, r.x1);
    const j0 = lowerBound(ys, r.y0);
    const j1 = lowerBound(ys, r.y1);
    for (let j = Math.max(0, j0); j < Math.min(ny, j1); j++) {
      for (let i = Math.max(0, i0); i < Math.min(nx, i1); i++) {
        cellRects[j * nx + i].push(ri);
      }
    }
  }

  const covered = new Uint8Array(nx * ny);
  let areaMm2 = 0;
  let volumeMm3 = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const list = cellRects[j * nx + i];
      if (!list.length) continue;
      covered[j * nx + i] = 1;
      const w = xs[i + 1] - xs[i];
      const h = ys[j + 1] - ys[j];
      const area = w * h;
      const c: Pt = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
      let sum = 0;
      for (const ri of list) sum += rects[ri].heightAt(c);
      areaMm2 += area;
      volumeMm3 += area * (sum / list.length);
    }
  }

  // Walk the boundary of the covered cells into closed loops.
  //
  // Vertices are addressed by integer grid indices, not by rounded coordinates:
  // rectangle edges are computed from sums of millimetre lengths, so two grid
  // lines that should coincide can differ by a fraction of a micron. Keying the
  // walk by `Math.round(x * 1e3)` would merge those distinct corners, mix up
  // unrelated half-edges and produce a single self-crossing loop — which then
  // paints holes and drops whole bands. Indices stay exact.
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : covered[j * nx + i]);
  type Half = { fi: number; fj: number; ti: number; tj: number };
  const vkey = (i: number, j: number) => j * (nx + 1) + i;
  const edges = new Map<number, Half[]>();
  const addEdge = (fi: number, fj: number, ti: number, tj: number) => {
    const k = vkey(fi, fj);
    const arr = edges.get(k);
    if (arr) arr.push({ fi, fj, ti, tj });
    else edges.set(k, [{ fi, fj, ti, tj }]);
  };

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!covered[j * nx + i]) continue;
      if (!at(i, j - 1)) addEdge(i, j, i + 1, j);
      if (!at(i + 1, j)) addEdge(i + 1, j, i + 1, j + 1);
      if (!at(i, j + 1)) addEdge(i + 1, j + 1, i, j + 1);
      if (!at(i - 1, j)) addEdge(i, j + 1, i, j);
    }
  }

  const dirOf = (e: Half): number => {
    if (e.ti !== e.fi) return e.ti > e.fi ? 0 : 2;
    return e.tj > e.fj ? 1 : 3;
  };

  /**
   * At a vertex where several boundary edges meet (a T-junction pinches four
   * edges into one point) the walk must always take the sharpest right turn:
   * that keeps the interior on the same side and never cuts the loop.
   */
  const pickNext = (list: Half[], prevDir: number): Half => {
    if (list.length === 1) return list[0];
    let best = 0;
    let bestRank = 9;
    list.forEach((e, i) => {
      const turn = (((dirOf(e) - prevDir) % 4) + 4) % 4; // 1 = right, 3 = left
      const rank = turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3;
      if (rank < bestRank) {
        bestRank = rank;
        best = i;
      }
    });
    return list[best];
  };

  type Corner = { i: number; j: number };
  const outline: Pt[][] = [];
  let guard = 0;
  while (edges.size && guard++ < 20000) {
    const firstKey = edges.keys().next().value as number;
    const startList = edges.get(firstKey);
    if (!startList || !startList.length) {
      edges.delete(firstKey);
      continue;
    }
    const loop: Corner[] = [];
    let current = startList.shift()!;
    if (!startList.length) edges.delete(firstKey);
    loop.push({ i: current.fi, j: current.fj }, { i: current.ti, j: current.tj });
    const startKey = firstKey;
    let safety = 0;
    while (safety++ < 100000) {
      const k = vkey(current.ti, current.tj);
      const list = edges.get(k);
      if (!list || !list.length) {
        edges.delete(k);
        break;
      }
      const next = pickNext(list, dirOf(current));
      const idx = list.indexOf(next);
      if (idx >= 0) list.splice(idx, 1);
      if (!list.length) edges.delete(k);
      current = next;
      if (vkey(next.ti, next.tj) === startKey) break; // back at the start: closed
      loop.push({ i: next.ti, j: next.tj });
    }
    // Drop repeated corners and corners that lie on a straight run.
    const simplified: Corner[] = [];
    for (const p of loop) {
      const prev = simplified[simplified.length - 1];
      if (prev && prev.i === p.i && prev.j === p.j) continue;
      simplified.push(p);
    }
    const clean: Corner[] = [];
    for (let i = 0; i < simplified.length; i++) {
      const a = simplified[(i - 1 + simplified.length) % simplified.length];
      const b = simplified[i];
      const c = simplified[(i + 1) % simplified.length];
      const collinear = (a.i === b.i && b.i === c.i) || (a.j === b.j && b.j === c.j);
      if (!collinear) clean.push(b);
    }
    const target = (clean.length >= 3 ? clean : simplified).map((p) => ({ x: xs[p.i], y: ys[p.j] }));
    if (target.length >= 3) outline.push(target);
  }

  return {
    areaMm2,
    volumeMm3,
    outline,
    rects: rects.map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 })),
  };
}

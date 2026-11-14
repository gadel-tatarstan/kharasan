import {
  EPS,
  boundsOf,
  interiorPoint,
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  type Pt,
  type Rect,
} from '../geometry/vec';
import { fmtMm } from '../lib/format';
import {
  contoursProperlyCross,
  nestingDepth,
  slabMetrics,
  type SlabMetrics,
} from '../geometry/slab';
import { failText, fitOrthogonalPolygon } from '../geometry/ortho';
import {
  buildStrip,
  faceRuns,
  netFailText,
  toothBandAreaMm2,
  validateTopology,
  type BuiltStrip,
  type FaceRun,
  type NetNode,
  type NetSeg,
  type SegmentGeometry,
} from '../geometry/strip';
import { newContour, type SlabContour, type SlabState, type StripState } from './types';

export type SlabEdge = {
  index: number;
  a: Pt;
  b: Pt;
  axis: 'H' | 'V';
  /** Real length in mm. */
  len: number;
  baseLen: number;
};

/** One contour with its role in the slab worked out. */
export type SlabPart = {
  id: string;
  poly: Pt[];
  edges: SlabEdge[];
  thickness: number[];
  /** 0 = outermost, 1 = inside it, 2 = island inside a void … */
  depth: number;
  role: 'add' | 'hole';
  metrics: SlabMetrics;
};

export type SlabDerived = {
  parts: SlabPart[];
  /** Signed total: added contours minus voids. */
  metrics: SlabMetrics;
};

export const SLAB_MIN_LEN = 10;
export const SLAB_MAX_LEN = 200000;

export type EdgeAxis = { axis: 'H' | 'V'; sign: 1 | -1 };

/** Direction each edge travels in when walking the snapped polygon. */
export function edgeAxes(base: Pt[]): EdgeAxis[] {
  const n = base.length;
  const out: EdgeAxis[] = [];
  for (let i = 0; i < n; i++) {
    const a = base[i];
    const b = base[(i + 1) % n];
    const h = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const d = h ? b.x - a.x : b.y - a.y;
    out.push({ axis: h ? 'H' : 'V', sign: d >= 0 ? 1 : -1 });
  }
  return out;
}

export function polyCentroid(poly: Pt[]): Pt {
  if (!poly.length) return { x: 0, y: 0 };
  const x = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const y = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  return { x, y };
}

/** Lengths of every edge of an axis-aligned polygon. */
export function lensFromBase(base: Pt[]): number[] {
  const n = base.length;
  return base.map((p, i) => {
    const q = base[(i + 1) % n];
    return Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
  });
}

/**
 * Keeps one edge exactly where it was while the polygon is rebuilt. Used when a
 * perpendicular side is pinned: that side must not creep, the opposite side moves.
 */
export type LensAnchor = {
  /** Index of the edge whose line must not move. */
  edge: number;
  /** World coordinate of that edge (x for vertical, y for horizontal). */
  value: number;
};

/**
 * Rebuilds the polygon by walking the snapped edge directions with real lengths.
 * Every angle stays 90° by construction; the shape is re-centred on `pivot` so it
 * does not crawl across the canvas while dimensions are edited. When `anchor` is
 * given, that edge keeps its coordinate instead of splitting the shift in half.
 */
export function polyFromLens(
  base: Pt[],
  lens: number[],
  pivot: Pt,
  anchor?: LensAnchor | null,
): Pt[] {
  const ax = edgeAxes(base);
  const pts: Pt[] = [];
  let p: Pt = { x: 0, y: 0 };
  for (let i = 0; i < ax.length; i++) {
    pts.push(p);
    const d = (ax[i].sign * (lens[i] ?? 0));
    p = ax[i].axis === 'H' ? { x: p.x + d, y: p.y } : { x: p.x, y: p.y + d };
  }
  const c = polyCentroid(pts);
  let ox = pivot.x - c.x;
  let oy = pivot.y - c.y;
  if (anchor && anchor.edge >= 0 && anchor.edge < ax.length) {
    const edge = ax[anchor.edge];
    if (edge.axis === 'H') oy = anchor.value - pts[anchor.edge].y;
    else ox = anchor.value - pts[anchor.edge].x;
  }
  return pts.map((q) => ({ x: q.x + ox, y: q.y + oy }));
}

const hasLens = (c: SlabContour): c is SlabContour & { lens: number[] } =>
  !!c.base && !!c.lens && c.lens.length === c.base.length;

/** Current polygon of one contour: rebuilt from lengths when they exist. */
export function contourPoly(c: SlabContour): Pt[] | null {
  if (!c.base) return null;
  if (hasLens(c)) return polyFromLens(c.base, c.lens, c.pivot);
  return c.base.map((p) => ({ ...p }));
}

/** Edge lengths of one contour in mm, whatever representation it is stored in. */
export function contourLens(c: SlabContour): number[] {
  if (!c.base) return [];
  if (hasLens(c)) return c.lens.slice();
  return lensFromBase(c.base);
}

export function contourEdges(c: SlabContour): SlabEdge[] {
  if (!c.base) return [];
  const poly = contourPoly(c);
  if (!poly) return [];
  const ax = edgeAxes(c.base);
  const lens = contourLens(c);
  const n = c.base.length;
  const out: SlabEdge[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = c.base[i];
    const b0 = c.base[(i + 1) % n];
    const baseLen = ax[i].axis === 'H' ? Math.abs(b0.x - a0.x) : Math.abs(b0.y - a0.y);
    out.push({
      index: i,
      a: poly[i],
      b: poly[(i + 1) % n],
      axis: ax[i].axis,
      baseLen,
      len: lens[i],
    });
  }
  return out;
}

/**
 * All closed contours with their role. A contour nested inside an odd number of
 * others is a void and subtracts its volume; an even one adds. That is exactly
 * “outside is more concrete, inside is a hole”, and it also lets an island sit
 * inside a hole.
 */
export function deriveSlab(slab: SlabState): SlabDerived | null {
  const closed = slab.contours
    .map((c) => ({ c, poly: contourPoly(c) }))
    .filter((x): x is { c: SlabContour; poly: Pt[] } => !!x.poly);
  if (!closed.length) return null;

  const polys = closed.map((x) => x.poly);
  const depths = polys.map((_, i) => nestingDepth(polys, i));

  const parts: SlabPart[] = closed.map(({ c, poly }, i) => {
    const thickness = c.base!.map((_, k) => c.vThickness[k] ?? slab.thickness);
    return {
      id: c.id,
      poly,
      edges: contourEdges(c),
      thickness,
      depth: depths[i],
      role: depths[i] % 2 === 0 ? 'add' : 'hole',
      metrics: slabMetrics(poly, thickness),
    };
  });

  let areaMm2 = 0;
  let volumeMm3 = 0;
  let perimeterMm = 0;
  for (const part of parts) {
    const sign = part.role === 'add' ? 1 : -1;
    areaMm2 += sign * part.metrics.areaMm2;
    volumeMm3 += sign * part.metrics.volumeMm3;
    perimeterMm += part.metrics.perimeterMm;
  }

  return {
    parts,
    metrics: {
      areaMm2,
      perimeterMm,
      volumeMm3,
      avgThickness: areaMm2 > 1 ? volumeMm3 / areaMm2 : 0,
      valid: areaMm2 > 0 && volumeMm3 > 0,
    },
  };
}

export type LengthResult =
  | { ok: true; slab: SlabState }
  | { ok: false; reason: string };

/**
 * Edges the user pinned by hand. Old saves only knew a single reference edge, so
 * they are migrated to a one-element pin set on read.
 */
export function pinnedEdges(c: SlabContour): Set<number> {
  if (c.pinned) return new Set(c.pinned);
  return new Set(c.refEdge != null ? [c.refEdge] : []);
}

/**
 * The side that should stay put while one edge length changes.
 *
 * The edited edge has exactly two perpendicular neighbours — the sides from which
 * it grows or shrinks. If only one of them is pinned (green), that side keeps its
 * position and the other side takes the whole shift. When both neighbours are
 * pinned or both are free there is no single preferred side, so the polygon is
 * re-centred as before and the change is split evenly.
 */
function pinnedSideAnchor(
  base: Pt[],
  pinned: Set<number>,
  edited: number,
  poly: Pt[],
): LensAnchor | null {
  const ax = edgeAxes(base);
  const n = ax.length;
  if (edited < 0 || edited >= n || n < 3) return null;
  const prev = (edited - 1 + n) % n;
  const next = (edited + 1) % n;
  const neighbours = [prev, next].filter(
    (i) => i !== edited && ax[i].axis !== ax[edited].axis && pinned.has(i),
  );
  if (neighbours.length !== 1) return null;
  const edge = neighbours[0];
  return {
    edge,
    value: ax[edge].axis === 'H' ? poly[edge].y : poly[edge].x,
  };
}

const AXIS_WORD: Record<EdgeAxis['axis'], string> = {
  H: 'горизонтальные',
  V: 'вертикальные',
};

const pinnedConflict = (axis: EdgeAxis['axis'], diff: number) =>
  `Закреплённые ${AXIS_WORD[axis]} стороны не сходятся: разница ${fmtMm(Math.abs(diff))} мм. ` +
  'Открепите одну из них долгим нажатием на число и введите значение снова.';

const LEN_TOL = 1e-3;

type SolveResult =
  | { ok: true; variants: number[][] }
  | { ok: false; reason: string };

type AxisPlan = { indices: number[]; list: number[][] } | { reason: string };

const inRange = (v: number) =>
  Number.isFinite(v) && v >= SLAB_MIN_LEN - LEN_TOL && v <= SLAB_MAX_LEN + LEN_TOL;

const BOUNDS_REASON =
  'Свободной стороне не хватает длины: она вышла бы за пределы 10 мм … 200 м. ' +
  'Открепите мешающую сторону долгим нажатием на число и попробуйте снова.';

/**
 * Resolves one axis so its signed lengths sum to zero around the pinned values.
 *
 * Pinned lengths are copied verbatim. The difference is absorbed by the free sides
 * in order of preference: first a single side, ideally the one lying across from
 * the edge being edited (that is how a person drags a wall — the opposite wall
 * moves as a whole, nothing else shrinks). Only if no single side can take the
 * change are the remaining free sides adjusted evenly, then scaled together.
 * Several variants are returned so the caller can pick one that stays simple.
 */
function solveAxis(
  base: Pt[],
  lens: number[],
  pinned: Set<number>,
  ax: EdgeAxis[],
  axis: 'H' | 'V',
  edited: number,
): AxisPlan {
  const indices: number[] = [];
  for (let i = 0; i < ax.length; i++) if (ax[i].axis === axis) indices.push(i);
  const free = indices.filter((i) => !pinned.has(i));
  const anchored = indices.filter((i) => pinned.has(i));
  const sumOf = (idx: number[]) => idx.reduce((s, i) => s + ax[i].sign * lens[i], 0);

  if (!free.length) {
    const total = sumOf(indices);
    if (Math.abs(total) > LEN_TOL) return { reason: pinnedConflict(axis, total) };
    return { indices, list: [lens.slice()] };
  }

  const target = -sumOf(anchored);
  const current = sumOf(free);
  if (Math.abs(target - current) <= LEN_TOL) return { indices, list: [lens.slice()] };

  const midOf = (i: number) => {
    const a = base[i];
    const b = base[(i + 1) % base.length];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const editedSign = edited >= 0 && ax[edited] ? ax[edited].sign : 0;
  const rank = (i: number) => {
    const opposite = editedSign !== 0 && ax[i].sign !== editedSign ? 0 : 1e6;
    if (edited < 0 || !base[edited]) return opposite;
    const p = midOf(i);
    const q = midOf(edited);
    // the far side of the shape is the one the user sees as “напротив”
    const distance = ax[i].axis === 'H' ? Math.abs(p.y - q.y) : Math.abs(p.x - q.x);
    return opposite - distance;
  };

  const list: number[][] = [];
  const push = (next: number[]) => {
    if (!free.every((i) => inRange(next[i]))) return;
    if (list.some((v) => v.every((x, k) => Math.abs(x - next[k]) <= LEN_TOL))) return;
    list.push(next);
  };

  // 1. One free side takes the whole difference — preferred and most predictable.
  const ranked = free.slice().sort((a, b) => rank(a) - rank(b));
  for (const j of ranked) {
    const v = lens[j] + (target - current) / ax[j].sign;
    if (!inRange(v)) continue;
    const next = lens.slice();
    next[j] = v;
    push(next);
    if (list.length >= 3) break;
  }

  // 2. Split evenly in signed terms.
  const even = lens.slice();
  for (const i of free) even[i] = lens[i] + (target - current) / (free.length * ax[i].sign);
  push(even);

  // 3. Uniform scale, the old behaviour — still valid when the free sides are parallel.
  if (Math.abs(current) > 1e-9) {
    const k = target / current;
    if (k > 0) {
      const scaled = lens.slice();
      for (const i of free) scaled[i] = lens[i] * k;
      push(scaled);
    }
  }

  if (!list.length) return { reason: BOUNDS_REASON };
  return { indices, list };
}

/**
 * Closes the rectilinear polygon around the pinned lengths and returns every sane
 * way of doing it, best first.
 */
export function solveSlabLens(
  base: Pt[],
  lens: number[],
  pinned: Set<number>,
  edited = -1,
): SolveResult {
  const ax = edgeAxes(base);
  let combos: number[][] = [lens.slice()];

  for (const axis of ['H', 'V'] as const) {
    const plan = solveAxis(base, lens, pinned, ax, axis, edited);
    if ('reason' in plan) return { ok: false, reason: plan.reason };
    const next: number[][] = [];
    for (const combo of combos) {
      for (const variant of plan.list) {
        const merged = combo.slice();
        for (const i of plan.indices) merged[i] = variant[i];
        next.push(merged);
      }
    }
    combos = next.slice(0, 8);
  }

  return { ok: true, variants: combos };
}

const NO_CONTOUR = 'Контур не замкнут — сначала замкните контур.';

/**
 * Sets the length of one edge of one contour and pins it.
 *
 * Every number the user typed stays exactly as typed; the free edges of the same
 * axis absorb the difference so the contour still closes at 90° and does not run
 * into a neighbouring contour. Nothing is recomputed behind the user's back.
 */
export function setSlabEdgeLength(
  slab: SlabState,
  contourId: string,
  index: number,
  mm: number,
): LengthResult {
  const contour = slab.contours.find((c) => c.id === contourId);
  if (!contour || !contour.base) return { ok: false, reason: NO_CONTOUR };
  const lens = contourLens(contour);
  const value = Math.min(SLAB_MAX_LEN, Math.max(SLAB_MIN_LEN, mm));

  if (!slab.entered) {
    // First real number: it fixes sketch units to millimetres for every contour at
    // once, so contours drawn next to each other keep their relative placement.
    const k = value / Math.max(lens[index], 1e-6);
    const contours = slab.contours.map((c): SlabContour => {
      const raw = c.raw.map((p) => ({ x: p.x * k, y: p.y * k }));
      if (!c.base) return { ...c, raw, pivot: { x: c.pivot.x * k, y: c.pivot.y * k } };
      const base = c.base.map((p) => ({ x: p.x * k, y: p.y * k }));
      return {
        ...c,
        raw,
        base,
        pivot: polyCentroid(base),
        lens: lensFromBase(base),
        pinned: c.id === contourId ? [index] : (c.pinned ?? null),
        vThickness: base.map((_, i) => c.vThickness[i] ?? null),
        entered: true,
      };
    });
    return { ok: true, slab: { ...slab, contours, entered: true } };
  }

  lens[index] = value;
  const pinned = pinnedEdges(contour);
  pinned.add(index);

  // A pinned perpendicular side stays exactly where the user sees it; the
  // opposite side absorbs the change instead of both moving by half.
  const before = contourPoly(contour);
  const anchor = before ? pinnedSideAnchor(contour.base, pinned, index, before) : null;

  const solved = solveSlabLens(contour.base, lens, pinned, index);
  if (!solved.ok) return { ok: false, reason: solved.reason };

  const others = slab.contours
    .filter((c) => c.id !== contourId && c.base)
    .map((c) => contourPoly(c))
    .filter((poly): poly is Pt[] => !!poly);

  for (const variant of solved.variants) {
    const poly = polyFromLens(contour.base, variant, contour.pivot, anchor);
    if (!isSimplePolygon(poly) || polygonArea(poly) < 1) continue;
    if (others.some((other) => contoursProperlyCross(poly, other))) continue;
    return {
      ok: true,
      slab: {
        ...slab,
        contours: slab.contours.map((c) =>
          c.id === contourId
            ? {
                ...c,
                lens: variant,
                // The polygon is always rebuilt from lens, so the anchored
                // position has to be encoded in the pivot to survive a reload.
                pivot: polyCentroid(poly),
                entered: true,
                pinned: [...pinned].sort((a, b) => a - b),
              }
            : c,
        ),
      },
    };
  }

  return {
    ok: false,
    reason:
      'С такими размерами контур самопересечётся или налезет на другой контур. Уменьшите значение или открепите одну из сторон.',
  };
}

/** Long press releases or re-locks an edge. Lengths never change, so the shape stays valid. */
export function toggleSlabPin(slab: SlabState, contourId: string, index: number): SlabState {
  return {
    ...slab,
    contours: slab.contours.map((c) => {
      if (c.id !== contourId) return c;
      const pinned = pinnedEdges(c);
      if (pinned.has(index)) pinned.delete(index);
      else pinned.add(index);
      return { ...c, pinned: [...pinned].sort((a, b) => a - b) };
    }),
  };
}

export const CONTOUR_CROSS_TEXT =
  'Контуры пересекаются. Проведите контур целиком снаружи — тогда его объём прибавится — ' +
  'или целиком внутри — тогда он станет выемкой.';

/** Adds an empty contour the canvas can be drawn into. Only one draft at a time. */
export function addSlabContour(slab: SlabState): SlabState {
  if (slab.contours.some((c) => !c.base)) return slab;
  return { ...slab, contours: [...slab.contours, newContour()] };
}

/** Drops the unfinished contour, if there is one. */
export function cancelSlabContour(slab: SlabState): SlabState {
  return { ...slab, contours: slab.contours.filter((c) => !!c.base) };
}

/** Appends a point to the contour being drawn, starting it when needed. */
export function appendSlabPoint(slab: SlabState, world: Pt): SlabState {
  const draft = slab.contours.find((c) => !c.base);
  if (!draft) return { ...slab, contours: [...slab.contours, { ...newContour(), raw: [world] }] };
  return {
    ...slab,
    contours: slab.contours.map((c) =>
      c.id === draft.id ? { ...c, raw: [...c.raw, world] } : c,
    ),
  };
}

export function undoSlabPoint(slab: SlabState): SlabState {
  return {
    ...slab,
    contours: slab.contours.map((c) =>
      !c.base && c.raw.length ? { ...c, raw: c.raw.slice(0, -1) } : c,
    ),
  };
}

export function removeSlabContour(slab: SlabState, id: string): SlabState {
  return { ...slab, contours: slab.contours.filter((c) => c.id !== id) };
}

/** Clears every contour and starts the outline from scratch. */
export function resetSlab(slab: SlabState): SlabState {
  return { ...slab, contours: [], entered: false };
}

/**
 * Placement of one contour relative to the contour it belongs to.
 *
 * Nested contours (voids and islands inside them) are described by four offsets
 * from the reference bounding box, so a void reads exactly as “столько-то от
 * левого/верхнего края”.
 *
 * External added contours are positioned by real distances instead: a gap between
 * the facing edges, plus — when the contours overlap along the other axis — the
 * two distances between their parallel edge planes. A side-by-side contour thus
 * gets three numbers (gap + top/bottom alignment), a diagonal one gets two
 * (gap by X and gap by Y). Values are never negative.
 */
export type SlabPlacement = {
  id: string;
  /** 1-based number, matching the contour list. */
  label: number;
  role: 'add' | 'hole';
  refId: string | null;
  refLabel: number | null;
  /** How this contour is edited: four sides for nested, distances for outside ones. */
  mode: 'sides' | 'gaps';
  /** For an external contour: axes that need a gap value (the others are aligned). */
  gapAxis: 'x' | 'y' | 'both' | null;
  /** Offsets from the left/top sides of the reference box (kept for old callers). */
  dx: number;
  dy: number;
  /**
   * Nested: signed offsets from the four sides of the reference box.
   * External: non-negative distances between the parallel edge planes.
   */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Gap from the facing edge of the main contour, mm. */
  gapX: number;
  gapY: number;
  /** Coordinate of that facing edge and which side of it the contour lies on. */
  gapXRef: number;
  gapYRef: number;
  gapXSide: 'before' | 'after' | null;
  gapYSide: 'before' | 'after' | null;
};

/** For every polygon: which of the other polygons enclose it. */
function coveringSets(polys: Pt[][]): number[][] {
  return polys.map((poly, i) => {
    if (!poly.length) return [];
    // Shared boundaries are valid (zero offsets), so probe the interior.
    const probe = interiorPoint(poly);
    const out: number[] = [];
    for (let j = 0; j < polys.length; j++) {
      if (j !== i && pointInPolygon(probe, polys[j])) out.push(j);
    }
    return out;
  });
}

type AxisGap = {
  gap: number;
  /** Coordinate of the main-contour edge plane the gap is measured from. */
  ref: number;
  /** 'after' = the contour is to the right/below the edge, 'before' = left/above. */
  side: 'before' | 'after';
};

/**
 * Distance from an external contour to the nearest *facing* edge of the main
 * contour along one axis. Only edges whose span covers the contour are used, so
 * a contour beside the slab is measured from the slab's side, not from a distant
 * corner. When the projections do not meet at all (a diagonal placement), the
 * bounding boxes are used instead — the distance is still real, just not between
 * directly facing segments.
 */
function facingGap(poly: Pt[], box: Rect, refBox: Rect, axis: 'x' | 'y'): AxisGap | null {
  const [extLo, extHi, otherLo, otherHi] =
    axis === 'x' ? [box.x0, box.x1, box.y0, box.y1] : [box.y0, box.y1, box.x0, box.x1];
  let best: AxisGap | null = null;

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const perpendicular = axis === 'x' ? Math.abs(a.x - b.x) < EPS : Math.abs(a.y - b.y) < EPS;
    if (!perpendicular) continue;

    const ref = axis === 'x' ? a.x : a.y;
    const segLo = axis === 'x' ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
    const segHi = axis === 'x' ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
    // The edge must lie in front of the contour, not beside the gap.
    if (segHi <= otherLo + EPS || segLo >= otherHi - EPS) continue;

    let side: 'before' | 'after';
    let gap: number;
    if (ref <= extLo + EPS) {
      side = 'after';
      gap = extLo - ref;
    } else if (ref >= extHi - EPS) {
      side = 'before';
      gap = ref - extHi;
    } else {
      continue;
    }
    if (!best || gap < best.gap) best = { gap: Math.max(0, gap), ref, side };
  }
  if (best) return best;

  // Diagonal placement: use the nearest parallel side of the reference box.
  const [refLo, refHi] = axis === 'x' ? [refBox.x0, refBox.x1] : [refBox.y0, refBox.y1];
  if (extHi <= refLo + EPS) return { gap: refLo - extHi, ref: refLo, side: 'before' };
  if (extLo >= refHi - EPS) return { gap: extLo - refHi, ref: refHi, side: 'after' };
  return null;
}

export function slabPlacements(slab: SlabState): SlabPlacement[] {
  const d = deriveSlab(slab);
  if (!d || d.parts.length < 2) return [];

  const polys = d.parts.map((p) => p.poly);
  const boxes = polys.map(boundsOf);
  const covers = coveringSets(polys);
  const areas = d.parts.map((p) => p.metrics.areaMm2);

  // The reference frame is the biggest contour that nothing encloses.
  let anchor = 0;
  for (let i = 1; i < d.parts.length; i++) {
    const better = covers[anchor].length > 0 || areas[i] > areas[anchor];
    if (covers[i].length === 0 && better) anchor = i;
  }

  return d.parts.map((part, i) => {
    let ref: number | null = null;
    if (i !== anchor) {
      ref = covers[i].length
        ? covers[i]
            .slice()
            .sort((a, b) => covers[b].length - covers[a].length || areas[a] - areas[b])[0]
        : anchor;
    }
    if (ref === null) {
      return {
        id: part.id,
        label: i + 1,
        role: part.role,
        refId: null,
        refLabel: null,
        mode: 'sides',
        gapAxis: null,
        dx: 0,
        dy: 0,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        gapX: 0,
        gapY: 0,
        gapXRef: 0,
        gapYRef: 0,
        gapXSide: null,
        gapYSide: null,
      };
    }
    const box = boxes[i];
    const refBox = boxes[ref];
    const external = covers[i].length === 0;
    const gapX = external ? facingGap(polys[ref], box, refBox, 'x') : null;
    const gapY = external ? facingGap(polys[ref], box, refBox, 'y') : null;
    // Two gaps for a diagonal contour, otherwise a gap plus the two parallel
    // edge-plane distances along the overlapping axis.
    const gapAxis: SlabPlacement['gapAxis'] = !external
      ? null
      : gapX && gapY
        ? 'both'
        : gapX
          ? 'x'
          : gapY
            ? 'y'
            : 'both';

    return {
      id: part.id,
      label: i + 1,
      role: part.role,
      refId: d.parts[ref].id,
      refLabel: ref + 1,
      mode: external ? 'gaps' : 'sides',
      gapAxis,
      dx: box.x0 - refBox.x0,
      dy: box.y0 - refBox.y0,
      // External distances are always positive; nested offsets keep their sign so
      // a void can still be described from any side.
      left: external ? Math.abs(box.x0 - refBox.x0) : box.x0 - refBox.x0,
      right: external ? Math.abs(refBox.x1 - box.x1) : refBox.x1 - box.x1,
      top: external ? Math.abs(box.y0 - refBox.y0) : box.y0 - refBox.y0,
      bottom: external ? Math.abs(refBox.y1 - box.y1) : refBox.y1 - box.y1,
      gapX: gapX?.gap ?? 0,
      gapY: gapY?.gap ?? 0,
      gapXRef: gapX?.ref ?? refBox.x0,
      gapYRef: gapY?.ref ?? refBox.y0,
      gapXSide: gapX?.side ?? null,
      gapYSide: gapY?.side ?? null,
    };
  });
}

const PLACE_OVERLAP =
  'Контур налез на соседний. Уменьшите отступ или сдвиньте по другой оси.';
const PLACE_NESTING =
  'Так контуры наложатся друг на друга: выемка должна остаться внутри своего контура, ' +
  'а внешний контур — снаружи.';
const PLACE_NO_SCALE =
  'Сначала введите длину любой стороны — без неё отступы нельзя задать в миллиметрах.';

/**
 * One offset edit: a side of the reference box (nested contours), a gap to the
 * nearest face of the main contour (external contours), or a legacy dx/dy pair.
 */
export type SlabOffsetChange = {
  dx?: number;
  dy?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  gapX?: number;
  gapY?: number;
};

/**
 * Moves one contour so its bounding box sits at the requested offset from its
 * reference contour. Only the position changes: lengths, pins and thicknesses are
 * kept, so every angle stays 90°. Any of the four sides can be typed; the opposite
 * side is derived automatically because the contour keeps its size. Moves that
 * would cross a neighbour or move a void out of its slab are refused instead of
 * silently breaking the drawing.
 */
export function setSlabContourOffset(
  slab: SlabState,
  contourId: string,
  next: SlabOffsetChange,
): LengthResult {
  if (!slab.entered) return { ok: false, reason: PLACE_NO_SCALE };
  const derived = deriveSlab(slab);
  if (!derived) return { ok: false, reason: NO_CONTOUR };

  const row = slabPlacements(slab).find((p) => p.id === contourId);
  if (!row) return { ok: false, reason: NO_CONTOUR };
  if (!row.refId) {
    return { ok: false, reason: 'Это основной контур — от него отсчитываются отступы остальных.' };
  }

  const parts = derived.parts;
  const idx = parts.findIndex((p) => p.id === contourId);
  const refIdx = parts.findIndex((p) => p.id === row.refId);
  if (idx < 0 || refIdx < 0) return { ok: false, reason: NO_CONTOUR };

  const refBox = boundsOf(parts[refIdx].poly);
  const box = boundsOf(parts[idx].poly);
  const clampOffset = (v: number) => Math.min(SLAB_MAX_LEN, Math.max(-SLAB_MAX_LEN, v));
  const clampGap = (v: number) => Math.min(SLAB_MAX_LEN, Math.max(0, v));
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const external = row.mode === 'gaps';

  // The contour keeps its width/height, so setting one side automatically moves
  // the opposite side to refSize - ownSize - offset.
  let x0 = box.x0;
  if (next.gapX != null) {
    const gap = clampGap(next.gapX);
    if (row.gapXSide === 'before') x0 = row.gapXRef - gap - width;
    else if (row.gapXSide === 'after') x0 = row.gapXRef + gap;
  } else if (next.left != null) {
    if (external) {
      // Distance between the left edge planes; keep the side already chosen.
      const d = clampGap(next.left);
      x0 = box.x0 >= refBox.x0 ? refBox.x0 + d : refBox.x0 - d;
    } else {
      x0 = refBox.x0 + clampOffset(next.left);
    }
  } else if (next.right != null) {
    if (external) {
      const d = clampGap(next.right);
      x0 = box.x1 <= refBox.x1 ? refBox.x1 - d - width : refBox.x1 + d - width;
    } else {
      x0 = refBox.x1 - width - clampOffset(next.right);
    }
  } else if (next.dx != null || !external) {
    x0 = refBox.x0 + clampOffset(next.dx ?? row.dx);
  }

  let y0 = box.y0;
  if (next.gapY != null) {
    const gap = clampGap(next.gapY);
    if (row.gapYSide === 'before') y0 = row.gapYRef - gap - height;
    else if (row.gapYSide === 'after') y0 = row.gapYRef + gap;
  } else if (next.top != null) {
    if (external) {
      // Distance between the top edge planes; keep the side already chosen.
      const d = clampGap(next.top);
      y0 = box.y0 >= refBox.y0 ? refBox.y0 + d : refBox.y0 - d;
    } else {
      y0 = refBox.y0 + clampOffset(next.top);
    }
  } else if (next.bottom != null) {
    if (external) {
      const d = clampGap(next.bottom);
      y0 = box.y1 <= refBox.y1 ? refBox.y1 - d - height : refBox.y1 + d - height;
    } else {
      y0 = refBox.y1 - height - clampOffset(next.bottom);
    }
  } else if (next.dy != null || !external) {
    y0 = refBox.y0 + clampOffset(next.dy ?? row.dy);
  }

  const delta = { x: x0 - box.x0, y: y0 - box.y0 };

  if (Math.abs(delta.x) < 1e-9 && Math.abs(delta.y) < 1e-9) return { ok: true, slab };

  const moved = parts[idx].poly.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
  if (!isSimplePolygon(moved) || polygonArea(moved) < 1) {
    return { ok: false, reason: PLACE_OVERLAP };
  }

  for (let i = 0; i < parts.length; i++) {
    if (i === idx) continue;
    // Touching is fine (zero offset); only a real crossing means overlap.
    if (contoursProperlyCross(moved, parts[i].poly)) return { ok: false, reason: PLACE_OVERLAP };
  }

  // Nesting must survive: a void stays inside its slab, an outside contour stays out.
  const before = coveringSets(parts.map((p) => p.poly));
  const after = coveringSets(parts.map((p, i) => (i === idx ? moved : p.poly)));
  for (let i = 0; i < parts.length; i++) {
    if (before[i].join(',') !== after[i].join(',')) return { ok: false, reason: PLACE_NESTING };
  }

  return {
    ok: true,
    slab: {
      ...slab,
      contours: slab.contours.map((c) =>
        c.id !== contourId || !c.base
          ? c
          : {
              ...c,
              // Without real lengths the polygon is the base itself, so it has to move too.
              base: hasLens(c)
                ? c.base
                : c.base.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })),
              pivot: { x: c.pivot.x + delta.x, y: c.pivot.y + delta.y },
            },
      ),
    },
  };
}

/**
 * Snaps the drawn contour to 90°, makes sure it does not cut through any other
 * contour and stores it. Touching along an edge is allowed (a zero offset), just
 * like when moving a finished contour. Whether it adds volume or becomes a void
 * is decided later, from the nesting; the user only has to draw outside or inside.
 */
/**
 * Three tapped corners are enough for a rectangle: the fourth corner follows
 * from the two edges that meet at the middle point. The UI keeps new points on
 * alternating axes, so the missing corner is simply the rest of their bounding
 * box. Returns null when the three points are collinear (no right angle).
 */
function completeOrthogonalQuad(points: Pt[]): Pt[] | null {
  if (points.length !== 3) return points;
  const [a, b, c] = points;
  const firstH = Math.abs(b.y - a.y) <= Math.abs(b.x - a.x);
  const lastH = Math.abs(c.y - b.y) <= Math.abs(c.x - b.x);
  if (firstH === lastH) return null;
  const d = firstH ? { x: a.x, y: c.y } : { x: c.x, y: a.y };
  return [a, b, c, d];
}

export function closeSlabContour(slab: SlabState, minDist: number): LengthResult {
  const draft = slab.contours.find((c) => !c.base);
  if (!draft) return { ok: false, reason: 'Нет контура для замыкания.' };
  if (draft.raw.length < 3) {
    return { ok: false, reason: 'Нужно минимум 3 точки, чтобы замкнуть контур.' };
  }
  const completed = completeOrthogonalQuad(draft.raw);
  if (!completed) return { ok: false, reason: failText.impossible };
  const fitted = fitOrthogonalPolygon(completed, minDist);
  if (!fitted.ok) return { ok: false, reason: failText[fitted.reason] };

  const others = slab.contours
    .filter((c) => c.id !== draft.id && c.base)
    .map((c) => contourPoly(c))
    .filter((poly): poly is Pt[] => !!poly);
  if (others.some((other) => contoursProperlyCross(fitted.poly, other))) {
    return { ok: false, reason: CONTOUR_CROSS_TEXT };
  }

  const contour: SlabContour = {
    ...draft,
    base: fitted.poly,
    pivot: polyCentroid(fitted.poly),
    lens: slab.entered ? lensFromBase(fitted.poly) : null,
    pinned: slab.entered ? [] : null,
    vThickness: fitted.poly.map(() => null),
    entered: slab.entered,
  };
  return {
    ok: true,
    slab: { ...slab, contours: slab.contours.map((c) => (c.id === draft.id ? contour : c)) },
  };
}

export type StripDerived = {
  nodes: NetNode[];
  segs: NetSeg[];
  built: BuiltStrip;
  byId: Map<string, SegmentGeometry>;
  totalCenter: number;
  totalOuter: number;
  totalInner: number;
  /** Footprint of the tooth band along the outer contour, mm². */
  toothAreaMm2: number;
  /** Additive concrete volume of the tooth, mm³. */
  toothVolumeMm3: number;
};

export const STRIP_MIN_LEN = 50;
export const STRIP_MAX_LEN = 200000;

/** Axis and travel direction of every segment, taken once from the snapped sketch. */
export type StripAxisEdge = {
  id: string;
  a: string;
  b: string;
  axis: 'H' | 'V';
  sign: 1 | -1;
};

export function stripAxisEdges(base: NetNode[], segs: NetSeg[]): Map<string, StripAxisEdge> {
  const byId = new Map(base.map((n) => [n.id, n]));
  const out = new Map<string, StripAxisEdge>();
  for (const s of segs) {
    const a = byId.get(s.a);
    const b = byId.get(s.b);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const axis: 'H' | 'V' = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';
    const d = axis === 'H' ? dx : dy;
    out.set(s.id, { id: s.id, a: s.a, b: s.b, axis, sign: d >= 0 ? 1 : -1 });
  }
  return out;
}

/** Centreline lengths in mm for every segment, whatever the save came from. */
export function stripLens(strip: StripState): Record<string, number> {
  if (strip.lens) return { ...strip.lens };
  const out: Record<string, number> = {};
  const base = strip.baseNodes;
  if (!base) return out;
  const byId = new Map(base.map((n) => [n.id, n]));
  for (const e of stripAxisEdges(base, strip.segs).values()) {
    const a = byId.get(e.a)!;
    const b = byId.get(e.b)!;
    const raw = e.axis === 'H' ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
    out[e.id] = raw * (e.axis === 'H' ? strip.sx : strip.sy);
  }
  return out;
}

/** Segments the user typed; old saves only knew a single reference segment. */
export function stripPins(strip: StripState): Set<string> {
  if (strip.pinned) return new Set(strip.pinned);
  return new Set(strip.refSeg ? [strip.refSeg] : []);
}

/** Face runs held by hand; the key embeds the supporting segment ids. */
export function stripSidePins(strip: StripState): Set<string> {
  return new Set(strip.sidePins ?? []);
}

/**
 * Every segment whose length must not change on its own: individually pinned
 * ones and all pieces of a pinned face run. The key carries the ids, so this
 * works without rebuilding the geometry.
 */
export function lockedStripSegments(strip: StripState): Set<string> {
  const locked = stripPins(strip);
  for (const key of strip.sidePins ?? []) {
    const ids = key.split('|')[0];
    if (!ids) continue;
    for (const id of ids.split('+')) if (id) locked.add(id);
  }
  return locked;
}

/** Connected component index of every base node, isolated vertices included. */
function stripComponents(base: NetNode[], segs: NetSeg[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const n of base) adj.set(n.id, []);
  for (const s of segs) {
    if (!adj.has(s.a) || !adj.has(s.b) || s.a === s.b) continue;
    adj.get(s.a)!.push(s.b);
    adj.get(s.b)!.push(s.a);
  }
  const out = new Map<string, number>();
  let comp = 0;
  for (const n of base) {
    if (out.has(n.id)) continue;
    out.set(n.id, comp);
    const queue = [n.id];
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of adj.get(u) ?? []) {
        if (out.has(v)) continue;
        out.set(v, comp);
        queue.push(v);
      }
    }
    comp++;
  }
  return out;
}

/** Position of a face line: its Y for a horizontal run, its X for a vertical one. */
function faceCoord(run: FaceRun): number {
  return run.axis === 'H' ? (run.a.y + run.b.y) / 2 : (run.a.x + run.b.x) / 2;
}

export type StripAnchored = { baseNodes: NetNode[]; nodes: NetNode[] };

/**
 * Keeps hand-pinned faces where they are after the lengths changed.
 *
 * `stripNodesFromLens` re-centres every component on the sketch centroid, which
 * moves both walls of a ring symmetrically. A pinned face is a promise about
 * *position*, not only about its own length, so the new shape is shifted back
 * per component:
 *
 * - one pinned face on an axis — its line stays exactly where it was, and the
 *   free wall of the same axis takes the whole change;
 * - two pinned faces on the same axis — their requests cancel out, the average
 *   shift wins, so both walls move evenly (no conflict);
 * - no pinned face — the usual symmetric re-centring.
 *
 * The shift is baked into `baseNodes`, because that is the only free positional
 * state of a dimensioned strip; the lens themselves stay untouched.
 */
export function anchorStripNodes(
  strip: StripState,
  oldLens: Record<string, number>,
  newLens: Record<string, number>,
  keys: Iterable<string>,
): StripAnchored | null {
  const base = strip.baseNodes;
  if (!base) return null;
  const oldNodes = stripNodesFromLens(base, strip.segs, oldLens);
  const newNodes = stripNodesFromLens(base, strip.segs, newLens);
  if (!oldNodes || !newNodes) return null;

  const eff = strip.segs.filter(
    (s) =>
      base.some((n) => n.id === s.a) &&
      base.some((n) => n.id === s.b) &&
      s.a !== s.b,
  );
  const width = (seg: NetSeg) => widthOfSeg(strip, seg);
  const depth = (seg: NetSeg) => depthOfSeg(strip, seg);
  const oldRuns = new Map(faceRuns(buildStrip(oldNodes, eff, width, depth)).map((r) => [r.key, r]));
  const newRuns = new Map(faceRuns(buildStrip(newNodes, eff, width, depth)).map((r) => [r.key, r]));
  const comps = stripComponents(base, strip.segs);
  const nodeOfSeg = new Map<string, string>();
  for (const s of strip.segs) nodeOfSeg.set(s.id, s.a);

  const demand = new Map<number, { x: number; y: number; nx: number; ny: number }>();
  for (const key of keys) {
    const before = oldRuns.get(key);
    const after = newRuns.get(key);
    if (!before || !after || before.axis !== after.axis) continue;
    const nodeId = nodeOfSeg.get(before.ids[0] ?? '');
    const comp = nodeId ? comps.get(nodeId) : undefined;
    if (comp === undefined) continue;
    const acc = demand.get(comp) ?? { x: 0, y: 0, nx: 0, ny: 0 };
    const delta = faceCoord(before) - faceCoord(after);
    if (before.axis === 'H') {
      acc.y += delta;
      acc.ny++;
    } else {
      acc.x += delta;
      acc.nx++;
    }
    demand.set(comp, acc);
  }

  const shift = new Map<number, { x: number; y: number }>();
  for (const [comp, acc] of demand) {
    shift.set(comp, {
      x: acc.nx ? acc.x / acc.nx : 0,
      y: acc.ny ? acc.y / acc.ny : 0,
    });
  }

  const baseNodes = base.map((n) => {
    const s = shift.get(comps.get(n.id) ?? -1);
    return s ? { id: n.id, x: n.x + s.x, y: n.y + s.y } : { id: n.id, x: n.x, y: n.y };
  });
  const nodes = stripNodesFromLens(baseNodes, strip.segs, newLens) ?? newNodes;
  return { baseNodes, nodes };
}

const NODE_TOL = 0.5;

/**
 * Turns centreline lengths back into node coordinates.
 *
 * Every segment is either a length constraint on its axis or an equality of the
 * perpendicular coordinate at a joint, so one BFS per component assigns every
 * node. A cycle that does not close means the lengths disagree — null.
 */
export function stripNodesFromLens(
  base: NetNode[],
  segs: NetSeg[],
  lens: Record<string, number>,
): NetNode[] | null {
  const edges = stripAxisEdges(base, segs);
  const index = new Map(base.map((n, i) => [n.id, i]));
  const adj = base.map(() => [] as { to: number; dx: number; dy: number }[]);

  for (const e of edges.values()) {
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || i === j) continue;
    const fallback = e.axis === 'H' ? Math.abs(base[j].x - base[i].x) : Math.abs(base[j].y - base[i].y);
    const len = lens[e.id] ?? fallback;
    const dx = e.axis === 'H' ? e.sign * len : 0;
    const dy = e.axis === 'V' ? e.sign * len : 0;
    adj[i].push({ to: j, dx, dy });
    adj[j].push({ to: i, dx: -dx, dy: -dy });
  }

  const xs: (number | null)[] = base.map(() => null);
  const ys: (number | null)[] = base.map(() => null);
  const comps: number[][] = [];
  for (let s = 0; s < base.length; s++) {
    if (xs[s] !== null) continue;
    xs[s] = 0;
    ys[s] = 0;
    const members = [s];
    const queue = [s];
    while (queue.length) {
      const i = queue.shift()!;
      for (const { to, dx, dy } of adj[i]) {
        const px = xs[i]! + dx;
        const py = ys[i]! + dy;
        if (xs[to] === null) {
          xs[to] = px;
          ys[to] = py;
          members.push(to);
          queue.push(to);
        } else if (Math.abs(xs[to]! - px) > NODE_TOL || Math.abs(ys[to]! - py) > NODE_TOL) {
          return null;
        }
      }
    }
    comps.push(members);
  }

  // Recentre every connected component on its own sketch centroid. A strip can
  // gain a detached line after its dimensions are entered; using one global
  // offset would drag the new component onto an existing edge and make it overlap.
  const out: NetNode[] = base.map((n) => ({ id: n.id, x: n.x, y: n.y }));
  for (const members of comps) {
    const mx = members.reduce((s, i) => s + xs[i]!, 0) / members.length;
    const my = members.reduce((s, i) => s + ys[i]!, 0) / members.length;
    const bx = members.reduce((s, i) => s + base[i].x, 0) / members.length;
    const by = members.reduce((s, i) => s + base[i].y, 0) / members.length;
    const ox = bx - mx;
    const oy = by - my;
    for (const i of members) {
      out[i] = { id: base[i].id, x: xs[i]! + ox, y: ys[i]! + oy };
    }
  }
  return out;
}

type CycleStep = { id: string; from: string; to: string };

function treePath(
  tree: Map<string, { edge: string; to: string }[]>,
  from: string,
  to: string,
): CycleStep[] | null {
  const prev = new Map<string, { from: string; edge: string }>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const u = queue.shift()!;
    if (u === to) break;
    for (const e of tree.get(u) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: u, edge: e.edge });
      queue.push(e.to);
    }
  }
  if (!seen.has(to)) return null;
  const steps: CycleStep[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur)!;
    steps.push({ id: p.edge, from: p.from, to: cur });
    cur = p.from;
  }
  return steps.reverse();
}

/** One fundamental (independent) cycle per closing segment. */
function findCycles(segs: NetSeg[], ids: Set<string>): CycleStep[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== undefined && c !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const tree = new Map<string, { edge: string; to: string }[]>();
  const addTree = (a: string, b: string, edge: string) => {
    if (!tree.has(a)) tree.set(a, []);
    if (!tree.has(b)) tree.set(b, []);
    tree.get(a)!.push({ edge, to: b });
    tree.get(b)!.push({ edge, to: a });
  };

  const cycles: CycleStep[][] = [];
  for (const s of segs) {
    if (!ids.has(s.a) || !ids.has(s.b) || s.a === s.b) continue;
    const ra = find(s.a);
    const rb = find(s.b);
    if (ra !== rb) {
      parent.set(rb, ra);
      addTree(s.a, s.b, s.id);
      continue;
    }
    const path = treePath(tree, s.a, s.b);
    if (!path) continue;
    cycles.push([...path, { id: s.id, from: s.b, to: s.a }]);
  }
  return cycles;
}

function cycleResidual(
  cycle: CycleStep[],
  lens: Record<string, number>,
  edges: Map<string, StripAxisEdge>,
  axis: 'H' | 'V',
): number {
  let r = 0;
  for (const st of cycle) {
    const e = edges.get(st.id);
    if (!e || e.axis !== axis) continue;
    const forward = e.a === st.from && e.b === st.to;
    r += (forward ? 1 : -1) * e.sign * (lens[st.id] ?? 0);
  }
  return r;
}

const CONFLICT_REASON =
  'Так длины не сходятся: свободной параллельной стороны не осталось, а закреплённые длины не меняются. ' +
  'Открепите одну из параллельных зелёных сторон долгим нажатием на число и повторите ввод.';

const RANGE_REASON =
  `Свободный участок вышел бы за пределы ${STRIP_MIN_LEN} мм … 200 м. ` +
  'Открепите другой размер или введите меньшее значение.';

type StripSolve = { ok: true; lens: Record<string, number> } | { ok: false; reason: string };

/**
 * Restores consistency of the network after one length changed.
 *
 * Every cycle of the centreline graph requires its signed lengths to sum to zero
 * per axis. Pinned lengths are never touched, so the difference is handed to a
 * free segment of the same axis inside that cycle — preferably the one lying
 * across from the edited segment, which is what a person expects to slide.
 */
type StripRow = {
  cycle: CycleStep[];
  axis: 'H' | 'V';
  /**
   * Edges of the cycle on this axis; `a` is the signed coefficient of length
   * and `p` is the preference: a higher value lets this edge move more.
   */
  edges: { id: string; a: 1 | -1; p: number }[];
};

function solveStripLens(
  base: NetNode[],
  segs: NetSeg[],
  lens: Record<string, number>,
  pinned: Set<string>,
  edited: string,
): StripSolve {
  const edges = stripAxisEdges(base, segs);
  const ids = new Set(base.map((n) => n.id));
  const cycles = findCycles(segs, ids);
  const work = { ...lens };
  const editedEdge = edges.get(edited);

  // Every cycle-axis pair is one constraint: the signed lengths must sum to zero.
  const rows: StripRow[] = [];
  for (const cycle of cycles) {
    for (const axis of ['H', 'V'] as const) {
      const list: StripRow['edges'] = [];
      const seen = new Set<string>();
      for (const st of cycle) {
        const e = edges.get(st.id);
        if (!e || e.axis !== axis || seen.has(e.id)) continue;
        seen.add(e.id);
        const forward = e.a === st.from && e.b === st.to;
        // The opposite side is what a person expects to slide; it gets a much
        // larger share of the change, the rest is spread over other parallels.
        const p = editedEdge && e.sign !== editedEdge.sign ? 8 : 1;
        list.push({ id: e.id, a: ((forward ? 1 : -1) * e.sign) as 1 | -1, p });
      }
      if (list.length) rows.push({ cycle, axis, edges: list });
    }
  }

  const rowByEdge = new Map<string, number[]>();
  rows.forEach((row, i) => {
    for (const e of row.edges) {
      const list = rowByEdge.get(e.id);
      if (list) list.push(i);
      else rowByEdge.set(e.id, [i]);
    }
  });

  // Only constraints touched by the edit take part, then everything reached
  // through the edges we move. An unrelated stale ring cannot block the change.
  const active = new Set<number>();
  rows.forEach((row, i) => {
    if (row.edges.some((e) => e.id === edited)) active.add(i);
  });

  if (!active.size) {
    // The edited segment is not part of a cycle: no constraint, the free end
    // simply moves.
    const tree = stripNodesFromLens(base, segs, work);
    if (!tree) return { ok: false, reason: CONFLICT_REASON };
    return { ok: true, lens: work };
  }

  type Var = { id: string; a: 1 | -1; p: number; zlo: number; zhi: number };

  const makeVars = (row: StripRow, take: (id: string) => boolean): Var[] => {
    const vars: Var[] = [];
    for (const e of row.edges) {
      if (!take(e.id)) continue;
      const len = work[e.id] ?? 0;
      const dlo = STRIP_MIN_LEN - len;
      const dhi = STRIP_MAX_LEN - len;
      // `z` is the contribution a * delta adds to the cycle sum.
      const zlo = e.a > 0 ? dlo : -dhi;
      const zhi = e.a > 0 ? dhi : -dlo;
      vars.push({ id: e.id, a: e.a, p: e.p, zlo, zhi });
    }
    return vars;
  };

  /**
   * Distributes exactly `need` over the variables, proportionally to `p` and
   * inside their allowed ranges. Returns the amount actually placed.
   */
  const fill = (vars: Var[], need: number): number => {
    if (!vars.length) return 0;
    let low = 0;
    let high = 0;
    for (const v of vars) {
      low += v.zlo;
      high += v.zhi;
    }
    const target = Math.min(high, Math.max(low, need));
    if (Math.abs(target) < 1e-9) return 0;

    // Water-filling: z_i = clamp(lambda * p_i, zlo, zhi); find lambda so that
    // the contributions sum to the missing amount.
    let lamLo = Infinity;
    let lamHi = -Infinity;
    for (const v of vars) {
      lamLo = Math.min(lamLo, v.zlo / v.p);
      lamHi = Math.max(lamHi, v.zhi / v.p);
    }
    lamLo -= 1;
    lamHi += 1;
    const sumAt = (lam: number): number => {
      let sum = 0;
      for (const v of vars) sum += Math.min(Math.max(lam * v.p, v.zlo), v.zhi);
      return sum;
    };
    for (let it = 0; it < 70; it++) {
      const mid = (lamLo + lamHi) / 2;
      if (sumAt(mid) < target) lamLo = mid;
      else lamHi = mid;
    }
    const lam = (lamLo + lamHi) / 2;
    let placed = 0;
    for (const v of vars) {
      const z = Math.min(Math.max(lam * v.p, v.zlo), v.zhi);
      const len = work[v.id] ?? 0;
      work[v.id] = Math.min(STRIP_MAX_LEN, Math.max(STRIP_MIN_LEN, len + v.a * z));
      placed += z;
    }
    return placed;
  };

  /**
   * Projects one cycle onto the closest state that closes it. Every hand-typed
   * number — a segment pin or a green face — is a hard constraint, so only the
   * genuinely free segments move. If they cannot absorb the difference the
   * caller reports a conflict and asks the user to release a parallel side.
   */
  const projectRow = (row: StripRow): boolean => {
    const residual = cycleResidual(row.cycle, work, edges, row.axis);
    if (Math.abs(residual) < 1e-9) return true;
    const vars = makeVars(row, (id) => !pinned.has(id));
    if (!vars.length) return false;
    const left = -residual - fill(vars, -residual);
    return Math.abs(left) < 0.5;
  };

  // Cyclic projections over the affected cycles. Moving an edge also pulls in
  // every other cycle that shares it, so the whole branched scene is solved
  // instead of just the first ring around the edited segment.
  for (let pass = 0; pass < 1500; pass++) {
    let changed = false;
    for (let i = 0; i < rows.length; i++) {
      if (!active.has(i)) continue;
      const row = rows[i];
      if (Math.abs(cycleResidual(row.cycle, work, edges, row.axis)) < 1e-7) continue;
      const before = row.edges.map((e) => work[e.id]);
      if (!projectRow(row)) continue;
      row.edges.forEach((e, k) => {
        if (work[e.id] === before[k]) return;
        changed = true;
        for (const j of rowByEdge.get(e.id) ?? []) active.add(j);
      });
    }
    let worst = 0;
    for (const i of active) {
      const row = rows[i];
      worst = Math.max(worst, Math.abs(cycleResidual(row.cycle, work, edges, row.axis)));
    }
    if (worst < 1e-6) break;
    if (!changed && worst > 0.5) break;
  }

  let blocked: StripRow | null = null;
  for (const i of active) {
    const row = rows[i];
    if (Math.abs(cycleResidual(row.cycle, work, edges, row.axis)) > 0.5) {
      blocked = row;
      break;
    }
  }
  if (blocked) {
    const hasFree = blocked.edges.some((e) => !pinned.has(e.id));
    return { ok: false, reason: hasFree ? RANGE_REASON : CONFLICT_REASON };
  }

  const nodes = stripNodesFromLens(base, segs, work);
  if (!nodes) return { ok: false, reason: CONFLICT_REASON };
  const topology = validateTopology(nodes, segs);
  if (topology) return { ok: false, reason: netFailText[topology] };

  return { ok: true, lens: work };
}

export type StripLengthResult =
  | { ok: true; strip: StripState }
  | { ok: false; reason: string };

/**
 * Sets one centreline length and pins it. The first number typed fixes the whole
 * sketch to millimetres (units → mm); after that every typed number is kept and
 * only the free segments of the same axis move.
 */
export function setStripSegLength(
  strip: StripState,
  segId: string,
  mm: number,
): StripLengthResult {
  if (!strip.baseNodes) return { ok: false, reason: 'Сначала проведите ось ленты.' };
  const lens = stripLens(strip);
  if (!(segId in lens)) return { ok: false, reason: 'Этот участок ещё не нарисован.' };
  const value = Math.min(STRIP_MAX_LEN, Math.max(STRIP_MIN_LEN, mm));

  if (!strip.entered) {
    const base0 = Math.max(lens[segId], 1e-6);
    const k = value / base0;
    const scaled: Record<string, number> = {};
    for (const [id, v] of Object.entries(lens)) scaled[id] = v * k;
    return {
      ok: true,
      strip: { ...strip, lens: scaled, entered: true, pinned: [segId] },
    };
  }

  // Every number typed by the user stays put: both the segment pin and every
  // hand-held face are hard length constraints.
  const pinned = lockedStripSegments(strip);
  pinned.add(segId);
  const solved = solveStripLens(strip.baseNodes, strip.segs, { ...lens, [segId]: value }, pinned, segId);
  if (!solved.ok) return solved;
  const anchored = anchorStripNodes(strip, lens, solved.lens, strip.sidePins ?? []);
  return {
    ok: true,
    strip: {
      ...strip,
      lens: solved.lens,
      entered: true,
      pinned: [...stripPins(strip), segId],
      ...(anchored ? { baseNodes: anchored.baseNodes, nodes: anchored.nodes } : {}),
    },
  };
}

/** Proportional growth of the run, clamped to the allowed length range. */
function distributeDelta(lens: Record<string, number>, ids: string[], delta: number): number {
  let remaining = delta;
  let pool = ids.slice();
  for (let pass = 0; pass < ids.length + 3 && Math.abs(remaining) > 0.05 && pool.length; pass++) {
    const total = pool.reduce((s, id) => s + (lens[id] ?? 0), 0);
    const next: string[] = [];
    let used = 0;
    for (const id of pool) {
      const current = lens[id] ?? STRIP_MIN_LEN;
      const share = total > 1e-6 ? (current / total) * remaining : remaining / pool.length;
      const want = current + share;
      const got = Math.min(STRIP_MAX_LEN, Math.max(STRIP_MIN_LEN, want));
      used += got - current;
      if (Math.abs(got - want) > 1e-6) next.push(id);
      lens[id] = got;
    }
    remaining -= used;
    pool = next.filter((id) =>
      remaining > 0 ? (lens[id] ?? 0) < STRIP_MAX_LEN - 1e-6 : (lens[id] ?? 0) > STRIP_MIN_LEN + 1e-6,
    );
  }
  return remaining;
}

/**
 * Sets the length of one visible face of the band.
 *
 * A face may run past several collinear segments (a straight wall cut by
 * partitions), so the typed number spreads over the whole run. The face is a
 * constant offset away from the centreline, which is why the target for the
 * centreline sum is the value minus that constant. Everything that is neither
 * pinned nor part of this run then adapts through the usual ring solver.
 */
export function setStripRunLength(
  strip: StripState,
  run: Pick<FaceRun, 'key' | 'ids' | 'len'>,
  mm: number,
): StripLengthResult {
  if (!strip.baseNodes) return { ok: false, reason: 'Сначала проведите ось ленты.' };
  const lens = stripLens(strip);
  const ids = run.ids.filter((id) => id in lens);
  if (!ids.length) return { ok: false, reason: 'Этот участок ещё не нарисован.' };
  const value = Math.min(STRIP_MAX_LEN, Math.max(STRIP_MIN_LEN, mm));
  const sum = ids.reduce((s, id) => s + lens[id], 0);
  // The face is a fixed offset away from the centreline (a mitre or a wall end).
  const extra = run.len - sum;

  if (!strip.entered) {
    const k = Math.max(1e-6, (value - extra) / Math.max(sum, 1e-6));
    const scaled: Record<string, number> = {};
    for (const [id, v] of Object.entries(lens)) scaled[id] = v * k;
    return {
      ok: true,
      strip: { ...strip, lens: scaled, entered: true, sidePins: [run.key] },
    };
  }

  // Re-editing a fixed face is allowed: the run's own pieces are released for
  // this one change while every other pin stays put. The opposite green side
  // is a hard lock — if it leaves no free parallel segment, the edit is refused.
  const locked = lockedStripSegments(strip);
  for (const id of ids) locked.delete(id);
  const movable = ids.filter((id) => !locked.has(id));
  if (!movable.length) return { ok: false, reason: CONFLICT_REASON };
  const next = { ...lens };
  const leftover = distributeDelta(next, movable, value - run.len);
  if (Math.abs(leftover) > 0.5) return { ok: false, reason: RANGE_REASON };

  const solved = solveStripLens(
    strip.baseNodes,
    strip.segs,
    next,
    new Set([...locked, ...ids]),
    ids[0],
  );
  if (!solved.ok) return solved;
  const sidePins = stripSidePins(strip);
  sidePins.add(run.key);
  // The edited face itself now holds its position too; other green faces
  // follow their keys, so both walls of a ring stay where a person put them.
  const anchored = anchorStripNodes(strip, lens, solved.lens, sidePins);
  return {
    ok: true,
    strip: {
      ...strip,
      lens: solved.lens,
      entered: true,
      sidePins: [...sidePins],
      ...(anchored ? { baseNodes: anchored.baseNodes, nodes: anchored.nodes } : {}),
    },
  };
}

/** Long press fixes or releases one face of the band. */
export function toggleStripRunPin(strip: StripState, key: string): StripState {
  const sidePins = stripSidePins(strip);
  if (sidePins.has(key)) sidePins.delete(key);
  else sidePins.add(key);
  return { ...strip, sidePins: [...sidePins] };
}

/** Long press locks or releases a segment. Lengths never change, so it stays valid. */
export function toggleStripPin(strip: StripState, segId: string): StripState {
  const pinned = stripPins(strip);
  if (pinned.has(segId)) pinned.delete(segId);
  else pinned.add(segId);
  return { ...strip, pinned: [...pinned] };
}

export function scaledStripNodes(strip: StripState): NetNode[] {
  const base = strip.baseNodes;
  if (!base) return strip.nodes;
  return stripNodesFromLens(base, strip.segs, stripLens(strip)) ?? base;
}

export function widthOfSeg(strip: StripState, seg: NetSeg): number {
  return strip.widths[seg.id] ?? strip.baseWidth;
}

/**
 * Depth of one segment. New saves keep an override per segment; the endpoint
 * lookup keeps old saves (which stored depth per vertex) working until they are
 * migrated on the next load.
 */
export function depthOfSeg(strip: StripState, seg: NetSeg): number {
  const own = strip.depths[seg.id];
  if (own !== undefined) return own;
  const a = strip.depths[seg.a];
  const b = strip.depths[seg.b];
  if (a !== undefined || b !== undefined) return Math.max(a ?? 0, b ?? 0);
  return strip.baseDepth;
}

export function deriveStrip(strip: StripState): StripDerived | null {
  const src = strip.baseNodes;
  if (!src) return null;
  const nodes = scaledStripNodes(strip);
  const eff: NetSeg[] = strip.segs.filter(
    (s) => src.some((n) => n.id === s.a) && src.some((n) => n.id === s.b),
  );
  const built = buildStrip(
    nodes,
    eff,
    (seg) => widthOfSeg(strip, seg),
    (seg) => depthOfSeg(strip, seg),
  );
  const byId = new Map(built.segments.map((g) => [g.id, g]));
  let totalCenter = 0;
  let totalOuter = 0;
  let totalInner = 0;
  for (const g of built.segments) {
    totalCenter += g.centerLen;
    totalOuter += g.outerLen;
    totalInner += g.innerLen;
  }
  const toothAreaMm2 =
    strip.tooth && strip.toothWidth > 0
      ? toothBandAreaMm2(built.outline, strip.toothWidth)
      : 0;
  const toothVolumeMm3 = strip.tooth ? toothAreaMm2 * Math.max(0, strip.toothDepth) : 0;
  return {
    nodes,
    segs: eff,
    built,
    byId,
    totalCenter,
    totalOuter,
    totalInner,
    toothAreaMm2,
    toothVolumeMm3,
  };
}

export function stripBounds(strip: StripState): Rect | null {
  const nodes = scaledStripNodes(strip);
  if (!nodes.length) return null;
  return boundsOf(nodes);
}

export function projectVolume(p: { kind: 'slab' | 'strip'; slab?: SlabState; strip?: StripState }): {
  ready: boolean;
  mm3: number;
} {
  if (p.kind === 'slab' && p.slab) {
    const d = deriveSlab(p.slab);
    return { ready: !!d && p.slab.entered, mm3: d?.metrics.volumeMm3 ?? 0 };
  }
  if (p.kind === 'strip' && p.strip) {
    const d = deriveStrip(p.strip);
    return {
      ready: !!d && p.strip.entered,
      mm3: d ? d.built.volumeMm3 + d.toothVolumeMm3 : 0,
    };
  }
  return { ready: false, mm3: 0 };
}

export function slabBounds(slab: SlabState): Rect | null {
  const points: Pt[] = [];
  for (const c of slab.contours) {
    const poly = contourPoly(c);
    if (poly) points.push(...poly);
    else points.push(...c.raw);
  }
  if (!points.length) return null;
  return boundsOf(points);
}

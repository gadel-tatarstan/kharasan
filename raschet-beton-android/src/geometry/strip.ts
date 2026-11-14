import { type Pt, collinearOverlap, dist } from './vec';
import { unionAxisRects, type HeightRect } from './union';

export type NetNode = { id: string; x: number; y: number };
export type NetSeg = { id: string; a: string; b: string; w?: number | null };
export type Net = { nodes: NetNode[]; segs: NetSeg[] };

export type NetFailure = 'too-few' | 'conflict' | 'degenerate';

export const netFailText: Record<NetFailure, string> = {
  'too-few': 'Поставьте хотя бы две точки — ленте нужен хотя бы один отрезок.',
  conflict:
    'Из такого набора точек нельзя собрать прямоугольную схему: где-то получается треугольная петля. Уберите лишнюю точку или сделайте ответвление перпендикулярным.',
  degenerate:
    'Две точки слиплись в одну — отрезок нулевой длины. Разнесите точки или отмените последнюю.',
};

type DSU = {
  parent: number[];
  weight: number[];
  value: number[];
  has: boolean[];
};

function makeDsu(coords: number[], weights: number[]): DSU {
  return {
    parent: coords.map((_, i) => i),
    weight: weights.slice(),
    value: coords.slice(),
    has: coords.map(() => false),
  };
}

function find(d: DSU, i: number): number {
  let r = i;
  while (d.parent[r] !== r) r = d.parent[r];
  let c = i;
  while (d.parent[c] !== r) {
    const n = d.parent[c];
    d.parent[c] = r;
    c = n;
  }
  return r;
}

/** Returns false when the constraint closes a cycle (impossible in one axis). */
function union(d: DSU, a: number, b: number): boolean {
  const ra = find(d, a);
  const rb = find(d, b);
  d.has[ra] = true;
  if (ra === rb) return false;
  const w = d.weight[ra] + d.weight[rb];
  const v = (d.value[ra] * d.weight[ra] + d.value[rb] * d.weight[rb]) / (w || 1);
  d.parent[rb] = ra;
  d.weight[ra] = w;
  d.value[ra] = v;
  d.has[ra] = true;
  return true;
}

function dsuValue(d: DSU, i: number): { value: number; used: boolean } {
  const r = find(d, i);
  return { value: d.value[r], used: d.has[r] };
}

/**
 * Makes a tapped polyline network rectilinear.
 *
 * Every segment is classified horizontal/vertical, then nodes that must share
 * an X (vertical segments) or a Y (horizontal segments) are merged with a
 * weighted union-find. A cycle inside one axis means the sketch cannot be a
 * rectilinear network — the only truly impossible case, which we report.
 */
export function fitNetwork(net: Net): { ok: true; nodes: NetNode[] } | { ok: false; reason: NetFailure } {
  if (net.segs.length < 1 || net.nodes.length < 2) return { ok: false, reason: 'too-few' };
  // The same pair drawn twice is a genuine overlap now: the rectangle union
  // counts that area once, so the repeat only has to be ignored here. Other
  // overlaps (partial, folded back) do not add constraints at all.
  const seen = new Set<string>();
  const segs = net.segs.filter((s) => {
    const key = s.a < s.b ? `${s.a}|${s.b}` : `${s.b}|${s.a}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const index = new Map<string, number>();
  net.nodes.forEach((n, i) => index.set(n.id, i));

  const segIdx = segs.map((s) => {
    const ia = index.get(s.a);
    const ib = index.get(s.b);
    return ia === undefined || ib === undefined || ia === ib ? null : { ia, ib };
  });
  if (segIdx.some((s) => s === null)) return { ok: false, reason: 'degenerate' };

  const nodeWeight = net.nodes.map(() => 1);
  for (const s of segIdx) {
    if (!s) continue;
    const p = net.nodes[s.ia];
    const q = net.nodes[s.ib];
    const len = Math.max(dist(p, q), 1);
    nodeWeight[s.ia] += len;
    nodeWeight[s.ib] += len;
  }

  const xs = makeDsu(net.nodes.map((n) => n.x), nodeWeight);
  const ys = makeDsu(net.nodes.map((n) => n.y), nodeWeight);

  for (const s of segIdx) {
    if (!s) continue;
    const p = net.nodes[s.ia];
    const q = net.nodes[s.ib];
    const horizontal = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y);
    const target = horizontal ? ys : xs;
    if (!union(target, s.ia, s.ib)) {
      return { ok: false, reason: 'conflict' };
    }
  }

  const nodes: NetNode[] = net.nodes.map((n, i) => {
    const xv = dsuValue(xs, i);
    const yv = dsuValue(ys, i);
    return {
      id: n.id,
      x: xv.used ? xv.value : n.x,
      y: yv.used ? yv.value : n.y,
    };
  });

  // Re-check: every segment must now be axis aligned and non-zero.
  for (const s of segIdx) {
    if (!s) continue;
    const p = nodes[s.ia];
    const q = nodes[s.ib];
    const dx = Math.abs(q.x - p.x);
    const dy = Math.abs(q.y - p.y);
    if (dx < 1e-6 && dy < 1e-6) return { ok: false, reason: 'degenerate' };
    if (dx > 1e-6 && dy > 1e-6) return { ok: false, reason: 'conflict' };
  }

  const topology = validateTopology(nodes, segs);
  if (topology) return { ok: false, reason: topology };

  return { ok: true, nodes };
}

/**
 * Only missing nodes are a real topology failure. Overlapping centrelines are
 * allowed on purpose: the strip is drawn as a union of rectangles, so a doubled
 * or folded line covers the same area once and its volume is not counted twice.
 */
export function validateTopology(nodes: NetNode[], segs: NetSeg[]): NetFailure | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const s of segs) {
    if (!byId.get(s.a) || !byId.get(s.b)) return 'degenerate';
  }
  return null;
}

export type CollinearMerge = {
  nodes: NetNode[];
  segs: NetSeg[];
  /** Output segment id -> ids of the input segments it was built from. */
  origin: Record<string, string[]>;
  /** Input node id -> surviving node id at the same coordinates. */
  nodeMap: Record<string, string>;
};

/** Coordinates in this editor are millimetres, so a hundredth is exact enough. */
const MERGE_EPS = 0.05;
const mergeKey = (v: number) => Math.round(v / MERGE_EPS);
/** Lines must be truly collinear; only float noise may differ. */
const lineKey = (v: number) => Math.round(v * 1e6);

/**
 * Turns overlapping collinear segments into one shared centreline.
 *
 * Two strips drawn on top of each other would otherwise paint their dashed
 * axes twice. Here every collinear group is cut at all of its endpoints, so the
 * shared run becomes a single segment and its ends become ordinary vertices —
 * ready for a branch. Identical pieces are fused; the caller keeps the widest
 * source width and any pinned state through `origin` and `nodeMap`.
 */
export function mergeCollinearNet(nodes: NetNode[], segs: NetSeg[]): CollinearMerge {
  // 1. Coincident vertices are the same point; keep the first id.
  const nodeMap: Record<string, string> = {};
  const canon = new Map<string, NetNode>();
  for (const n of nodes) {
    const key = `${mergeKey(n.x)}:${mergeKey(n.y)}`;
    const hit = canon.get(key);
    if (hit) nodeMap[n.id] = hit.id;
    else {
      canon.set(key, n);
      nodeMap[n.id] = n.id;
    }
  }
  const fused = [...canon.values()];

  // 2. Fuse equal endpoints, then drop zero-length leftovers.
  const remapped: NetSeg[] = [];
  for (const s of segs) {
    const a = nodeMap[s.a] ?? s.a;
    const b = nodeMap[s.b] ?? s.b;
    if (a === b) continue;
    remapped.push({ ...s, a, b });
  }

  type Item = {
    seg: NetSeg;
    axis: 'H' | 'V';
    line: number;
    lo: string;
    hi: string;
    loV: number;
    hiV: number;
  };
  const fusedById = new Map(fused.map((n) => [n.id, n]));
  const groups = new Map<string, Item[]>();
  const straight: NetSeg[] = [];

  for (const s of remapped) {
    const a = fusedById.get(s.a);
    const b = fusedById.get(s.b);
    if (!a || !b) {
      straight.push(s);
      continue;
    }
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dx > 1e-6 && dy > 1e-6) {
      // Not axis aligned (legacy drawing): leave it alone.
      straight.push(s);
      continue;
    }
    const axis: 'H' | 'V' = dx >= dy ? 'H' : 'V';
    const line = axis === 'H' ? a.y : a.x;
    const aV = axis === 'H' ? a.x : a.y;
    const bV = axis === 'H' ? b.x : b.y;
    const lo = aV <= bV ? a : b;
    const hi = aV <= bV ? b : a;
    const item: Item = {
      seg: s,
      axis,
      line,
      lo: lo.id,
      hi: hi.id,
      loV: aV <= bV ? aV : bV,
      hiV: aV <= bV ? bV : aV,
    };
    const key = `${axis}:${lineKey(line)}`;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  const origin: Record<string, string[]> = {};
  const out: NetSeg[] = [...straight];
  for (const s of straight) origin[s.id] = [s.id];

  for (const items of groups.values()) {
    if (items.length < 2) {
      for (const it of items) {
        out.push(it.seg);
        origin[it.seg.id] = [it.seg.id];
      }
      continue;
    }

    // Every endpoint on this line is a potential cut.
    const marks = new Map<number, string>();
    for (const it of items) {
      if (!marks.has(mergeKey(it.loV))) marks.set(mergeKey(it.loV), it.lo);
      if (!marks.has(mergeKey(it.hiV))) marks.set(mergeKey(it.hiV), it.hi);
    }
    const sorted = [...marks.entries()].sort((x, y) => x[0] - y[0]);
    const isCut = (key: number, lo: number, hi: number) => key > lo && key < hi;

    for (const it of items) {
      const loKey = mergeKey(it.loV);
      const hiKey = mergeKey(it.hiV);
      const points = [it.lo];
      for (const [key, id] of sorted) {
        if (isCut(key, loKey, hiKey)) points.push(id);
      }
      points.push(it.hi);
      if (points.length === 2) {
        out.push(it.seg);
        origin[it.seg.id] = [it.seg.id];
        continue;
      }
      for (let i = 0; i < points.length - 1; i++) {
        const id = `${it.seg.id}~${i}`;
        out.push({ ...it.seg, id, a: points[i], b: points[i + 1] });
        origin[id] = [it.seg.id];
      }
    }
  }

  // 3. A shared run appears twice after splitting — keep one copy.
  const byPair = new Map<string, NetSeg>();
  const result: NetSeg[] = [];
  for (const s of out) {
    const key = s.a < s.b ? `${s.a}|${s.b}` : `${s.b}|${s.a}`;
    const kept = byPair.get(key);
    if (kept) {
      origin[kept.id].push(...(origin[s.id] ?? [s.id]));
      delete origin[s.id];
      continue;
    }
    byPair.set(key, s);
    result.push(s);
  }

  return { nodes: fused, segs: result, origin, nodeMap };
}

export type SegmentGeometry = {
  id: string;
  a: Pt;
  b: Pt;
  axis: 'H' | 'V';
  width: number;
  centerLen: number;
  side: [number, number];
  /** Longer side, when both differ (a bend). */
  outerLen: number;
  innerLen: number;
  outerSign: 1 | -1;
};

export type BuiltStrip = {
  nodes: { id: string; p: Pt; depth: number }[];
  segments: SegmentGeometry[];
  outline: Pt[][];
  areaMm2: number;
  volumeMm3: number;
};

type OffsetLine = { axis: 'h'; c: number } | { axis: 'v'; c: number };

const leftNormal = (u: Pt): Pt => ({ x: -u.y, y: u.x });

function offsetLine(p: Pt, u: Pt, sign: number, d: number): OffsetLine {
  const n = leftNormal(u);
  if (Math.abs(u.y) < Math.abs(u.x)) return { axis: 'h', c: p.y + sign * d * n.y };
  return { axis: 'v', c: p.x + sign * d * n.x };
}

function intersectLines(l1: OffsetLine, l2: OffsetLine): Pt {
  if (l1.axis === 'h' && l2.axis === 'v') return { x: l2.c, y: l1.c };
  if (l1.axis === 'v' && l2.axis === 'h') return { x: l1.c, y: l2.c };
  // parallel (collinear continuation) — take the first
  return l1.axis === 'h' ? { x: 0, y: l1.c } : { x: l1.c, y: 0 };
}

const unit = (a: Pt, b: Pt): Pt => {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
};

export type BlockedSeg = { a: Pt; b: Pt };

/**
 * Corner (if any) that joins `from` to `to` with one or two axis-aligned
 * segments. Aligned points need no corner at all.
 *
 * Two corners are possible; the one whose connector does not run back over an
 * existing segment wins, so closing a ring never doubles a side. A tie keeps
 * the direction the pen was already travelling in (`prefer`).
 */
export function orthogonalConnector(
  from: Pt,
  to: Pt,
  blocked: BlockedSeg[] = [],
  prefer: 'H' | 'V' | null = null,
): Pt[] {
  if (Math.abs(from.x - to.x) < 1e-6 || Math.abs(from.y - to.y) < 1e-6) return [];

  const hFirst: Pt = { x: to.x, y: from.y };
  const vFirst: Pt = { x: from.x, y: to.y };
  const hits = (p: Pt, q: Pt) =>
    blocked.reduce((n, s) => n + (collinearOverlap(p, q, s.a, s.b) ? 1 : 0), 0);
  const score = (corner: Pt) => hits(from, corner) + hits(corner, to);

  const order = prefer === 'V' ? [vFirst, hFirst] : [hFirst, vFirst];
  let best = order[0];
  let bestScore = score(best);
  for (const corner of order.slice(1)) {
    const s = score(corner);
    if (s < bestScore) {
      best = corner;
      bestScore = s;
    }
  }
  return [best];
}

/**
 * Removes one segment and every vertex left without an edge.
 *
 * A closed ring opens into a polyline whose end vertices stay, while a bridge
 * disappears on its own. Points are never kept for their own sake, so no
 * free-floating vertex can survive the deletion.
 */
export function removeSegment(
  nodes: NetNode[],
  segs: NetSeg[],
  segId: string,
): { nodes: NetNode[]; segs: NetSeg[] } {
  const rest = segs.filter((seg) => seg.id !== segId);
  const used = new Set<string>();
  for (const seg of rest) {
    used.add(seg.a);
    used.add(seg.b);
  }
  return { nodes: nodes.filter((n) => used.has(n.id)), segs: rest };
}

/**
 * Builds the concrete band for a rectilinear network.
 *
 * Each segment becomes a rectangle; at a mitred (perpendicular) joint the
 * rectangle is extended by half a width so the union closes the corner. The
 * union of those rectangles is the plan shape — exact, branch-friendly. Depth
 * is a property of the segment, so each rectangle has its own constant height.
 */
export function buildStrip(
  nodes: NetNode[],
  segs: NetSeg[],
  widthOf: (seg: NetSeg) => number,
  depthOf: (seg: NetSeg) => number,
): BuiltStrip {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incident = new Map<string, NetSeg[]>();
  for (const s of segs) {
    for (const id of [s.a, s.b]) {
      const list = incident.get(id);
      if (list) list.push(s);
      else incident.set(id, [s]);
    }
  }

  const geoms: SegmentGeometry[] = [];
  const rects: HeightRect[] = [];
  // Node depth is no longer modelled directly; keep a readable value for any
  // consumer by taking the first incident segment.
  const nodesOut = nodes.map((n) => {
    const first = incident.get(n.id)?.[0];
    return { id: n.id, p: { x: n.x, y: n.y }, depth: first ? depthOf(first) : 0 };
  });

  for (const seg of segs) {
    const na = byId.get(seg.a);
    const nb = byId.get(seg.b);
    if (!na || !nb) continue;
    const a: Pt = { x: na.x, y: na.y };
    const b: Pt = { x: nb.x, y: nb.y };
    const u = unit(a, b);
    const horizontal = Math.abs(u.y) < Math.abs(u.x);
    const w = widthOf(seg);
    const centerLen = Math.abs(horizontal ? b.x - a.x : b.y - a.y);
    if (centerLen < 1e-6) continue;

    const sideFor = (sign: 1 | -1): number => {
      /**
       * Where the face on this side ends at a joint.
       *
       * At a corner the face is the mitre of the two offset lines. Which of the
       * neighbour's two sides meets this one depends on how the two segments are
       * stored: if both directions point into (or both out of) the joint, the
       * neighbour's left face is geometrically the opposite one. Ignoring that
       * flipped whole labels to the wrong side of a band.
       */
      const pointAt = (nodeId: string, fallback: Pt): Pt => {
        const q: Pt = { x: byId.get(nodeId)!.x, y: byId.get(nodeId)!.y };
        const list = (incident.get(nodeId) || []).filter((s) => s.id !== seg.id);
        if (list.length !== 1) return fallback;
        const other = list[0];
        const otherNodeId = other.a === nodeId ? other.b : other.a;
        const on = byId.get(otherNodeId);
        if (!on) return fallback;
        const otherU = unit(q, { x: on.x, y: on.y }); // away from the joint
        // The face runs straight through a joint between two collinear pieces.
        if (Math.abs(otherU.x * u.x + otherU.y * u.y) > 1 - 1e-6) return q;
        const otherLeaves = other.a === nodeId;
        const travelU = otherLeaves ? otherU : { x: -otherU.x, y: -otherU.y };
        const segLeaves = seg.a === nodeId;
        const faceSign = (segLeaves === otherLeaves ? -sign : sign) as 1 | -1;
        const inLine = offsetLine(q, travelU, faceSign, widthOf(other) / 2);
        const outLine = offsetLine(q, u, sign, w / 2);
        return intersectLines(inLine, outLine);
      };
      const pa = pointAt(seg.a, a);
      const pb = pointAt(seg.b, b);
      const delta = { x: pb.x - pa.x, y: pb.y - pa.y };
      const along = Math.abs(delta.x * u.x + delta.y * u.y);
      return along > 1e-6 ? along : centerLen;
    };

    const left = sideFor(1);
    const right = sideFor(-1);

    const sign: 1 | -1 = left >= right ? 1 : -1;
    geoms.push({
      id: seg.id,
      a,
      b,
      axis: horizontal ? 'H' : 'V',
      width: w,
      centerLen,
      side: [left, right],
      outerLen: Math.max(left, right),
      innerLen: Math.min(left, right),
      outerSign: sign,
    });

    // Rectangle with mitre extensions at perpendicular joints. The extension
    // is the neighbour's half-width, not this segment's: a wider segment then
    // ends flush with the neighbour instead of growing past it when its own
    // width is edited. Side offsets alone change, the end stays in place.
    const n = leftNormal(u);
    const ext = (nodeId: string): number => {
      const others = (incident.get(nodeId) || []).filter((s) => s.id !== seg.id);
      let reach = 0;
      for (const other of others) {
        const on = byId.get(other.a === nodeId ? other.b : other.a);
        if (!on) continue;
        const ou = unit({ x: byId.get(nodeId)!.x, y: byId.get(nodeId)!.y }, on);
        if (Math.abs(ou.x * u.x + ou.y * u.y) > 1e-6) continue;
        reach = Math.max(reach, widthOf(other) / 2);
      }
      return reach;
    };
    const extA = ext(seg.a);
    const extB = ext(seg.b);
    const p0 = { x: a.x - u.x * extA, y: a.y - u.y * extA };
    const p1 = { x: b.x + u.x * extB, y: b.y + u.y * extB };
    const h = depthOf(seg);
    const leftP = { x: n.x * (w / 2), y: n.y * (w / 2) };
    const xs = [p0.x + leftP.x, p1.x + leftP.x, p0.x - leftP.x, p1.x - leftP.x];
    const ys = [p0.y + leftP.y, p1.y + leftP.y, p0.y - leftP.y, p1.y - leftP.y];
    const rect: HeightRect = {
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
      heightAt: () => h,
    };
    rects.push(rect);
  }

  const union = unionAxisRects(rects);
  return {
    nodes: nodesOut,
    segments: geoms,
    outline: union.outline,
    areaMm2: union.areaMm2,
    volumeMm3: union.volumeMm3,
  };
}

const signedArea = (loop: Pt[]): number => {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
};

/**
 * One visible face of the band, ready to be dimensioned.
 *
 * The union outline already merges collinear boundary edges, so a face that runs
 * unbroken past a partition is one run — exactly the way a builder dimensions
 * the finished wall instead of every piece the drawing happens to be cut into.
 * End caps are dropped: no segment runs along them, so they get no number.
 */
export type FaceRun = {
  /** Stable id: supporting segments plus the side they face. Survives length edits. */
  key: string;
  a: Pt;
  b: Pt;
  len: number;
  axis: 'H' | 'V';
  /** True on an outer boundary, false inside a hole or around a partition. */
  outer: boolean;
  /** Segments whose face this run dimensions (a straight wall may have several). */
  ids: string[];
};

/** A face line must sit half a width away from its axis; allow for float noise. */
const FACE_TOL = 0.5;

export function faceRuns(built: BuiltStrip): FaceRun[] {
  const runs: FaceRun[] = [];
  const seenOrdinal = new Map<string, number>();
  for (const loop of built.outline) {
    if (loop.length < 3) continue;
    const outer = signedArea(loop) > 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const axis: 'H' | 'V' = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';
      const ids: string[] = [];
      let side = 0;
      for (const g of built.segments) {
        if (g.axis !== axis || g.centerLen < 1e-6) continue;
        const half = g.width / 2;
        if (axis === 'H') {
          const offset = a.y - g.a.y;
          if (Math.abs(Math.abs(offset) - half) > FACE_TOL) continue;
          const lo = Math.min(a.x, b.x);
          const hi = Math.max(a.x, b.x);
          const segLo = Math.min(g.a.x, g.b.x);
          const segHi = Math.max(g.a.x, g.b.x);
          const overlap = Math.min(hi, segHi) - Math.max(lo, segLo);
          if (overlap < 1) continue;
        } else {
          const offset = a.x - g.a.x;
          if (Math.abs(Math.abs(offset) - half) > FACE_TOL) continue;
          const lo = Math.min(a.y, b.y);
          const hi = Math.max(a.y, b.y);
          const segLo = Math.min(g.a.y, g.b.y);
          const segHi = Math.max(g.a.y, g.b.y);
          const overlap = Math.min(hi, segHi) - Math.max(lo, segLo);
          if (overlap < 1) continue;
        }
        if (!ids.includes(g.id)) ids.push(g.id);
        if (!side) side = axis === 'H' ? Math.sign(a.y - g.a.y) || 1 : Math.sign(a.x - g.a.x) || 1;
      }
      if (!ids.length) continue;
      const base = `${ids.join('+')}|${side}`;
      const ordinal = seenOrdinal.get(base) ?? 0;
      seenOrdinal.set(base, ordinal + 1);
      const key = `${base}|${ordinal}`;
      runs.push({ key, a, b, len, axis, outer, ids });
    }
  }
  return runs;
}

/**
 * Area of the tooth band that runs along the *outer* contour of the strip.
 *
 * The tooth is the strip's own footprint trimmed from the outside by its width:
 * the outer edge of the tooth is the outer edge of the band, the inner edge is
 * the same contour moved inward. A union outline marks outer boundaries with a
 * positive signed area and holes with a negative one, so only positive loops
 * take part — the tooth never appears on the inner side of a ring.
 *
 * Every boundary edge contributes an inward rectangle of the tooth width; their
 * union is exactly the trimmed band, including mitred corners, and overlaps at
 * corners are counted once by the rectangle union.
 */
export function toothBandAreaMm2(outline: Pt[][], width: number): number {
  if (!(width > 0)) return 0;
  const rects: HeightRect[] = [];
  for (const loop of outline) {
    if (loop.length < 3 || signedArea(loop) <= 0) continue;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      // A positive loop runs counter-clockwise, so the band lies to its left.
      const nx = -dy / len;
      const ny = dx / len;
      const x0 = a.x;
      const x1 = a.x + nx * width;
      const y0 = a.y;
      const y1 = a.y + ny * width;
      const corners = [
        { x: x0, y: y0 },
        { x: b.x, y: b.y },
        { x: x1, y: y1 },
        { x: b.x + nx * width, y: b.y + ny * width },
      ];
      rects.push({
        x0: Math.min(...corners.map((p) => p.x)),
        x1: Math.max(...corners.map((p) => p.x)),
        y0: Math.min(...corners.map((p) => p.y)),
        y1: Math.max(...corners.map((p) => p.y)),
        heightAt: () => 1,
      });
    }
  }
  return unionAxisRects(rects).areaMm2;
}

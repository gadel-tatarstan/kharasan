import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Stage, StripState } from '../state/types';
import { newId } from '../state/types';
import {
  depthOfSeg,
  deriveStrip,
  setStripRunLength,
  stripBounds,
  stripPins,
  stripSidePins,
  toggleStripRunPin,
  widthOfSeg,
} from '../state/derive';
import {
  buildStrip,
  faceRuns,
  fitNetwork,
  mergeCollinearNet,
  netFailText,
  orthogonalConnector,
  removeSegment,
  type BlockedSeg,
  type FaceRun,
  type NetNode,
  type NetSeg,
} from '../geometry/strip';
import { boundsOf, collinearOverlap, dist, distToSegment, rectCenter, type Pt, type Rect } from '../geometry/vec';
import { fitView, project as toScreen, unproject, type View } from '../lib/view';
import { fitChips } from '../lib/layout';
import { fmtM2, fmtM3 } from '../lib/format';
import { PlanCanvas } from './PlanCanvas';
import { Chip } from './Chip';
import {
  Btn,
  ConfirmDialog,
  EditorHeader,
  EditorSheet,
  NumberField,
  Segmented,
  SheetTabs,
  Switch,
  Toast,
  VolumeHud,
} from './ui';
import { C, circle, drawGrid, drawScaleBar, traceLine, tracePolygon } from './draw';

const DEFAULT_BOUNDS: Rect = { x0: -1200, y0: -1200, x1: 1200, y1: 1200 };

type Props = {
  project: Project;
  update: (fn: (p: Project) => Project) => void;
  onBack: () => void;
  onInfo: () => void;
  onRename: () => void;
};

const clampW = (v: number) => Math.min(4000, Math.max(50, v));

const fmtLen = (v: number) => Math.round(v).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');

export function StripEditor({ project, update, onBack, onInfo, onRename }: Props) {
  const strip = project.strip;
  // Older saves opened with a setup screen; it is gone, the base widths now live in the tabs.
  const stage: Stage = project.stage === 'setup' ? 'outline' : project.stage;
  const mode: 'dims' | 'depth' = stage === 'depth' ? 'depth' : 'dims';

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ cx: 0, cy: 0, scale: 1, w: 0, h: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [askRedraw, setAskRedraw] = useState(false);
  const [chain, setChain] = useState<{ start: string; end: string } | null>(null);
  /**
   * Strip snapshots taken before each drawing tap, so «Отменить точку» removes
   * the point together with the edge that created it — even when the tap split
   * or merged an existing centreline.
   */
  const draftHistory = useRef<{ strip: StripState; chain: { start: string; end: string } | null }[]>(
    [],
  );
  /** Drawing stays available after the dimensions are entered. */
  const [drafting, setDrafting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** Face of the band picked by its number; highlights that side, not the axis. */
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  /** Vertex picked in the contour tab; mutually exclusive with `selected`. */
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const didFit = useRef(false);

  const derived = useMemo(() => (strip ? deriveStrip(strip) : null), [strip]);
  const bounds = useMemo(() => (strip ? stripBounds(strip) : null), [strip]);
  // Footprint of the finished band (including its width), shown next to the volume.
  const sceneSize = useMemo(() => {
    if (!derived || !strip?.entered) return null;
    const points = derived.built.outline.flat();
    if (!points.length) return null;
    const box = boundsOf(points);
    return { w: box.x1 - box.x0, h: box.y1 - box.y0 };
  }, [derived, strip?.entered]);
  const sidePins = useMemo(() => (strip ? stripSidePins(strip) : new Set<string>()), [strip]);
  /**
   * Visible faces of the band. A straight wall split by partitions keeps one
   * number on the side that stays continuous and separate numbers where the
   * partitions actually interrupt it.
   */
  const runs = useMemo(() => (derived ? faceRuns(derived.built) : []), [derived]);

  // Older saves pinned whole segments. A face pin is the closest equivalent, so
  // the green mark moves from the axis to the outer side once, on first open.
  const legacyPinsMigrated = useRef(false);
  useEffect(() => {
    if (legacyPinsMigrated.current || !strip) return;
    const legacy = strip.pinned ?? [];
    if (!legacy.length) {
      legacyPinsMigrated.current = true;
      return;
    }
    if (!derived || !runs.length) return;
    legacyPinsMigrated.current = true;
    const keys = new Set(stripSidePins(strip));
    for (const id of legacy) {
      const own = runs.filter((r) => r.ids.includes(id));
      const pick = own.find((r) => r.outer) ?? own[0];
      if (pick) keys.add(pick.key);
    }
    update((p) =>
      p.strip ? { ...p, strip: { ...p.strip, pinned: [], sidePins: [...keys] } } : p,
    );
  }, [derived, runs, strip, update]);
  const preview = useMemo(() => {
    if (!strip || strip.baseNodes || !strip.segs.length) return null;
    return buildStrip(
      strip.nodes,
      strip.segs,
      (seg) => widthOfSeg(strip, seg),
      (seg) => depthOfSeg(strip, seg),
    );
  }, [strip]);

  const onSize = useCallback((w: number, h: number) => {
    setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
  }, []);

  const boundsRef = useRef<Rect | null>(null);
  boundsRef.current = bounds;

  // Only the canvas size changes the viewport; tabs never re-frame the drawing.
  useEffect(() => {
    if (!size.w || !size.h) return;
    if (!didFit.current) {
      didFit.current = true;
      setView(fitView(boundsRef.current ?? DEFAULT_BOUNDS, size.w, size.h));
    } else {
      setView((v) => {
        if (v.w === size.w && v.h === size.h) return v;
        const topLeft = { x: v.cx - v.w / 2 / v.scale, y: v.cy - v.h / 2 / v.scale };
        return {
          ...v,
          w: size.w,
          h: size.h,
          cx: topLeft.x + size.w / 2 / v.scale,
          cy: topLeft.y + size.h / 2 / v.scale,
        };
      });
    }
  }, [size]);

  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (!fitToken) return;
    const s = sizeRef.current;
    if (!s.w || !s.h) return;
    setView(fitView(boundsRef.current ?? DEFAULT_BOUNDS, s.w, s.h));
  }, [fitToken]);

  const patch = (fn: (s: StripState) => StripState) =>
    update((p) => (p.strip ? { ...p, strip: fn(p.strip) } : p));
  const setStage = (s: Stage) => update((p) => ({ ...p, stage: s }));

  if (!strip) return null;

  const rawNodes = strip.nodes;
  const rawSegs = strip.segs;

  const nodeAt = (id: string, nodes: NetNode[] = rawNodes) => nodes.find((n) => n.id === id);
  const worldOf = (n: NetNode): Pt => ({ x: n.x, y: n.y });

  /** Remembers the scene before a drawing step, for a precise undo. */
  const rememberDraft = () => {
    draftHistory.current.push({ strip, chain });
    if (draftHistory.current.length > 80) draftHistory.current.shift();
  };

  const axisLength = (a: NetNode, b: NetNode): number => {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    return dx >= dy ? dx : dy;
  };

  const lensOf = (nodes: NetNode[], segs: NetSeg[]): Record<string, number> => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out: Record<string, number> = {};
    for (const seg of segs) {
      const a = byId.get(seg.a);
      const b = byId.get(seg.b);
      if (a && b) out[seg.id] = axisLength(a, b);
    }
    return out;
  };

  /**
   * Stores a freshly drawn network. After the first dimension is typed the
   * shape is rebuilt from `baseNodes` + `lens`, so both must move together with
   * the drawing — otherwise new segments fall outside `deriveStrip` and vanish.
   */
  const applyNetwork = (s: StripState, nodes: NetNode[], segs: NetSeg[]): StripState => {
    // A line drawn on top of another becomes one shared centreline: collinear
    // segments are cut at each other's endpoints, coincident vertices are fused
    // and the doubled run keeps a single copy. That kills the double dashed
    // axis, and the cut points are ordinary vertices ready for a branch.
    const merged = mergeCollinearNet(nodes, segs);
    const outNodes = merged.nodes;
    const outSegs = merged.segs;

    const widths: Record<string, number> = {};
    for (const seg of outSegs) {
      const sources = merged.origin[seg.id] ?? [seg.id];
      if (!sources.some((id) => s.widths[id] !== undefined)) continue;
      // A shared run keeps the widest source: the concrete envelope stays whole.
      widths[seg.id] = Math.max(...sources.map((id) => s.widths[id] ?? s.baseWidth));
    }

    const pinned = s.pinned
      ? outSegs
          .filter((seg) => (merged.origin[seg.id] ?? []).some((id) => s.pinned!.includes(id)))
          .map((seg) => seg.id)
      : null;
    const refSeg = s.refSeg
      ? outSegs.find((seg) => (merged.origin[seg.id] ?? []).includes(s.refSeg!))?.id ?? null
      : null;

    // Pinned faces keep their number through splits and merges: every source id
    // is followed to the run that inherited it, and the face id is rebuilt.
    const sidePins: string[] = [];
    for (const key of s.sidePins ?? []) {
      const [idsPart, face, ordinal] = key.split('|');
      const mapped: string[] = [];
      let alive = true;
      for (const id of idsPart.split('+')) {
        // One old piece may be cut into several new ones (a branch landed on
        // the face); keep all of them, otherwise the face key stops matching
        // the run and a pinned wall silently loses its green mark.
        let found = false;
        for (const seg of outSegs) {
          if (!(merged.origin[seg.id] ?? [seg.id]).includes(id)) continue;
          found = true;
          if (!mapped.includes(seg.id)) mapped.push(seg.id);
        }
        if (!found) {
          alive = false;
          break;
        }
      }
      if (alive && mapped.length) sidePins.push(`${mapped.join('+')}|${face}|${ordinal ?? 0}`);
    }

    // Depth follows a segment through splits and merges: the shared run keeps
    // the deepest source. Legacy node-keyed saves are remapped as well.
    const depths: Record<string, number> = {};
    for (const seg of outSegs) {
      for (const id of merged.origin[seg.id] ?? [seg.id]) {
        const v = s.depths[id];
        if (v !== undefined && (depths[seg.id] === undefined || v > depths[seg.id])) {
          depths[seg.id] = v;
        }
      }
    }
    for (const [from, to] of Object.entries(merged.nodeMap)) {
      const v = s.depths[from];
      if (v === undefined) continue;
      if (depths[to] === undefined || v > depths[to]) depths[to] = v;
    }

    if (!s.baseNodes) {
      return { ...s, nodes: outNodes, segs: outSegs, widths, pinned, sidePins, refSeg, depths };
    }
    const box = boundsOf(outNodes);
    return {
      ...s,
      nodes: outNodes,
      baseNodes: outNodes.map((n) => ({ ...n })),
      segs: outSegs,
      widths,
      pinned,
      sidePins,
      refSeg,
      depths,
      sx: 1,
      sy: 1,
      lens: s.entered ? lensOf(outNodes, outSegs) : null,
      pivot: rectCenter(box),
    };
  };

  const validate = (nodes: NetNode[], segs: NetSeg[]): boolean => {
    if (!segs.length) return true;
    const res = fitNetwork({ nodes, segs });
    if (!res.ok) {
      setToast(netFailText[res.reason]);
      return false;
    }
    return true;
  };

  /**
   * Orthogonal snap for the pen. Both directions are possible; prefer the one
   * that does not run along a segment already leaving this vertex, so dragging
   * diagonally away from a corner feels like starting a branch. An exactly
   * axis-aligned tap keeps its direction even when it overlaps.
   */
  const penPoint = (from: Pt | null, world: Pt): Pt => {
    if (!from) return world;
    const dx = Math.abs(world.x - from.x);
    const dy = Math.abs(world.y - from.y);
    const h: Pt = { x: world.x, y: from.y };
    const v: Pt = { x: from.x, y: world.y };
    const order = dx >= dy ? [h, v] : [v, h];
    const overlaps = (p: Pt) =>
      dist(from, p) > 1e-6 &&
      rawSegs.some((s) => {
        const a = nodeAt(s.a);
        const b = nodeAt(s.b);
        return !!a && !!b && collinearOverlap(from, p, worldOf(a), worldOf(b));
      });
    // A perpendicular escape only makes sense if it is a real move; a tap that
    // is almost exactly on the line keeps its direction so the line can be
    // drawn over an existing one and merged.
    const meaningful = (p: Pt) => dist(from, p) * view.scale >= 12;
    if (!overlaps(order[0])) return order[0];
    if (meaningful(order[1]) && !overlaps(order[1])) return order[1];
    return order[0];
  };

  const addNode = (world: Pt) => {
    const lastId = chain?.end ?? null;
    const last = lastId ? nodeAt(lastId) : null;
    const p = last ? penPoint(worldOf(last), world) : world;
    if (last && dist(worldOf(last), p) * view.scale < 12) return;

    // Landing on an existing vertex reuses it: stacking a second node at the
    // same spot makes a zero-length segment and the "points merged" warning.
    const target = rawNodes.find(
      (n) => n.id !== lastId && Math.abs(n.x - p.x) < 0.5 && Math.abs(n.y - p.y) < 0.5,
    );
    if (target) {
      if (!lastId) {
        setChain({ start: target.id, end: target.id });
        return;
      }
      const already = rawSegs.some(
        (s) => (s.a === lastId && s.b === target.id) || (s.b === lastId && s.a === target.id),
      );
      if (!already) {
        const segs = [...rawSegs, { id: newId('s'), a: lastId, b: target.id }];
        if (!validate(rawNodes, segs)) return;
        rememberDraft();
        patch((s) => applyNetwork(s, rawNodes, segs));
      }
      setChain({ start: chain!.start, end: target.id });
      return;
    }

    const id = newId('n');
    const nodes = [...rawNodes, { id, x: p.x, y: p.y }];
    const segs = lastId ? [...rawSegs, { id: newId('s'), a: lastId, b: id }] : rawSegs;
    if (!validate(nodes, segs)) return;
    rememberDraft();
    patch((s) => applyNetwork(s, nodes, segs));
    setChain({ start: chain?.start ?? id, end: id });
  };

  /** What a tap landed on while drawing: a vertex, or a point on an edge. */
  type SnapTarget =
    | { kind: 'node'; node: NetNode }
    | { kind: 'segment'; seg: NetSeg; p: Pt };

  const NODE_SNAP = 26;
  const EDGE_SNAP = 18;

  const nodeHit = (screen: Pt, nodes: NetNode[] = rawNodes): NetNode | null => {
    let best: { node: NetNode; d: number } | null = null;
    for (const n of nodes) {
      const d = dist(screen, toScreen(worldOf(n), view));
      if (d <= NODE_SNAP && (!best || d < best.d)) best = { node: n, d };
    }
    return best?.node ?? null;
  };

  /** Point where a tap on an edge should split it; clamped away from corners. */
  const splitOn = (seg: NetSeg, world: Pt): { p: Pt; node: NetNode | null } | null => {
    const a = nodeAt(seg.a);
    const b = nodeAt(seg.b);
    if (!a || !b) return null;
    const wa = worldOf(a);
    const wb = worldOf(b);
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const len = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
    const minGap = Math.max(1, 12 / view.scale);
    if (len <= minGap * 2.2) {
      const da = dist(world, wa);
      const db = dist(world, wb);
      return { p: da <= db ? wa : wb, node: da <= db ? a : b };
    }
    const p: Pt = horizontal
      ? {
          x: Math.min(Math.max(world.x, Math.min(a.x, b.x) + minGap), Math.max(a.x, b.x) - minGap),
          y: a.y,
        }
      : {
          x: a.x,
          y: Math.min(Math.max(world.y, Math.min(a.y, b.y) + minGap), Math.max(a.y, b.y) - minGap),
        };
    const near = dist(p, wa) <= minGap || dist(p, wb) <= minGap;
    const node = near ? (dist(p, wa) <= dist(p, wb) ? a : b) : null;
    return { p: node ? worldOf(node) : p, node };
  };

  /**
   * Tap target while drawing. Vertices win over edges; the segment we are
   * currently standing on is ignored so a tap cannot split its own tail.
   */
  const snapTarget = (screen: Pt, world: Pt): SnapTarget | null => {
    const endId = chain?.end ?? null;
    const node = nodeHit(screen);
    if (node && node.id !== endId) return { kind: 'node', node };
    let best: { target: SnapTarget; d: number } | null = null;
    for (const seg of rawSegs) {
      if (endId && (seg.a === endId || seg.b === endId)) continue;
      const a = nodeAt(seg.a);
      const b = nodeAt(seg.b);
      if (!a || !b) continue;
      const d = distToSegment(screen, toScreen(worldOf(a), view), toScreen(worldOf(b), view));
      if (d > EDGE_SNAP || (best && d >= best.d)) continue;
      const split = splitOn(seg, world);
      if (!split) continue;
      best = {
        d,
        target: split.node
          ? { kind: 'node', node: split.node }
          : { kind: 'segment', seg, p: split.p },
      };
    }
    return best?.target ?? null;
  };

  /**
   * Draws the missing orthogonal connection from the end of the current chain
   * to a tapped vertex or edge. If the points are not aligned, the corner is
   * added automatically — that is what makes closing a ring reliable.
   */
  const connectTarget = (target: SnapTarget) => {
    if (!chain) return;
    const endNode = nodeAt(chain.end);
    if (!endNode) return;
    const from = worldOf(endNode);

    let to: Pt;
    let targetNodeId = '';
    let splitSeg: NetSeg | null = null;
    if (target.kind === 'node') {
      if (target.node.id === chain.end) return;
      // Already connected: just move the pen there instead of adding the same
      // segment twice (the union would count it once, but a duplicate is not a
      // useful drawing step and used to trip the validation).
      const already = rawSegs.some(
        (s) =>
          (s.a === chain.end && s.b === target.node.id) ||
          (s.b === chain.end && s.a === target.node.id),
      );
      if (already) {
        if (target.node.id === chain.start) setChain(null);
        else setChain({ start: chain.start, end: target.node.id });
        return;
      }
      to = worldOf(target.node);
      targetNodeId = target.node.id;
    } else {
      splitSeg = target.seg;
      to = target.p;
    }
    if (dist(from, to) < 1e-6) return;

    // Continue the direction the pen was already going when both corners work.
    let prefer: 'H' | 'V' | null = null;
    for (const s of rawSegs) {
      if (s.a !== chain.end && s.b !== chain.end) continue;
      const a = nodeAt(s.a);
      const b = nodeAt(s.b);
      if (a && b) prefer = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'H' : 'V';
    }

    const blocked: BlockedSeg[] = [];
    for (const s of rawSegs) {
      const a = nodeAt(s.a);
      const b = nodeAt(s.b);
      if (a && b) blocked.push({ a: worldOf(a), b: worldOf(b) });
    }
    const corners = orthogonalConnector(from, to, blocked, prefer);

    let nodes = [...rawNodes];
    let segs = [...rawSegs];
    const widths = { ...strip.widths };
    let splitNewIds: string[] = [];

    if (splitSeg) {
      const splitId = newId('n');
      nodes.push({ id: splitId, x: to.x, y: to.y });
      const own = widths[splitSeg.id];
      delete widths[splitSeg.id];
      const first: NetSeg = { id: newId('s'), a: splitSeg.a, b: splitId, w: splitSeg.w };
      const second: NetSeg = { id: newId('s'), a: splitId, b: splitSeg.b, w: splitSeg.w };
      segs = segs.filter((s) => s.id !== splitSeg!.id).concat([first, second]);
      splitNewIds = [first.id, second.id];
      if (own !== undefined) {
        widths[first.id] = own;
        widths[second.id] = own;
      }
      targetNodeId = splitId;
    }

    let prev = chain.end;
    for (const c of corners) {
      // Reuse a vertex that already stands exactly at the corner instead of
      // stacking a second node on top of it.
      const existing = rawNodes.find(
        (n) => Math.abs(n.x - c.x) < 1e-6 && Math.abs(n.y - c.y) < 1e-6,
      );
      if (existing) {
        if (existing.id === prev) continue;
        segs.push({ id: newId('s'), a: prev, b: existing.id });
        prev = existing.id;
        continue;
      }
      const id = newId('n');
      nodes.push({ id, x: c.x, y: c.y });
      segs.push({ id: newId('s'), a: prev, b: id });
      prev = id;
    }
    if (prev === targetNodeId) return;
    segs.push({ id: newId('s'), a: prev, b: targetNodeId });

    if (targetNodeId === chain.start && segs.length < 4) {
      setToast('Чтобы замкнуть кольцо, нужно минимум четыре отрезка. Поставьте ещё точку.');
      return;
    }

    if (!validate(nodes, segs)) return;
    patch((s) => {
      const pins = stripPins(s);
      if (splitSeg && splitNewIds.length && pins.delete(splitSeg.id)) {
        for (const id of splitNewIds) pins.add(id);
      }
      return applyNetwork({ ...s, widths, pinned: [...pins] }, nodes, segs);
    });
    setChain(null);
    if (navigator.vibrate) navigator.vibrate(18);
  };

  /**
   * Finishing a line on the band: instead of drawing an L-shaped detour, go
   * straight to the target centreline and split the target there.
   *
   * - with several points the last segment keeps its direction and only
   *   changes length, so no corner points appear;
   * - with a single point (a branch just started on a band) a new
   *   perpendicular segment is drawn to the opposite band.
   *
   * Returns false when that is geometrically impossible (parallel lines, the
   * crossing falls outside the target, the pen would fold back on itself) and
   * the caller falls back to the regular orthogonal connector.
   */
  const connectBandDirect = (hit: { seg: NetSeg; p: Pt; node: NetNode | null }): boolean => {
    if (!chain) return false;
    const endId = chain.end;
    const endNode = nodeAt(endId);
    if (!endNode) return false;

    const seg = hit.seg;
    if (seg.a === endId || seg.b === endId) return false;
    const a = nodeAt(seg.a);
    const b = nodeAt(seg.b);
    if (!a || !b) return false;

    const targetH = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const single = chain.start === endId;
    let prevSeg: NetSeg | null = null;
    let prevOther: NetNode | null = null;
    if (!single) {
      prevSeg = [...rawSegs].reverse().find((s) => s.a === endId || s.b === endId) ?? null;
      if (!prevSeg || prevSeg.id === seg.id) return false;
      const prevOtherId = prevSeg.a === endId ? prevSeg.b : prevSeg.a;
      prevOther = nodeAt(prevOtherId) ?? null;
      if (!prevOther) return false;
      const prevH = Math.abs(prevOther.x - endNode.x) >= Math.abs(prevOther.y - endNode.y);
      if (prevH === targetH) return false;
    }

    // The crossing always sits on the pen's perpendicular to the target axis.
    const c: Pt = targetH ? { x: endNode.x, y: a.y } : { x: a.x, y: endNode.y };
    const gap = Math.max(1, 10 / view.scale);
    const lo = targetH ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = targetH ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const along = targetH ? c.x : c.y;
    if (along < lo + gap || along > hi - gap) return false;

    if (!single && prevOther) {
      // The endpoint only slides along the last segment. If the crossing is on
      // the far side of its other end, sliding would fold the segment back on
      // itself, so let the connector handle that case.
      const prevH = Math.abs(prevOther.x - endNode.x) >= Math.abs(prevOther.y - endNode.y);
      const dot = prevH
        ? (c.x - prevOther.x) * (endNode.x - prevOther.x)
        : (c.y - prevOther.y) * (endNode.y - prevOther.y);
      if (dot <= 0) return false;
    }

    const tol = 1e-6;
    const targetNode = [a, b].find(
      (n) => Math.abs(n.x - c.x) < tol && Math.abs(n.y - c.y) < tol,
    );

    let nodes = rawNodes.map((n) => ({ ...n }));
    let segs = [...rawSegs];
    const widths = { ...strip.widths };
    let splitIds: string[] = [];

    /** Splits the target edge at the crossing and returns that node id. */
    const splitTarget = (splitId: string): void => {
      const own = widths[seg.id];
      delete widths[seg.id];
      const first: NetSeg = { id: newId('s'), a: seg.a, b: splitId, w: seg.w };
      const second: NetSeg = { id: newId('s'), a: splitId, b: seg.b, w: seg.w };
      segs = segs.filter((s) => s.id !== seg.id).concat([first, second]);
      splitIds = [first.id, second.id];
      if (own !== undefined) {
        widths[first.id] = own;
        widths[second.id] = own;
      }
    };

    let attachId: string;
    if (!single) {
      // Slide the end of the last segment onto the target centreline.
      if (targetNode) {
        attachId = targetNode.id;
        const prevOtherId = prevSeg!.a === endId ? prevSeg!.b : prevSeg!.a;
        if (attachId === prevOtherId) return false;
        segs = segs.map((s) => {
          if (s.id !== prevSeg!.id) return s;
          return s.a === endId ? { ...s, a: attachId } : { ...s, b: attachId };
        });
        if (!segs.some((s) => s.a === endId || s.b === endId)) {
          nodes = nodes.filter((n) => n.id !== endId);
        }
      } else {
        attachId = endId;
        nodes = nodes.map((n) => (n.id === endId ? { ...n, x: c.x, y: c.y } : n));
        splitTarget(endId);
      }
    } else {
      // No previous segment yet: draw a new perpendicular segment to the band.
      if (Math.abs(c.x - endNode.x) < tol && Math.abs(c.y - endNode.y) < tol) return false;
      if (targetNode) {
        attachId = targetNode.id;
      } else {
        attachId = newId('n');
        nodes.push({ id: attachId, x: c.x, y: c.y });
        splitTarget(attachId);
      }
      segs.push({ id: newId('s'), a: endId, b: attachId });
    }

    if (!fitNetwork({ nodes, segs }).ok) return false;
    // Closing a ring still needs at least four edges, exactly as the regular
    // connector path enforces.
    if (!single && targetNode?.id === chain.start && segs.length < 4) return false;

    rememberDraft();
    patch((s) => {
      const pins = stripPins(s);
      if (splitIds.length && pins.delete(seg.id)) {
        for (const id of splitIds) pins.add(id);
      }
      return applyNetwork({ ...s, widths, pinned: [...pins] }, nodes, segs);
    });
    setChain(null);
    if (navigator.vibrate) navigator.vibrate(18);
    return true;
  };

  const hitSegment = (screen: Pt): NetSeg | null => {
    const nodes = derived?.nodes ?? rawNodes;
    let best: { seg: NetSeg; d: number } | null = null;
    for (const seg of rawSegs) {
      const a = nodeAt(seg.a, nodes);
      const b = nodeAt(seg.b, nodes);
      if (!a || !b) continue;
      const d = distToSegment(screen, toScreen(worldOf(a), view), toScreen(worldOf(b), view));
      if (d < 18 && (!best || d < best.d)) best = { seg, d };
    }
    return best?.seg ?? null;
  };

  /**
   * The whole painted band is tappable, not just the thin axis: the reach is
   * half the band width in screen pixels. Returns the point on the centreline
   * where a branch would attach.
   */
  const bandHit = (
    screen: Pt,
    ignoreNear?: string,
  ): { seg: NetSeg; p: Pt; node: NetNode | null } | null => {
    let best: { hit: { seg: NetSeg; p: Pt; node: NetNode | null }; d: number } | null = null;
    const world = unproject(screen, view);
    for (const seg of rawSegs) {
      if (ignoreNear && (seg.a === ignoreNear || seg.b === ignoreNear)) continue;
      const a = nodeAt(seg.a);
      const b = nodeAt(seg.b);
      if (!a || !b) continue;
      const d = distToSegment(screen, toScreen(worldOf(a), view), toScreen(worldOf(b), view));
      const reach = Math.max(EDGE_SNAP, (widthOfSeg(strip, seg) / 2) * view.scale + 6);
      if (d > reach) continue;
      const split = splitOn(seg, world);
      if (!split) continue;
      if (!best || d < best.d) best = { hit: { seg, p: split.p, node: split.node }, d };
    }
    return best?.hit ?? null;
  };

  /** Starts a chain from a tap on the band: split the edge and grow from there. */
  const startBranch = (hit: { seg: NetSeg; p: Pt; node: NetNode | null }) => {
    const { seg, p, node } = hit;
    if (node) {
      setChain({ start: node.id, end: node.id });
      return;
    }
    const id = newId('n');
    const segs = rawSegs
      .filter((s) => s.id !== seg.id)
      .concat([
        { id: newId('s'), a: seg.a, b: id, w: seg.w },
        { id: newId('s'), a: id, b: seg.b, w: seg.w },
      ]);
    const nodes = [...rawNodes, { id, x: p.x, y: p.y }];
    if (!validate(nodes, segs)) return;
    rememberDraft();
    patch((s) => {
      const widths = { ...s.widths };
      const own = widths[seg.id];
      const out = { ...widths };
      delete out[seg.id];
      const halfIds = [segs[segs.length - 2].id, segs[segs.length - 1].id];
      if (own !== undefined) {
        out[halfIds[0]] = own;
        out[halfIds[1]] = own;
      }
      const pins = stripPins(s);
      if (pins.delete(seg.id)) {
        for (const id of halfIds) pins.add(id);
      }
      return applyNetwork({ ...s, widths: out, pinned: [...pins] }, nodes, segs);
    });
    setChain({ start: id, end: id });
  };

  /**
   * Before drawing on a finished strip, bake the solved geometry into the base
   * network. From then on new points live in the same millimetre space as the
   * typed lengths, so a new branch does not jump and old dimensions stay put.
   */
  const prepareEditing = () => {
    if (!strip.baseNodes) return;
    const nodes = (derived?.nodes ?? rawNodes).map((n) => ({ ...n }));
    patch((s) => applyNetwork(s, nodes, s.segs));
  };

  const beginAdd = () => {
    prepareEditing();
    draftHistory.current = [];
    setChain(null);
    setSelected(null);
    setSelectedNode(null);
    setDrafting(true);
  };

  const finishAdding = () => {
    // A just-started line that never got a second point leaves a lone node.
    if (chain && chain.start === chain.end && !rawSegs.some((s) => s.a === chain.end || s.b === chain.end)) {
      const id = chain.end;
      patch((s) => applyNetwork(s, s.nodes.filter((n) => n.id !== id), s.segs));
    }
    setChain(null);
    setSelected(null);
    setSelectedNode(null);
    setDrafting(false);
    draftHistory.current = [];
  };

  const segsAtNode = (id: string) => rawSegs.filter((s) => s.a === id || s.b === id);

  /**
   * What "Отменить точку" may do with the vertex the pen is standing on.
   *
   * A corner, a junction or a free end of an existing line is a real part of
   * the drawing and must stay: deleting it used to erase whole neighbouring
   * lines. Only a freshly placed lone point or a collinear split point on a
   * straight run can be removed.
   */
  const canUndo = (): boolean => {
    if (!chain) return false;
    if (chain.start !== chain.end) return true;
    const id = chain.end;
    const at = segsAtNode(id);
    if (!at.length) return true;
    if (at.length !== 2) return false;
    const n = nodeAt(id);
    if (!n) return false;
    const other = (s: NetSeg) => nodeAt(s.a === id ? s.b : s.a);
    const o1 = other(at[0]);
    const o2 = other(at[1]);
    if (!o1 || !o2) return false;
    const ax = n.x - o1.x;
    const ay = n.y - o1.y;
    const bx = n.x - o2.x;
    const by = n.y - o2.y;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    if (Math.abs(cross) > 1e-6 || dot >= 0) return false;
    // Merging halves with different widths would silently change the band.
    const w1 = strip.widths[at[0].id];
    const w2 = strip.widths[at[1].id];
    return !(w1 !== undefined && w2 !== undefined && Math.abs(w1 - w2) > 0.5);
  };

  const undoPoint = () => {
    if (!chain) return;
    // The exact previous scene is the safest undo: the last tap may have split
    // or merged a centreline, so guessing which edge to cut can erase old work.
    const prev = draftHistory.current.pop();
    if (prev) {
      update((p) => ({ ...p, strip: prev.strip }));
      setChain(prev.chain);
      return;
    }
    if (chain.start === chain.end) {
      const id = chain.end;
      const at = segsAtNode(id);
      if (!at.length) {
        patch((s) => applyNetwork(s, s.nodes.filter((n) => n.id !== id), s.segs));
        setChain(null);
        return;
      }
      if (!canUndo() || at.length !== 2) return;
      // The point sits in the middle of a straight run: drop it and fuse the
      // two halves into one segment again.
      const other = (s: NetSeg) => (s.a === id ? s.b : s.a);
      const merged: NetSeg = { id: newId('s'), a: other(at[0]), b: other(at[1]) };
      const widths = { ...strip.widths };
      const own1 = widths[at[0].id];
      const own2 = widths[at[1].id];
      delete widths[at[0].id];
      delete widths[at[1].id];
      if (own1 !== undefined) widths[merged.id] = own1;
      else if (own2 !== undefined) widths[merged.id] = own2;
      const pins = stripPins(strip);
      const wasPinned = pins.has(at[0].id) || pins.has(at[1].id);
      pins.delete(at[0].id);
      pins.delete(at[1].id);
      if (wasPinned) pins.add(merged.id);
      const nodes = rawNodes.filter((n) => n.id !== id);
      const segs = rawSegs.filter((s) => s.id !== at[0].id && s.id !== at[1].id).concat(merged);
      if (!validate(nodes, segs)) return;
      const depths = { ...strip.depths };
      delete depths[id];
      const d1 = depths[at[0].id];
      const d2 = depths[at[1].id];
      delete depths[at[0].id];
      delete depths[at[1].id];
      if (d1 !== undefined || d2 !== undefined) depths[merged.id] = Math.max(d1 ?? 0, d2 ?? 0);
      patch((s) => applyNetwork({ ...s, widths, pinned: [...pins], depths }, nodes, segs));
      setChain(null);
      return;
    }
    const last = rawSegs.filter((s) => s.b === chain.end || s.a === chain.end).pop();
    const segs = last ? rawSegs.filter((s) => s.id !== last.id) : rawSegs;
    patch((s) => applyNetwork(s, rawNodes, segs));
    setChain({
      start: chain.start,
      end: last ? (last.a === chain.end ? last.b : last.a) : chain.start,
    });
  };

  const tapCanvas = (screen: Pt, world: Pt) => {
    if (stage === 'outline' || drafting) {
      if (chain) {
        // A vertex always wins; closing the ring is just another vertex tap.
        const node = nodeHit(screen);
        if (node && node.id !== chain.end) {
          connectTarget({ kind: 'node', node });
          return;
        }
        // A tap on the band finishes the line on its centreline: the last
        // segment only changes length, no L-shaped detour is added.
        const band = bandHit(screen, chain.end);
        if (band && connectBandDirect(band)) return;
        // Edges that cannot be met straight on still connect with a corner.
        const target = snapTarget(screen, world);
        if (target) {
          connectTarget(target);
          return;
        }
        addNode(world);
        return;
      }
      // Without an active line a tap on a vertex or on the band starts a
      // branch from there; anywhere else starts a new line.
      const node = nodeHit(screen);
      if (node) {
        setChain({ start: node.id, end: node.id });
        return;
      }
      const band = bandHit(screen);
      if (band) {
        startBranch(band);
        return;
      }
      addNode(world);
      return;
    }
    // On the depth tab the canvas only shows numbers, so a tap must not select anything.
    if (mode !== 'dims') return;
    // A vertex wins over the band it belongs to, otherwise a joint in a dense
    // branching scene could never be picked for deletion. The solved geometry is
    // the one on screen, so hit-test against it rather than the base nodes.
    const node = nodeHit(screen, derived?.nodes ?? rawNodes);
    if (node) {
      setSelectedNode(node.id);
      setSelected(null);
      return;
    }
    const seg = hitSegment(screen);
    setSelected(seg ? seg.id : null);
    setSelectedNode(null);
  };

  const finishDrawing = () => {
    const res = fitNetwork({ nodes: rawNodes, segs: rawSegs });
    if (!res.ok) {
      setToast(netFailText[res.reason]);
      return;
    }
    const b = boundsOf(res.nodes);
    patch((s) => ({
      ...s,
      baseNodes: res.nodes,
      nodes: res.nodes,
      pivot: rectCenter(b),
      sx: 1,
      sy: 1,
      lens: null,
      pinned: null,
      entered: false,
    }));
    setChain(null);
    setSelected(null);
    setSelectedNode(null);
    setStage('dims');
    draftHistory.current = [];
    window.setTimeout(() => setFitToken((t) => t + 1), 0);
  };

  const redraw = () => {
    patch((s) => ({
      ...s,
      nodes: [],
      segs: [],
      baseNodes: null,
      sx: 1,
      sy: 1,
      lens: null,
      pinned: null,
      entered: false,
      widths: {},
      depths: {},
      refSeg: null,
    }));
    setChain(null);
    setSelected(null);
    setSelectedNode(null);
    setDrafting(false);
    setStage('outline');
    draftHistory.current = [];
  };

  /** Empties the band but keeps the default width/depth. */
  const resetToOutline = () => {
    patch((s) => ({
      ...s,
      nodes: [],
      segs: [],
      baseNodes: null,
      sx: 1,
      sy: 1,
      lens: null,
      pinned: null,
      entered: false,
      widths: {},
      depths: {},
      refSeg: null,
    }));
    setChain(null);
    setSelected(null);
    setSelectedNode(null);
    setDrafting(false);
    setStage('outline');
    draftHistory.current = [];
  };

  /**
   * Removes one segment and every vertex that is left without an edge.
   *
   * The remaining lines keep their real endpoints: deleting the side of a ring
   * opens it into a polyline with two free ends, while a bridge simply leaves
   * the two sides it joined untouched. A point never survives on its own, so
   * the canvas can never show a floating vertex.
   */
  const deleteSeg = (segId: string) => {
    const nodes = (derived?.nodes ?? rawNodes).map((n) => ({ ...n }));
    const rest = removeSegment(nodes, rawSegs, segId);
    setSelected(null);
    setSelectedNode(null);
    if (!rest.segs.length) {
      resetToOutline();
      return;
    }
    patch((s) => applyNetwork(s, rest.nodes, rest.segs));
  };

  /**
   * Removes a vertex and rebuilds the centreline around the gap.
   *
   * A point in the middle of a straight run disappears without a trace: the
   * two collinear halves become one segment. A corner takes both of its edges
   * with it, and a branch point is removed together with the branch, while the
   * main line continues straight through. Any vertex left without an edge is
   * dropped as well, so no free-floating point can remain.
   */
  const deleteNode = (nodeId: string) => {
    const nodes = (derived?.nodes ?? rawNodes).map((n) => ({ ...n }));
    const p = nodes.find((n) => n.id === nodeId);
    const incident = rawSegs.filter((s) => s.a === nodeId || s.b === nodeId);
    setSelectedNode(null);
    setSelected(null);
    if (!p) return;
    if (!incident.length) {
      const kept = nodes.filter((n) => n.id !== nodeId);
      patch((s) => applyNetwork(s, kept, rawSegs));
      return;
    }

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const otherEnd = (seg: NetSeg) => (seg.a === nodeId ? seg.b : seg.a);
    // Split the incident edges into arrows on the two axes. Opposite arrows on
    // the same axis form a straight run, everything unpaired is a branch.
    const arms: Record<'H' | 'V', { seg: NetSeg; sign: 1 | -1 }[]> = { H: [], V: [] };
    for (const seg of incident) {
      const to = byId.get(otherEnd(seg));
      if (!to) continue;
      const dx = to.x - p.x;
      const dy = to.y - p.y;
      const axis = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';
      const sign: 1 | -1 = (axis === 'H' ? dx : dy) >= 0 ? 1 : -1;
      arms[axis].push({ seg, sign });
    }

    type Fusion = { id: string; a: string; b: string; farA: string; farB: string };
    const fusions: Fusion[] = [];
    const drop = new Set(incident.map((s) => s.id));
    for (const axis of ['H', 'V'] as const) {
      const plus = arms[axis].filter((a) => a.sign > 0);
      const minus = arms[axis].filter((a) => a.sign < 0);
      const pairs = Math.min(plus.length, minus.length);
      for (let i = 0; i < pairs; i++) {
        fusions.push({
          id: newId('s'),
          a: plus[i].seg.id,
          b: minus[i].seg.id,
          farA: otherEnd(plus[i].seg),
          farB: otherEnd(minus[i].seg),
        });
      }
    }

    const keptSegs = rawSegs.filter((s) => !drop.has(s.id));
    const segs = [
      ...keptSegs,
      ...fusions.map((f) => ({ id: f.id, a: f.farA, b: f.farB })),
    ];
    if (!segs.length) {
      resetToOutline();
      return;
    }

    const widths = { ...strip.widths };
    const depths = { ...strip.depths };
    let pinned = strip.pinned ? [...strip.pinned] : null;
    let refSeg = strip.refSeg;
    for (const f of fusions) {
      const w1 = widths[f.a];
      const w2 = widths[f.b];
      delete widths[f.a];
      delete widths[f.b];
      if (w1 !== undefined) widths[f.id] = w1;
      else if (w2 !== undefined) widths[f.id] = w2;

      const d1 = depths[f.a];
      const d2 = depths[f.b];
      delete depths[f.a];
      delete depths[f.b];
      if (d1 !== undefined || d2 !== undefined) depths[f.id] = Math.max(d1 ?? 0, d2 ?? 0);

      if (pinned) {
        const wasPinned = pinned.includes(f.a) || pinned.includes(f.b);
        pinned = pinned.filter((id) => id !== f.a && id !== f.b);
        if (wasPinned) pinned.push(f.id);
      }
      if (refSeg === f.a || refSeg === f.b) refSeg = f.id;
    }

    const used = new Set<string>();
    for (const s of segs) {
      used.add(s.a);
      used.add(s.b);
    }
    const keptNodes = nodes.filter((n) => used.has(n.id));
    patch((s) => applyNetwork({ ...s, widths, depths, pinned, refSeg }, keptNodes, segs));
  };

  // A face number spreads over the whole visible run, not just one axis piece.
  const setRunLength = (run: FaceRun, mm: number) => {
    const res = setStripRunLength(strip, run, mm);
    if (!res.ok) {
      setToast(res.reason);
      return;
    }
    if (!strip.entered) window.setTimeout(() => setFitToken((t) => t + 1), 0);
    update((p) => (p.strip ? { ...p, strip: res.strip } : p));
  };

  const setWidth = (segId: string, mm: number) =>
    patch((s) => ({ ...s, widths: { ...s.widths, [segId]: clampW(mm) } }));

  const draw = (ctx: CanvasRenderingContext2D, v: View) => {
    drawGrid(ctx, v);
    const nodes = derived?.nodes ?? rawNodes;
    const outline = derived?.built.outline ?? preview?.outline ?? [];

    // A closed ring has an inner loop, which is a hole rather than more band.
    // All loops go into one path and are filled with the even-odd rule, so the
    // inside of a ring stays empty while the band itself is still highlighted.
    if (outline.length) {
      ctx.beginPath();
      for (const poly of outline) {
        if (poly.length < 2) continue;
        poly.forEach((p, i) => {
          const s = toScreen(p, v);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = C.bandFill;
      ctx.fill('evenodd');
    }
    for (const poly of outline) {
      tracePolygon(ctx, v, poly);
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.bandStroke;
      ctx.stroke();
    }

    // Hand-typed faces stay green on the drawing too, matching their numbers.
    for (const run of runs) {
      if (!sidePins.has(run.key)) continue;
      traceLine(ctx, v, run.a, run.b);
      ctx.strokeStyle = C.ref;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // The number being edited lights its own side of the band, never the axis.
    if (selectedRun) {
      const run = runs.find((r) => r.key === selectedRun);
      if (run) {
        traceLine(ctx, v, run.a, run.b);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 3;
        ctx.setLineDash([7, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (derived && selected) {
      const g = derived.byId.get(selected);
      if (g) {
        traceLine(ctx, v, g.a, g.b);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 3;
        ctx.setLineDash([7, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // centreline
    for (const seg of rawSegs) {
      const a = nodeAt(seg.a, nodes);
      const b = nodeAt(seg.b, nodes);
      if (!a || !b) continue;
      traceLine(ctx, v, worldOf(a), worldOf(b));
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = C.center;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const n of nodes) {
      circle(ctx, toScreen(worldOf(n), v), 4, C.node, C.nodeRing);
    }

    if (selectedNode) {
      const n = nodes.find((x) => x.id === selectedNode);
      if (n) {
        const p = toScreen(worldOf(n), v);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // While the axis is still open, the starting vertex gets a neutral dashed
    // target so it is easy to tap. A closed ring is left unmarked: no colour
    // highlight at all.
    if (chain && chain.start !== chain.end) {
      const start = nodeAt(chain.start, nodes);
      if (start) {
        const p = toScreen(worldOf(start), v);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        ctx.strokeStyle = C.center;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    drawScaleBar(ctx, v);
  };

  // ---------- chips ----------
  // Every label is collected first; dense plans shrink the numbers and hide the
  // ones that would still collide, so the band underneath stays visible.
  type Spec = {
    key: string;
    at: Pt;
    weight: number;
    node: (x: number, y: number, scale: number) => React.ReactNode;
  };
  const specs: Spec[] = [];

  if (derived && stage !== 'outline' && !drafting && mode === 'dims') {
    for (const run of runs) {
      const dx = run.b.x - run.a.x;
      const dy = run.b.y - run.a.y;
      const len = run.len || 1;
      // Point the number away from the band: right of the outline edge. Outer
      // loops keep the band on their left, hole loops on their right, so one
      // rule places both faces on the empty side.
      const nx = dy / len;
      const ny = -dx / len;
      const mid = { x: (run.a.x + run.b.x) / 2, y: (run.a.y + run.b.y) / 2 };
      const off = 24 / view.scale;
      const at = toScreen({ x: mid.x + nx * off, y: mid.y + ny * off }, view);
      const isPinned = sidePins.has(run.key);

      specs.push({
        key: run.key,
        at,
        weight: isPinned ? 3 : run.outer ? 2 : 1.4,
        node: (x, y, scale) => (
          <Chip
            key={run.key}
            x={x}
            y={y}
            scale={scale}
            value={strip.entered ? run.len : null}
            tone={isPinned ? 'pinned' : run.outer ? 'default' : 'muted'}
            compact={!run.outer}
            onCommit={(mm) => setRunLength(run, mm)}
            onRef={strip.entered ? () => patch((s) => toggleStripRunPin(s, run.key)) : undefined}
            onSelect={() => {
              setSelectedRun(run.key);
              setSelected(null);
              setSelectedNode(null);
            }}
            active={selectedRun === run.key}
          />
        ),
      });
    }

    // A custom width gets one small badge on the axis — no extra numbers otherwise.
    for (const g of derived.built.segments) {
      if (strip.widths[g.id] === undefined) continue;
      const mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
      specs.push({
        key: `w${g.id}`,
        at: toScreen(mid, view),
        weight: selected === g.id ? 4 : 2.5,
        node: (x, y, scale) => (
          <Chip
            key={`w${g.id}`}
            x={x}
            y={y}
            scale={scale}
            value={g.width}
            unit=""
            label="↔"
            tone="width"
            editable={false}
            onTap={() => {
              setSelectedNode(null);
              setSelectedRun(null);
              setSelected(g.id);
            }}
            active={selected === g.id}
          />
        ),
      });
    }
  }

  if (derived && stage !== 'outline' && !drafting && mode === 'depth') {
    const segById = new Map(derived.segs.map((seg) => [seg.id, seg]));
    derived.built.segments.forEach((g) => {
      const seg = segById.get(g.id);
      if (!seg) return;
      // One number per edge: sit it on the middle of the band so it is clear
      // which segment it describes and it never falls outside the screen.
      const mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
      const at = toScreen(mid, view);
      const own = strip.depths[g.id] !== undefined;
      specs.push({
        key: `d${g.id}`,
        at,
        weight: own ? 2 : 1,
        node: (x, y, scale) => (
          <Chip
            key={`d${g.id}`}
            x={x}
            y={y}
            scale={scale}
            value={depthOfSeg(strip, seg)}
            tone={own ? 'thickness' : 'muted'}
            active={own}
            onCommit={(mm) =>
              patch((s2) => ({
                ...s2,
                depths: { ...s2.depths, [g.id]: Math.min(5000, Math.max(50, mm)) },
              }))
            }
          />
        ),
      });
    });
  }

  // Labels stay on their geometric spot, so an outer/inner pair near the border
  // never collapses onto the same point. Dense plans shrink the whole set and
  // drop the numbers that still cannot fit instead of covering the band.
  const fit = fitChips(
    specs.map((sp) => sp.at),
    specs.map((sp) => sp.weight),
  );
  const chips = specs.flatMap((sp, i) =>
    fit.visible[i] ? [sp.node(sp.at.x, sp.at.y, fit.scale)] : [],
  );

  const selectedGeom = selected ? derived?.byId.get(selected) ?? null : null;
  const selectedSeg = selected ? strip.segs.find((s) => s.id === selected) ?? null : null;
  const selectedNodeObj = selectedNode
    ? (derived?.nodes ?? rawNodes).find((n) => n.id === selectedNode) ?? null
    : null;
  const nodeArms = selectedNodeObj
    ? rawSegs.filter((s) => s.a === selectedNodeObj.id || s.b === selectedNodeObj.id)
    : [];
  const nodeKind = (() => {
    if (!selectedNodeObj) return '';
    if (nodeArms.length === 1) return 'конец линии';
    if (nodeArms.length === 2) {
      const byId = new Map((derived?.nodes ?? rawNodes).map((n) => [n.id, n]));
      const ends = nodeArms.map((s) => byId.get(s.a === selectedNodeObj.id ? s.b : s.a));
      const [a, b] = ends;
      if (a && b) {
        const ax = a.x - selectedNodeObj.x;
        const ay = a.y - selectedNodeObj.y;
        const bx = b.x - selectedNodeObj.x;
        const by = b.y - selectedNodeObj.y;
        return ax * bx + ay * by < 0 ? 'точка на прямой' : 'угол';
      }
      return 'узел';
    }
    return nodeArms.length > 2 ? 'пересечение' : 'отдельная точка';
  })();

  const subtitle =
    stage === 'outline'
      ? 'рисование оси'
      : drafting
        ? 'добавление линии'
        : mode === 'depth'
          ? 'глубина по отрезкам'
          : 'размеры сторон и ширина';

  const pickTab = (m: 'dims' | 'depth') => {
    setSelected(null);
    setSelectedRun(null);
    setSelectedNode(null);
    setDrafting(false);
    setChain(null);
    setStage(m === 'depth' ? 'depth' : strip.baseNodes ? 'dims' : 'outline');
  };

  return (
    <div className="editor">
      <EditorHeader title={project.name} subtitle={`Лента · ${subtitle}`} onBack={onBack} onInfo={onInfo} onRename={onRename} />
      <div className="canvas-wrap">
        <PlanCanvas view={view} onView={setView} onSize={onSize} draw={draw} onTap={tapCanvas}>
          {chips}
        </PlanCanvas>
        {derived && (
          <VolumeHud
            kind="strip"
            ready={strip.entered}
            volumeMm3={derived.built.volumeMm3 + derived.toothVolumeMm3}
            areaMm2={derived.built.areaMm2}
            avgThickness={strip.baseDepth}
            toothVolumeMm3={derived.toothVolumeMm3}
            strips={{
              center: derived.totalCenter,
              outer: derived.totalOuter,
              inner: derived.totalInner,
            }}
            size={sceneSize}
          />
        )}
      </div>

      <EditorSheet>
        <SheetTabs>
          <Segmented
            value={mode}
            onChange={pickTab}
            options={[
              { value: 'dims', label: 'Контур' },
              { value: 'depth', label: 'Глубина' },
            ]}
          />
        </SheetTabs>

        {mode === 'dims' && stage === 'outline' && (
          <>
            <p className="hint">
              {chain
                ? 'Ведите ось дальше. Тап по вершине соединит с ней, тап по ленте дотянет последний отрезок до её оси без лишних углов; тап по первой точке замкнёт кольцо. Пересечения разрешены — на перекрёстке объём считается один раз.'
                : 'Нажимайте на холст, чтобы вести ось ленты. Тап по готовой вершине или по ленте начнёт ответвление от неё. Лента строится по обе стороны от оси.'}
            </p>
            <div className="row">
              <Btn variant="primary" onClick={finishDrawing} disabled={!rawSegs.length}>
                К размерам
              </Btn>
            </div>
            <div className="row row--tight">
              <Btn onClick={undoPoint} disabled={!canUndo()}>
                Отменить точку
              </Btn>
              <span className="sheet__meta">
                точек: {rawNodes.length} · отрезков: {rawSegs.length}
              </span>
            </div>
          </>
        )}

        {mode === 'dims' && stage !== 'outline' && drafting && (
          <>
            <p className="hint">
              {chain
                ? 'Ведите ось дальше. Тап по вершине соединит с ней, тап по ленте дотянет последний отрезок до её оси без лишних углов; тап по первой точке замкнёт кольцо. Размеры уже заданных участков сохраняются.'
                : 'Нажмите на холст, чтобы добавить новую линию, на готовую вершину или на ленту — чтобы начать ответвление. Готово возвращает к размерам.'}
            </p>
            <div className="row">
              <Btn variant="primary" onClick={finishAdding}>
                Готово
              </Btn>
            </div>
            <div className="row row--tight">
              <Btn onClick={undoPoint} disabled={!canUndo()}>
                Отменить точку
              </Btn>
              <span className="sheet__meta">
                точек: {rawNodes.length} · отрезков: {rawSegs.length}
              </span>
            </div>
          </>
        )}

        {mode === 'dims' && stage !== 'outline' && !drafting && selectedGeom && selectedSeg && (
          <>
            <div className="row row--between">
              <button type="button" className="backlink" onClick={() => setSelected(null)}>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                  <path
                    d="M15 5 8 12l7 7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                К контуру
              </button>
              <div className="sheet__title">Ширина участка</div>
            </div>
            <div className="row row--align-end row--wide-field">
              <NumberField
                label="Ширина"
                value={selectedGeom.width}
                step={50}
                min={50}
                max={4000}
                onChange={(v) => setWidth(selectedSeg.id, v)}
              />
              <Btn onClick={() => patch((s) => ({ ...s, baseWidth: selectedGeom.width, widths: {} }))}>
                Всем
              </Btn>
            </div>
            <div className="sheet__meta">
              ось {fmtLen(selectedGeom.centerLen)} · внешняя {fmtLen(selectedGeom.outerLen)} · внутренняя{' '}
              {fmtLen(selectedGeom.innerLen)} мм
            </div>
            <div className="row">
              <Btn variant="danger" onClick={() => deleteSeg(selectedSeg.id)}>
                Удалить отрезок
              </Btn>
            </div>
          </>
        )}

        {mode === 'dims' && stage !== 'outline' && !drafting && selectedNodeObj && (
          <>
            <div className="row row--between">
              <button type="button" className="backlink" onClick={() => setSelectedNode(null)}>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                  <path
                    d="M15 5 8 12l7 7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                К контуру
              </button>
              <div className="sheet__title">Вершина</div>
            </div>
            <div className="row row--tight">
              <span className="sheet__meta">
                {nodeKind} · отрезков: {nodeArms.length}
              </span>
            </div>
            <p className="hint">
              Точка на прямой убирается без следа, угол — вместе со своими отрезками, а ответвление
              удаляется вместе с точкой; линия, проходящая насквозь, остаётся целой.
            </p>
            <div className="row">
              <Btn variant="danger" onClick={() => deleteNode(selectedNodeObj.id)}>
                Удалить точку
              </Btn>
            </div>
          </>
        )}

        {mode === 'dims' && stage !== 'outline' && !drafting && !selectedGeom && !selectedNodeObj && (
          <>
            <p className="hint">
              Числа стоят на <b>сторонах ленты</b>, а не на оси: у внешней и внутренней стороны
              свои размеры. Прямая стена, разбитая перегородками, сохраняет один общий размер с той
              стороны, где её ничто не перерезает. Введённое число <b>закрепляется</b> (зелёное);
              свободные участки подстраиваются, углы остаются прямыми. <b>Долгое нажатие</b> на
              число закрепляет или освобождает эту сторону. Тап по ленте открывает ширину участка,
              тап по вершине — её удаление.
            </p>
            <NumberField
              label="Ширина ленты по умолчанию"
              value={strip.baseWidth}
              step={50}
              min={50}
              max={4000}
              onChange={(v) => patch((s) => ({ ...s, baseWidth: clampW(v) }))}
            />
            <div className="row">
              <Btn onClick={beginAdd}>Добавить линию</Btn>
            </div>
            <div className="row">
              <Btn variant="danger" onClick={() => setAskRedraw(true)}>
                Очистить холст
              </Btn>
            </div>
            {!strip.entered && (
              <div className="sheet__meta">Введите хотя бы один размер, чтобы задать масштаб.</div>
            )}
          </>
        )}

        {mode === 'depth' && !strip.baseNodes && (
          <p className="hint">
            Сначала проведите ось ленты на вкладке <b>Контур</b> — глубину можно задать в любой
            момент после этого.
          </p>
        )}

        {mode === 'depth' && strip.baseNodes && (
          <>
            <NumberField
              label="Глубина ленты"
              value={strip.baseDepth}
              step={50}
              min={50}
              max={5000}
              onChange={(v) => patch((s) => ({ ...s, baseDepth: v }))}
            />
            <Switch
              label="Зуб отмостки"
              hint="Утолщённый край по внешнему контуру ленты"
              checked={strip.tooth}
              onChange={(v) => patch((s) => ({ ...s, tooth: v }))}
            />
            {strip.tooth && (
              <>
                <div className="row">
                  <NumberField
                    label="Ширина зуба"
                    value={strip.toothWidth}
                    step={10}
                    min={20}
                    max={2000}
                    onChange={(v) =>
                      patch((s) => ({
                        ...s,
                        toothWidth: Math.min(2000, Math.max(20, v)),
                      }))
                    }
                  />
                  <NumberField
                    label="Глубина зуба"
                    value={strip.toothDepth}
                    step={10}
                    min={10}
                    max={3000}
                    onChange={(v) =>
                      patch((s) => ({
                        ...s,
                        toothDepth: Math.min(3000, Math.max(10, v)),
                      }))
                    }
                  />
                </div>
                <p className="hint">
                  Зуб идёт только по внешнему контуру: его наружный край совпадает с лентой,
                  внутренний отступает на ширину зуба. Объём зуба прибавляется к объёму ленты.
                  {derived && derived.toothAreaMm2 > 0 && (
                    <>
                      {' '}
                      Площадь зуба {fmtM2(derived.toothAreaMm2)} м² · объём{' '}
                      {fmtM3(derived.toothVolumeMm3)} м³.
                    </>
                  )}
                </p>
              </>
            )}
            <p className="hint">
              Нажмите на число у отрезка, чтобы задать глубину этого участка — объём считается по
              каждому ребру отдельно. Остальные участки продолжают использовать общую глубину.
            </p>
          </>
        )}
      </EditorSheet>

      {askRedraw && (
        <ConfirmDialog
          title="Очистить холст?"
          text="Все точки, отрезки, введённые размеры и закрепления будут стёрты. Отменить это действие нельзя."
          confirmLabel="Очистить"
          danger
          onCancel={() => setAskRedraw(false)}
          onConfirm={() => {
            setAskRedraw(false);
            setSelectedRun(null);
            redraw();
          }}
        />
      )}

      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

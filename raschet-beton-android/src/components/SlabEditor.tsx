import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SlabState, Stage } from '../state/types';
import {
  addSlabContour,
  appendSlabPoint,
  cancelSlabContour,
  closeSlabContour,
  CONTOUR_CROSS_TEXT,
  contourPoly,
  deriveSlab,
  pinnedEdges,
  removeSlabContour,
  resetSlab,
  setSlabContourOffset,
  setSlabEdgeLength,
  slabBounds,
  slabPlacements,
  SLAB_MAX_LEN,
  toggleSlabPin,
  undoSlabPoint,
  type SlabEdge,
} from '../state/derive';
import { orthoSnap } from '../geometry/ortho';
import {
  boundsOf,
  dist,
  distToSegment,
  pointInPolygon,
  segmentsIntersect,
  type Pt,
  type Rect,
} from '../geometry/vec';
import { contoursProperlyCross } from '../geometry/slab';
import { MIN_SCALE, fitView, project as toScreen, type View } from '../lib/view';
import { fitChips } from '../lib/layout';
import { fmtM2, fmtMm } from '../lib/format';
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
  Toast,
  VolumeHud,
} from './ui';
import { C, circle, drawGrid, drawScaleBar, outwardNormal, traceLine, tracePolygon } from './draw';

const DEFAULT_BOUNDS: Rect = { x0: -600, y0: -600, x1: 600, y1: 600 };

/** Contour, thickness and — once there are several contours — offsets. */
type Mode = 'dims' | 'depth' | 'offset';

const modeOfStage = (s: Stage): Mode =>
  s === 'depth' ? 'depth' : s === 'offset' ? 'offset' : 'dims';

type Props = {
  project: Project;
  update: (fn: (p: Project) => Project) => void;
  onBack: () => void;
  onInfo: () => void;
  onRename: () => void;
};

/** A tappable offset number drawn on the canvas, tied to a field in the sheet. */
type OffsetHit = {
  id: string;
  field: 'gapX' | 'gapY' | 'left' | 'right' | 'top' | 'bottom';
  x: number;
  y: number;
  w: number;
  h: number;
};

export function SlabEditor({ project, update, onBack, onInfo, onRename }: Props) {
  const slab = project.slab;
  const stage = project.stage;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ cx: 0, cy: 0, scale: 1, w: 0, h: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [askReset, setAskReset] = useState(false);
  const [mode, setMode] = useState<Mode>(modeOfStage(stage));
  const [fitToken, setFitToken] = useState(0);
  const didFit = useRef(false);

  // Switching tabs must not re-frame the drawing — only follow the stored mode.
  useEffect(() => {
    setMode(modeOfStage(stage));
  }, [stage]);

  const derived = useMemo(() => (slab ? deriveSlab(slab) : null), [slab]);
  const bounds = useMemo(() => (slab ? slabBounds(slab) : null), [slab]);
  const sceneSize = useMemo(
    () => (bounds && slab?.entered ? { w: bounds.x1 - bounds.x0, h: bounds.y1 - bounds.y0 } : null),
    [bounds, slab?.entered],
  );
  const draft = useMemo(() => slab?.contours.find((c) => !c.base) ?? null, [slab]);
  const closedCount = slab ? slab.contours.filter((c) => c.base).length : 0;
  // Offsets only make sense between contours; with one surface the tab disappears.
  const activeMode: Mode = mode === 'offset' && closedCount < 2 ? 'dims' : mode;
  const placements = useMemo(() => (slab ? slabPlacements(slab) : []), [slab]);

  // Screen positions of the offset numbers, filled while the canvas paints so a
  // tap can find the field that owns the number.
  const offsetHits = useRef<OffsetHit[]>([]);
  const [sheetExpand, setSheetExpand] = useState(0);

  const pinnedByContour = useMemo(() => {
    const map = new Map<string, Set<number>>();
    for (const c of slab?.contours ?? []) map.set(c.id, pinnedEdges(c));
    return map;
  }, [slab]);

  const onSize = useCallback((w: number, h: number) => {
    setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
  }, []);

  const boundsRef = useRef<Rect | null>(null);
  boundsRef.current = bounds;

  // The sheet grows and shrinks as hints change — never re-frame the drawing then,
  // only update the canvas size so taps keep landing where the user expects.
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

  // only an explicit stage change re-fits the view; layout changes keep the top-left anchored
  useEffect(() => {
    if (!fitToken) return;
    const s = sizeRef.current;
    if (!s.w || !s.h) return;
    setView(fitView(boundsRef.current ?? DEFAULT_BOUNDS, s.w, s.h));
  }, [fitToken]);

  const patch = (fn: (s: SlabState) => SlabState) =>
    update((p) => (p.slab ? { ...p, slab: fn(p.slab) } : p));

  const setStage = (s: Stage) => update((p) => ({ ...p, stage: s }));

  // Contour, offsets and thickness are parallel tabs, not sequential steps: all are
  // always reachable and the active one is stored with the project.
  const pickMode = (m: Mode) => {
    setMode(m);
    setStage(m);
  };

  const closeOutline = () => {
    if (!slab || !draft) return;
    const minDist = Math.max(1, 7 / Math.max(view.scale, 0.01));
    const res = closeSlabContour(slab, minDist);
    if (!res.ok) {
      setToast(res.reason);
      return;
    }
    patch(() => res.slab);
    setStage('dims');
    if (navigator.vibrate) navigator.vibrate(18);
  };

  const addPoint = (screen: Pt, world: Pt) => {
    if (!slab || activeMode !== 'dims') return;
    const raw = draft?.raw ?? [];
    if (draft && raw.length >= 3 && dist(screen, toScreen(raw[0], view)) < 22) {
      closeOutline();
      return;
    }
    const snapped = orthoSnap(raw[raw.length - 1] ?? null, world);
    if (raw.length && dist(raw[raw.length - 1], snapped) * view.scale < 8) return;

    if (raw.length >= 2) {
      const last = raw[raw.length - 1];
      for (let i = 0; i < raw.length - 2; i++) {
        if (segmentsIntersect(raw[i], raw[(i + 1) % raw.length], last, snapped)) {
          setToast('Так контур пересечётся сам с собой — поставьте точку в стороне.');
          return;
        }
      }
    }

    // A new contour may touch a closed neighbour (zero offset is valid) but must
    // not cut through it. This is checked for every new point, so the alert
    // appears at the first crossing while drawing, not only on closing. It also
    // keeps the side the drawing started on: outside stays outside, inside
    // stays inside.
    if (raw.length) {
      const from = raw[raw.length - 1];
      const start = raw[0];
      const tol = Math.max(0.5, 2 / Math.max(view.scale, 0.01));
      const onBoundary = (p: Pt, poly: Pt[]) =>
        poly.some((q, i) => distToSegment(p, q, poly[(i + 1) % poly.length]) <= tol);
      for (const c of slab.contours) {
        if (!c.base) continue;
        const poly = contourPoly(c);
        if (!poly || poly.length < 3) continue;
        if (contoursProperlyCross([from, snapped], poly)) {
          setToast(CONTOUR_CROSS_TEXT);
          return;
        }
        // Slipping exactly through a corner is not a proper crossing, but it
        // still changes the side of the boundary.
        if (
          !onBoundary(start, poly) &&
          !onBoundary(snapped, poly) &&
          pointInPolygon(start, poly) !== pointInPolygon(snapped, poly)
        ) {
          setToast(CONTOUR_CROSS_TEXT);
          return;
        }
      }
    }

    patch((s) => appendSlabPoint(s, snapped));
  };

  const startContour = () => {
    // Without a single real length there is no millimetre scale, so any new
    // contour would get meaningless sizes. Make the user set the main outline first.
    if (!slab?.entered) {
      setToast('Сначала введите длину любой стороны главного контура — она задаст масштаб.');
      return;
    }
    patch(addSlabContour);
    // Step back a little so there is room around the slab for an outside contour.
    setView((v) => ({ ...v, scale: Math.max(MIN_SCALE, v.scale * 0.7) }));
  };

  const undoPoint = () => patch(undoSlabPoint);
  const cancelDraft = () => {
    patch(cancelSlabContour);
    setStage('outline');
  };
  const resetOutline = () => {
    patch(resetSlab);
    setStage('outline');
  };

  const setLength = (contourId: string, i: number, mm: number) => {
    if (!slab) return;
    const wasEntered = slab.entered;
    const res = setSlabEdgeLength(slab, contourId, i, mm);
    if (!res.ok) {
      setToast(res.reason);
      return;
    }
    // The first value turns sketch units into millimetres — re-frame once so the
    // drawing stays on screen at its real size.
    if (!wasEntered) window.setTimeout(() => setFitToken((t) => t + 1), 0);
    patch(() => res.slab);
  };

  const togglePin = (contourId: string, i: number) =>
    patch((s) => toggleSlabPin(s, contourId, i));

  const setOffset = (
    contourId: string,
    next: {
      dx?: number;
      dy?: number;
      left?: number;
      right?: number;
      top?: number;
      bottom?: number;
      gapX?: number;
      gapY?: number;
    },
  ) => {
    if (!slab) return;
    const res = setSlabContourOffset(slab, contourId, next);
    if (!res.ok) {
      setToast(res.reason);
      return;
    }
    patch(() => res.slab);
  };

  /** Reveals the field behind a tapped offset number: unfold, scroll, flash. */
  const focusOffsetField = (hit: OffsetHit) => {
    setSheetExpand((n) => n + 1);
    window.setTimeout(() => {
      const key = `${hit.id}:${hit.field}`;
      const el = [...document.querySelectorAll<HTMLElement>('[data-offset-field]')].find(
        (node) => node.dataset.offsetField === key,
      );
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
      window.setTimeout(() => el.classList.remove('is-flash'), 1500);
    }, 90);
  };

  const tapOffsetLabel = (screen: Pt) => {
    const hit = offsetHits.current.find(
      (h) =>
        Math.abs(screen.x - h.x) <= h.w / 2 + 6 && Math.abs(screen.y - h.y) <= h.h / 2 + 6,
    );
    if (hit) focusOffsetField(hit);
  };

  const setVertexThickness = (contourId: string, i: number, mm: number) => {
    patch((s) => ({
      ...s,
      contours: s.contours.map((c) => {
        if (c.id !== contourId) return c;
        const arr = c.vThickness.slice();
        while (arr.length < (c.base?.length ?? 0)) arr.push(null);
        arr[i] = Math.min(5000, Math.max(20, mm));
        return { ...c, vThickness: arr };
      }),
    }));
  };

  const draw = (ctx: CanvasRenderingContext2D, v: View) => {
    drawGrid(ctx, v);
    if (!slab) return;

    if (derived) {
      // Outer contours first, then the voids cut into them, then islands inside voids.
      const ordered = [...derived.parts].sort((a, b) => a.depth - b.depth);
      for (const part of ordered) {
        tracePolygon(ctx, v, part.poly);
        ctx.fillStyle = part.role === 'hole' ? C.bg : C.slabFill;
        ctx.fill();
        ctx.save();
        ctx.setLineDash(part.role === 'hole' ? [7, 5] : []);
        ctx.lineWidth = part.role === 'hole' ? 1.5 : 2;
        ctx.strokeStyle = part.role === 'hole' ? C.ghost : C.slabStroke;
        ctx.stroke();
        ctx.restore();
      }

      for (const part of derived.parts) {
        // Pinned (hand-typed) sides stay green, matching their numbers.
        for (const i of pinnedByContour.get(part.id) ?? []) {
          const e = part.edges[i];
          if (!e) continue;
          traceLine(ctx, v, e.a, e.b);
          ctx.strokeStyle = C.ref;
          ctx.lineWidth = 4;
          ctx.stroke();
        }
        for (const p of part.poly) circle(ctx, toScreen(p, v), 4.5, C.node, C.nodeRing);
      }

      if (activeMode === 'offset') {
        offsetHits.current = [];
        const byId = new Map(derived.parts.map((p) => [p.id, p.poly]));
        const text = (
          label: string,
          at: Pt,
          owner?: { id: string; field: OffsetHit['field'] },
        ) => {
          ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
          const w = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(11,15,20,0.86)';
          ctx.fillRect(at.x - w / 2 - 5, at.y - 8, w + 10, 16);
          ctx.fillStyle = C.text;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, at.x, at.y);
          if (owner) {
            offsetHits.current.push({ ...owner, x: at.x, y: at.y, w: w + 10, h: 16 });
          }
        };
        for (const row of placements) {
          if (!row.refId) continue;
          const refPoly = byId.get(row.refId);
          const childPoly = byId.get(row.id);
          if (!refPoly || !childPoly) continue;
          const rb = boundsOf(refPoly);
          const cb = boundsOf(childPoly);

          tracePolygon(ctx, v, [
            { x: cb.x0, y: cb.y0 },
            { x: cb.x1, y: cb.y0 },
            { x: cb.x1, y: cb.y1 },
            { x: cb.x0, y: cb.y1 },
          ]);
          ctx.save();
          ctx.setLineDash([5, 5]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(234,240,247,0.32)';
          ctx.stroke();
          ctx.restore();

          // Dimension lines on all four sides of the reference box. Editing any
          // one of them moves the contour; the opposite value is recalculated.
          ctx.strokeStyle = C.ref;
          ctx.lineWidth = 1.5;
          const dim = (p: Pt, q: Pt) => {
            const a = toScreen(p, v);
            const b = toScreen(q, v);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            return { a, b };
          };
          const labelWidth = (label: string) => {
            ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
            return ctx.measureText(label).width;
          };

          const commonMid = (a0: number, a1: number, b0: number, b1: number) => {
            const lo = Math.max(a0, b0);
            const hi = Math.min(a1, b1);
            return lo <= hi ? (lo + hi) / 2 : (a0 + a1 + b0 + b1) / 4;
          };

          if (row.mode === 'gaps') {
            // External added contour: a gap between the facing edges, plus the
            // distances between the parallel edge planes when the contours
            // overlap along the other axis (three numbers side by side, two
            // diagonally). A real zero is only drawn when the edges are flush.
            const extLeft = cb.x1 <= rb.x0;
            const extAbove = cb.y1 <= rb.y0;

            if ((row.gapAxis === 'x' || row.gapAxis === 'both') && row.gapX > 0.5) {
              const y = commonMid(cb.y0, cb.y1, rb.y0, rb.y1);
              const line = extLeft
                ? dim({ x: cb.x1, y }, { x: rb.x0, y })
                : dim({ x: rb.x1, y }, { x: cb.x0, y });
              text(
                fmtMm(row.gapX),
                {
                  x: (line.a.x + line.b.x) / 2,
                  y: line.b.y - 13,
                },
                { id: row.id, field: 'gapX' },
              );
            }

            if ((row.gapAxis === 'y' || row.gapAxis === 'both') && row.gapY > 0.5) {
              const x = commonMid(cb.x0, cb.x1, rb.x0, rb.x1);
              const line = extAbove
                ? dim({ x, y: cb.y1 }, { x, y: rb.y0 })
                : dim({ x, y: rb.y1 }, { x, y: cb.y0 });
              text(
                fmtMm(row.gapY),
                {
                  x: line.b.x + 4 + labelWidth(fmtMm(row.gapY)) / 2,
                  y: (line.a.y + line.b.y) / 2,
                },
                { id: row.id, field: 'gapY' },
              );
            }

            if (row.gapAxis === 'x') {
              // Contour is beside the slab: show where it sits between the
              // slab's top and bottom edge planes.
              const x = extLeft ? cb.x1 : cb.x0;
              if (Math.abs(cb.y0 - rb.y0) > 0.5) {
                const line = dim({ x, y: rb.y0 }, { x, y: cb.y0 });
                text(
                  fmtMm(row.top),
                  {
                    x: line.b.x + 4 + labelWidth(fmtMm(row.top)) / 2,
                    y: (line.a.y + line.b.y) / 2,
                  },
                  { id: row.id, field: 'top' },
                );
              }
              if (Math.abs(cb.y1 - rb.y1) > 0.5) {
                const line = dim({ x, y: cb.y1 }, { x, y: rb.y1 });
                text(
                  fmtMm(row.bottom),
                  {
                    x: line.b.x + 4 + labelWidth(fmtMm(row.bottom)) / 2,
                    y: (line.a.y + line.b.y) / 2,
                  },
                  { id: row.id, field: 'bottom' },
                );
              }
            }

            if (row.gapAxis === 'y') {
              // Contour is above/below the slab: show its left/right alignment.
              const y = extAbove ? cb.y1 : cb.y0;
              if (Math.abs(cb.x0 - rb.x0) > 0.5) {
                const line = dim({ x: rb.x0, y }, { x: cb.x0, y });
                text(
                  fmtMm(row.left),
                  {
                    x: (line.a.x + line.b.x) / 2,
                    y: line.b.y - 13,
                  },
                  { id: row.id, field: 'left' },
                );
              }
              if (Math.abs(cb.x1 - rb.x1) > 0.5) {
                const line = dim({ x: cb.x1, y }, { x: rb.x1, y });
                text(
                  fmtMm(row.right),
                  {
                    x: (line.a.x + line.b.x) / 2,
                    y: line.b.y - 13,
                  },
                  { id: row.id, field: 'right' },
                );
              }
            }
          } else {
            const left = dim({ x: rb.x0, y: cb.y0 }, { x: cb.x0, y: cb.y0 });
            if (Math.abs(left.a.x - left.b.x) > 34) {
              text(
                fmtMm(row.left),
                { x: (left.a.x + left.b.x) / 2, y: left.b.y - 13 },
                { id: row.id, field: 'left' },
              );
            }

            const right = dim({ x: cb.x1, y: cb.y0 }, { x: rb.x1, y: cb.y0 });
            if (Math.abs(right.a.x - right.b.x) > 34) {
              text(
                fmtMm(row.right),
                { x: (right.a.x + right.b.x) / 2, y: right.b.y - 13 },
                { id: row.id, field: 'right' },
              );
            }

            const top = dim({ x: cb.x0, y: rb.y0 }, { x: cb.x0, y: cb.y0 });
            if (Math.abs(top.a.y - top.b.y) > 34) {
              text(
                fmtMm(row.top),
                {
                  x: top.b.x + 4 + labelWidth(fmtMm(row.top)) / 2,
                  y: (top.a.y + top.b.y) / 2,
                },
                { id: row.id, field: 'top' },
              );
            }

            const bottom = dim({ x: cb.x0, y: cb.y1 }, { x: cb.x0, y: rb.y1 });
            if (Math.abs(bottom.a.y - bottom.b.y) > 34) {
              text(
                fmtMm(row.bottom),
                {
                  x: bottom.b.x + 4 + labelWidth(fmtMm(row.bottom)) / 2,
                  y: (bottom.a.y + bottom.b.y) / 2,
                },
                { id: row.id, field: 'bottom' },
              );
            }
          }
        }
      }
    }

    for (const c of slab.contours) {
      if (c.base || !c.raw.length) continue;
      const pts = c.raw.map((p) => toScreen(p, v));
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.strokeStyle = C.raw;
      ctx.lineWidth = 2;
      ctx.stroke();

      if (pts.length >= 3) {
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.lineTo(pts[0].x, pts[0].y);
        ctx.strokeStyle = C.ghost;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        circle(ctx, pts[0], 11, 'rgba(255,122,47,0.18)', C.slabStroke);
        circle(ctx, pts[0], 4, C.node);
      }

      for (const p of pts) circle(ctx, p, 4, C.node, C.nodeRing);
    }

    drawScaleBar(ctx, v);
  };

  if (!slab) return null;

  const contourById = new Map(slab.contours.map((c) => [c.id, c]));
  const edgeChips: React.ReactNode[] = [];
  const vertexChips: React.ReactNode[] = [];

  // While a new contour is being drawn the existing numbers would swallow taps, so
  // they step aside until the contour is closed.
  if (derived && activeMode === 'dims' && !draft) {
    const anchors: Pt[] = [];
    const items: { contourId: string; edge: SlabEdge; entered: boolean; pinned: boolean }[] = [];
    for (const part of derived.parts) {
      for (const e of part.edges) {
        const n = outwardNormal(part.poly, e.index, (p) => pointInPolygon(p, part.poly));
        const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
        anchors.push(
          toScreen(
            { x: mid.x + (n.x * 30) / view.scale, y: mid.y + (n.y * 30) / view.scale },
            view,
          ),
        );
        items.push({
          contourId: part.id,
          edge: e,
          entered: !!contourById.get(part.id)?.entered,
          pinned: pinnedByContour.get(part.id)?.has(e.index) ?? false,
        });
      }
    }
    // Labels stay on their geometric spot: no snapping to the screen edge, so
    // a number keeps following its own side when the contour is panned out of
    // view instead of piling up on the border away from the edge it describes.
    // Tight plans shrink the numbers and finally hide the ones that cannot fit.
    const fit = fitChips(
      anchors,
      items.map((it) => (it.pinned ? 3 : it.entered ? 2 : 1)),
    );
    items.forEach(({ contourId, edge, entered, pinned }, k) => {
      if (!fit.visible[k]) return;
      edgeChips.push(
        <Chip
          key={`${contourId}-e${edge.index}`}
          x={anchors[k].x}
          y={anchors[k].y}
          scale={fit.scale}
          value={entered ? edge.len : null}
          tone={entered && pinned ? 'pinned' : 'default'}
          onCommit={(mm) => setLength(contourId, edge.index, mm)}
          // before the first number there is nothing to lock yet
          onRef={entered ? () => togglePin(contourId, edge.index) : undefined}
        />,
      );
    });
  } else if (derived && activeMode === 'depth' && !draft) {
    const anchors: Pt[] = [];
    const items: {
      contourId: string;
      index: number;
      thickness: number;
      overridden: boolean;
    }[] = [];
    for (const part of derived.parts) {
      const center = part.poly.reduce(
        (acc, p) => ({ x: acc.x + p.x / part.poly.length, y: acc.y + p.y / part.poly.length }),
        { x: 0, y: 0 },
      );
      const c = contourById.get(part.id);
      part.poly.forEach((p, i) => {
        const dx = p.x - center.x;
        const dy = p.y - center.y;
        const len = Math.hypot(dx, dy) || 1;
        anchors.push(
          toScreen(
            { x: p.x + (dx / len) * (26 / view.scale), y: p.y + (dy / len) * (26 / view.scale) },
            view,
          ),
        );
        items.push({
          contourId: part.id,
          index: i,
          thickness: part.thickness[i],
          overridden: c?.vThickness[i] != null,
        });
      });
    }
    const fit = fitChips(
      anchors,
      items.map((it) => (it.overridden ? 2 : 1)),
    );
    items.forEach((item, k) => {
      if (!fit.visible[k]) return;
      vertexChips.push(
        <Chip
          key={`${item.contourId}-v${item.index}`}
          x={anchors[k].x}
          y={anchors[k].y}
          scale={fit.scale}
          value={item.thickness}
          tone={item.overridden ? 'thickness' : 'muted'}
          active={item.overridden}
          unit="мм"
          onCommit={(mm) => setVertexThickness(item.contourId, item.index, mm)}
          onRef={() => setVertexThickness(item.contourId, item.index, slab.thickness)}
        />,
      );
    });
  }

  const tabs: { value: Mode; label: string }[] =
    closedCount > 1
      ? [
          { value: 'dims', label: 'Контур' },
          { value: 'offset', label: 'Отступы' },
          { value: 'depth', label: 'Толщина' },
        ]
      : [
          { value: 'dims', label: 'Контур' },
          { value: 'depth', label: 'Толщина' },
        ];

  const subtitle =
    activeMode === 'offset'
      ? 'положение контуров'
      : activeMode === 'depth'
      ? 'толщина по вершинам'
      : draft
        ? 'новый контур'
        : closedCount === 0
          ? 'рисование контура'
          : closedCount > 1
            ? `контуров: ${closedCount}`
            : 'размеры сторон';

  return (
    <div className="editor">
      <EditorHeader title={project.name} subtitle={`Плита · ${subtitle}`} onBack={onBack} onInfo={onInfo} onRename={onRename} />
      <div className="canvas-wrap">
        <PlanCanvas
          view={view}
          onView={setView}
          onSize={onSize}
          draw={draw}
          onTap={
            activeMode === 'offset'
              ? tapOffsetLabel
              : activeMode === 'dims' && (draft || slab.contours.length === 0)
                ? addPoint
                : undefined
          }
        >
          {edgeChips}
          {vertexChips}
        </PlanCanvas>
        {derived && (
          <VolumeHud
            kind="slab"
            ready={slab.entered}
            volumeMm3={derived.metrics.volumeMm3}
            areaMm2={derived.metrics.areaMm2}
            avgThickness={derived.metrics.avgThickness}
            size={sceneSize}
          />
        )}
      </div>

      <EditorSheet expandSignal={sheetExpand}>
        <SheetTabs>
          <Segmented value={activeMode} onChange={pickMode} options={tabs} />
        </SheetTabs>

        {activeMode === 'dims' && slab.contours.length === 0 && (
          <p className="hint">
            Нажимайте на холст — это углы плиты. Чтобы замкнуть контур, нажмите на{' '}
            <b>первую точку</b>. Форма может быть любой, лишь бы без самопересечений.
          </p>
        )}

        {activeMode === 'dims' && draft && (
          <>
            <p className="hint">
              {closedCount > 0 && (
                <>
                  Новый контур: проведёте его <b>снаружи</b> — объём прибавится,{' '}
                  <b>внутри</b> плиты — станет выемкой.{' '}
                </>
              )}
              Нажимайте на холст — это углы. Замкните, нажав <b>первую точку</b>: после трёх
              углов четвёртый достроится сам.
            </p>
            <div className="row">
              <Btn onClick={undoPoint} disabled={!draft.raw.length}>
                Отменить точку
              </Btn>
            </div>
            <div className="row">
              <Btn variant="soft" onClick={cancelDraft}>
                Не рисовать
              </Btn>
            </div>
            <div className="sheet__meta">Точек: {draft.raw.length} · масштаб — двумя пальцами</div>
          </>
        )}

        {activeMode === 'dims' && !draft && closedCount > 0 && (
          <>
            <p className="hint">
              Введённое число <b>закрепляется</b> (зелёное) и больше не меняется само. Остальные
              стороны подстраиваются, углы остаются прямыми. Если одна из двух соседних
              перпендикулярных сторон закреплена зелёным, она <b>остаётся на месте</b> — сдвигается
              только противоположная; если закреплены обе или ни одной, изменение делится поровну.{' '}
              <b>Долгое нажатие</b> на число закрепляет или освобождает сторону.
            </p>
            <div className="row">
              <Btn variant="primary" onClick={startContour} disabled={!slab.entered}>
                Добавить контур
              </Btn>
            </div>
            <div className="parts">
              {derived?.parts.map((part, i) => (
                <div className="part" key={part.id}>
                  <span className={`part__sign${part.role === 'hole' ? ' is-hole' : ''}`}>
                    {part.role === 'hole' ? '−' : '+'}
                  </span>
                  <span className="part__body">
                    <span className="part__name">Контур {i + 1}</span>
                    <span className="part__meta">
                      {part.edges.length} сторон · {fmtM2(part.metrics.areaMm2)} м² ·{' '}
                      {part.role === 'hole' ? 'вычитается' : 'прибавляется'}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="part__del"
                    aria-label={`Удалить контур ${i + 1}`}
                    onClick={() => patch((s) => removeSlabContour(s, part.id))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            {!slab.entered && (
              <div className="sheet__meta">
                Сначала введите хотя бы один размер, чтобы задать масштаб.
              </div>
            )}
            <div className="row">
              <Btn variant="danger" onClick={() => setAskReset(true)}>
                Очистить холст
              </Btn>
            </div>
          </>
        )}

        {activeMode === 'offset' && (
          <>
            <p className="hint">
              У выемок и островов отступы считаются от <b>четырёх сторон</b> родительского контура:
              при изменении одной стороны противоположная пересчитывается сама. У внешнего
              добавочного контура показываются только <b>реальные расстояния</b> до главного:
              зазор между обращёнными гранями и — если по другой оси контуры перекрываются —
              расстояния между их параллельными гранями сверху и снизу (или слева и справа).
              Поэтому у контура сбоку видно три числа, у диагонального — два. Отрицательных
              значений нет, а нулевой отступ разрешён: контур просто примыкает к грани. Контур
              сдвигается целиком, его размеры не меняются.
            </p>
            {!slab.entered ? (
              <div className="sheet__meta">
                Сначала введите длину любой стороны на вкладке «Контур».
              </div>
            ) : (
              <div className="places">
                {placements
                  .filter((p) => p.refId)
                  .map((p) => (
                    <div className="place" key={p.id}>
                      <div className="place__head">
                        <span className={`part__sign${p.role === 'hole' ? ' is-hole' : ''}`}>
                          {p.role === 'hole' ? '−' : '+'}
                        </span>
                        <span className="place__name">Контур {p.label}</span>
                        <span className="place__ref">
                          {p.mode === 'gaps' ? 'до контура' : 'от контура'} {p.refLabel}
                        </span>
                      </div>
                      {p.mode === 'gaps' && p.gapAxis === 'both' && (
                        <div className="row">
                          <NumberField
                            label="Зазор X"
                            value={p.gapX}
                            fieldKey={`${p.id}:gapX`}
                            min={0}
                            max={SLAB_MAX_LEN}
                            onChange={(mm) => setOffset(p.id, { gapX: mm })}
                          />
                          <NumberField
                            label="Зазор Y"
                            value={p.gapY}
                            fieldKey={`${p.id}:gapY`}
                            min={0}
                            max={SLAB_MAX_LEN}
                            onChange={(mm) => setOffset(p.id, { gapY: mm })}
                          />
                        </div>
                      )}

                      {p.mode === 'gaps' && p.gapAxis === 'x' && (
                        <>
                          <div className="row">
                            <NumberField
                              label="Зазор X"
                              value={p.gapX}
                              fieldKey={`${p.id}:gapX`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { gapX: mm })}
                            />
                            <NumberField
                              label="Сверху"
                              value={p.top}
                              fieldKey={`${p.id}:top`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { top: mm })}
                            />
                          </div>
                          <div className="row">
                            <NumberField
                              label="Снизу"
                              value={p.bottom}
                              fieldKey={`${p.id}:bottom`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { bottom: mm })}
                            />
                          </div>
                        </>
                      )}

                      {p.mode === 'gaps' && p.gapAxis === 'y' && (
                        <>
                          <div className="row">
                            <NumberField
                              label="Зазор Y"
                              value={p.gapY}
                              fieldKey={`${p.id}:gapY`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { gapY: mm })}
                            />
                            <NumberField
                              label="Слева"
                              value={p.left}
                              fieldKey={`${p.id}:left`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { left: mm })}
                            />
                          </div>
                          <div className="row">
                            <NumberField
                              label="Справа"
                              value={p.right}
                              fieldKey={`${p.id}:right`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { right: mm })}
                            />
                          </div>
                        </>
                      )}

                      {p.mode === 'sides' && (
                        <>
                          <div className="row">
                            <NumberField
                              label="Слева"
                              value={p.left}
                              fieldKey={`${p.id}:left`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { left: mm })}
                            />
                            <NumberField
                              label="Справа"
                              value={p.right}
                              fieldKey={`${p.id}:right`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { right: mm })}
                            />
                          </div>
                          <div className="row">
                            <NumberField
                              label="Сверху"
                              value={p.top}
                              fieldKey={`${p.id}:top`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { top: mm })}
                            />
                            <NumberField
                              label="Снизу"
                              value={p.bottom}
                              fieldKey={`${p.id}:bottom`}
                              min={0}
                              max={SLAB_MAX_LEN}
                              onChange={(mm) => setOffset(p.id, { bottom: mm })}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                <div className="sheet__meta">
                  Контур сдвигается целиком: стороны, углы и толщины остаются как были.
                </div>
              </div>
            )}
          </>
        )}

        {activeMode === 'depth' && closedCount === 0 && (
          <p className="hint">
            Сначала замкните контур на вкладке <b>Контур</b> — толщину можно задать в любой момент
            после этого.
          </p>
        )}

        {activeMode === 'depth' && closedCount > 0 && (
          <>
            <NumberField
              label="Толщина плиты"
              value={slab.thickness}
              step={10}
              onChange={(mm) => patch((s) => ({ ...s, thickness: mm }))}
            />
            <p className="hint">
              Нажмите на число у вершины, чтобы задать толщину в этой точке — так считается плита с
              уклоном. Вершины выемок тоже редактируются. Долгое нажатие сбрасывает к общей толщине.
            </p>
          </>
        )}
      </EditorSheet>

      {askReset && (
        <ConfirmDialog
          title="Очистить плиту?"
          text="Все контуры, размеры, толщины и закрепления будут стёрты. Отменить это действие нельзя."
          confirmLabel="Очистить"
          danger
          onCancel={() => setAskReset(false)}
          onConfirm={() => {
            setAskReset(false);
            resetOutline();
          }}
        />
      )}

      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

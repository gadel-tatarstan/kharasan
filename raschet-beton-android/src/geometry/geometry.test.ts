import { describe, expect, it } from 'vitest';
import { fitOrthogonalPolygon } from './ortho';
import { isSimplePolygon, polygonArea, type Pt } from './vec';
import { slabMetrics } from './slab';
import {
  buildStrip,
  faceRuns,
  fitNetwork,
  mergeCollinearNet,
  orthogonalConnector,
  removeSegment,
  toothBandAreaMm2,
  validateTopology,
  type NetNode,
  type NetSeg,
} from './strip';
import { unionAxisRects } from './union';
import {
  closeSlabContour,
  contourLens,
  contourPoly,
  deriveSlab,
  scaledStripNodes,
  setSlabContourOffset,
  setSlabEdgeLength,
  lockedStripSegments,
  slabPlacements,
  setStripRunLength,
  setStripSegLength,
  setStripSegWidth,
  stripLens,
  stripNodesFromLens,
  stripPins,
  stripSidePins,
  toggleSlabPin,
  toggleStripPin,
  toggleStripRunPin,
} from '../state/derive';
import type { SlabContour, SlabState, StripState } from '../state/types';

const axisAligned = (poly: Pt[]) =>
  poly.every((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6;
  });

describe('orthogonal fit', () => {
  it('snaps a jittered rectangle to a real rectangle', () => {
    const raw: Pt[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 20 },
      { x: 990, y: 800 },
      { x: 10, y: 810 },
    ];
    const res = fitOrthogonalPolygon(raw, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.poly).toHaveLength(4);
    expect(axisAligned(res.poly)).toBe(true);
    expect(isSimplePolygon(res.poly)).toBe(true);
    expect(polygonArea(res.poly)).toBeGreaterThan(700000);
  });

  it('keeps an L shape orthogonal', () => {
    const raw: Pt[] = [
      { x: 0, y: 0 },
      { x: 1010, y: -8 },
      { x: 995, y: 600 },
      { x: 610, y: 590 },
      { x: 600, y: 1005 },
      { x: -10, y: 1000 },
    ];
    const res = fitOrthogonalPolygon(raw, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.poly.length % 2).toBe(0);
    expect(axisAligned(res.poly)).toBe(true);
    expect(isSimplePolygon(res.poly)).toBe(true);
  });

  it('rejects a self-intersecting sketch', () => {
    const raw: Pt[] = [
      { x: 0, y: 0 },
      { x: 800, y: 800 },
      { x: 800, y: 0 },
      { x: 0, y: 800 },
    ];
    const res = fitOrthogonalPolygon(raw, 1);
    expect(res.ok).toBe(false);
  });

  it('needs at least four points', () => {
    expect(fitOrthogonalPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 1).ok).toBe(false);
  });
});

describe('slab volume', () => {
  it('computes a flat slab', () => {
    const poly: Pt[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    const m = slabMetrics(poly, [200, 200, 200, 200]);
    expect(m.areaMm2).toBeCloseTo(1e6, 3);
    expect(m.volumeMm3 / 1e9).toBeCloseTo(0.2, 5);
  });

  it('integrates a sloped slab', () => {
    const poly: Pt[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    const m = slabMetrics(poly, [400, 200, 200, 200]);
    expect(m.volumeMm3 / 1e9).toBeGreaterThan(0.2);
    expect(m.volumeMm3 / 1e9).toBeLessThan(0.26);
  });

  it('handles a concave (L) slab', () => {
    const poly: Pt[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 600 },
      { x: 600, y: 600 },
      { x: 600, y: 1000 },
      { x: 0, y: 1000 },
    ];
    const m = slabMetrics(poly, poly.map(() => 100));
    expect(m.areaMm2).toBeCloseTo(1000 * 600 + 600 * 400, 3);
    expect(m.volumeMm3 / 1e9).toBeCloseTo((m.areaMm2 * 100) / 1e9, 5);
  });
});

describe('slab edge lengths', () => {
  const L: Pt[] = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 600 },
    { x: 600, y: 600 },
    { x: 600, y: 1000 },
    { x: 0, y: 1000 },
  ];
  const base = (poly: Pt[]): SlabState => ({
    contours: [
      {
        id: 'a',
        raw: poly,
        base: poly,
        pivot: { x: 0, y: 0 },
        lens: null,
        pinned: null,
        entered: false,
        vThickness: poly.map(() => null),
      },
    ],
    thickness: 200,
    entered: false,
  });
  const c0 = (s: SlabState) => s.contours[0];
  const lensOf = (s: SlabState) => contourLens(c0(s));
  const setLen = (s: SlabState, i: number, mm: number) => setSlabEdgeLength(s, c0(s).id, i, mm);
  const pin = (s: SlabState, i: number) => toggleSlabPin(s, c0(s).id, i);

  it('pins the first typed length and scales the rest', () => {
    const res = setLen(base(L), 0, 2000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(c0(res.slab).pinned).toEqual([0]);
    expect(c0(res.slab).lens).toEqual([2000, 1200, 800, 800, 1200, 2000]);
  });

  it('lets the free edge absorb an edit', () => {
    const first = setLen(base(L), 0, 2000);
    if (!first.ok) throw new Error('setup failed');
    const res = setLen(first.slab, 4, 400);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(c0(res.slab).pinned).toEqual([0, 4]);
    expect(c0(res.slab).lens?.[0]).toBe(2000);
    expect(c0(res.slab).lens?.[4]).toBe(400);
    // the only free horizontal edge closes the contour
    expect(c0(res.slab).lens?.[2]).toBeCloseTo(1600, 6);

    const poly = contourPoly(c0(res.slab))!;
    expect(axisAligned(poly)).toBe(true);
    expect(isSimplePolygon(poly)).toBe(true);
    expect(polygonArea(poly)).toBeCloseTo(2000 * 1200 + 400 * 800, 3);
  });

  // The annoying case: type 2000, type 400, type 3000 — the 400 must not drift.
  it('never moves one locked edge when another locked one is edited', () => {
    const first = setLen(base(L), 0, 2000);
    if (!first.ok) throw new Error('setup failed');
    const second = setLen(first.slab, 4, 400);
    if (!second.ok) throw new Error('setup failed');
    expect(c0(second.slab).lens?.[2]).toBeCloseTo(1600, 6);

    const third = setLen(second.slab, 0, 3000);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(c0(third.slab).lens?.[0]).toBe(3000);
    expect(c0(third.slab).lens?.[4]).toBe(400);
    expect(c0(third.slab).lens?.[2]).toBeCloseTo(2600, 6);
    expect(polygonArea(contourPoly(c0(third.slab))!)).toBeCloseTo(
      3000 * 1200 + 400 * 800,
      3,
    );

    // the same on the other axis: a locked vertical side stays put too
    const vertical = setLen(third.slab, 1, 1500);
    expect(vertical.ok).toBe(true);
    if (!vertical.ok) return;
    expect(c0(vertical.slab).lens?.[0]).toBe(3000);
    expect(c0(vertical.slab).lens?.[4]).toBe(400);
    expect(c0(vertical.slab).lens?.[1]).toBe(1500);

    // now every horizontal side is locked: a value that does not add up is refused
    const conflict = setLen(vertical.slab, 2, 1000);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.reason).toMatch(/Открепите/);
  });

  it('keeps a pinned perpendicular side in place and moves only the opposite one', () => {
    const rect: Pt[] = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 500 },
      { x: 0, y: 500 },
    ];
    const withPins = (pinned: number[]): SlabState => ({
      contours: [
        {
          id: 'r',
          raw: rect,
          base: rect,
          pivot: { x: 500, y: 250 },
          lens: [1000, 500, 1000, 500],
          pinned,
          entered: true,
          vThickness: rect.map(() => null),
        },
      ],
      thickness: 200,
      entered: true,
    });
    const xRange = (s: SlabState) => {
      const poly = contourPoly(c0(s))!;
      return {
        min: Math.round(Math.min(...poly.map((p) => p.x))),
        max: Math.round(Math.max(...poly.map((p) => p.x))),
      };
    };

    // Right vertical side (edge 1) is green: it stays at 1000, the left side moves.
    const rightPinned = setLen(withPins([1]), 0, 800);
    expect(rightPinned.ok).toBe(true);
    if (!rightPinned.ok) return;
    expect(xRange(rightPinned.slab)).toEqual({ min: 200, max: 1000 });
    expect(c0(rightPinned.slab).lens).toEqual([800, 500, 800, 500]);

    // The left side (edge 3) is green: the opposite happens.
    const leftPinned = setLen(withPins([3]), 0, 800);
    expect(leftPinned.ok).toBe(true);
    if (!leftPinned.ok) return;
    expect(xRange(leftPinned.slab)).toEqual({ min: 0, max: 800 });

    // Both neighbours pinned or both free: no preferred side, split evenly.
    const both = setLen(withPins([1, 3]), 0, 800);
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(xRange(both.slab)).toEqual({ min: 100, max: 900 });

    const none = setLen(withPins([]), 0, 800);
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(xRange(none.slab)).toEqual({ min: 100, max: 900 });
  });

  it('refuses contradictory locked sides', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 500 },
      { x: 0, y: 500 },
    ];
    const first = setLen(base(rect), 0, 3000);
    if (!first.ok) throw new Error('setup failed');
    const res = setLen(first.slab, 2, 4000);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/не сходятся/);
  });

  it('accepts the edit again after the blocking side is released', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 500 },
      { x: 0, y: 500 },
    ];
    const first = setLen(base(rect), 0, 3000);
    if (!first.ok) throw new Error('setup failed');
    const released = pin(first.slab, 0);
    expect(c0(released).pinned).toEqual([]);
    // nothing changed geometrically by releasing
    expect(lensOf(released)).toEqual(lensOf(first.slab));

    const res = setLen(released, 2, 4000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(c0(res.slab).pinned).toEqual([2]);
    expect(c0(res.slab).lens?.[2]).toBe(4000);
    expect(c0(res.slab).lens?.[0]).toBeCloseTo(4000, 6);
  });

  it('toggles a pin without touching the geometry', () => {
    const first = setLen(base(L), 0, 2000);
    if (!first.ok) throw new Error('setup failed');
    const unlocked = pin(first.slab, 0);
    expect(c0(unlocked).pinned).toEqual([]);
    expect(lensOf(unlocked)).toEqual(lensOf(first.slab));
    const again = pin(unlocked, 3);
    expect(c0(again).pinned).toEqual([3]);
    expect(lensOf(again)).toEqual(lensOf(first.slab));
  });

  // Reported case: several sides locked, then a protrusion is edited. Uniform
  // scaling of the free sides collapsed them and the edit was refused with a
  // "0 мм" alert even though moving one opposite side was perfectly possible.
  it('moves one free opposite side instead of collapsing all free sides', () => {
    const C: Pt[] = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 1000 },
      { x: 500, y: 1000 },
      { x: 500, y: 3000 },
      { x: 2000, y: 3000 },
      { x: 2000, y: 4000 },
      { x: 0, y: 4000 },
    ];
    const start = setLen(base(C), 0, 2000);
    if (!start.ok) throw new Error('setup failed');
    const pin2 = setLen(start.slab, 2, 1500);
    if (!pin2.ok) throw new Error('setup failed');
    const pin4 = setLen(pin2.slab, 4, 1500);
    if (!pin4.ok) throw new Error('setup failed');

    const res = setLen(pin4.slab, 0, 2500);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(c0(res.slab).lens?.[0]).toBe(2500);
    expect(c0(res.slab).lens?.[2]).toBe(1500);
    expect(c0(res.slab).lens?.[4]).toBe(1500);
    // the opposite free side absorbs the whole change
    expect(c0(res.slab).lens?.[6]).toBeCloseTo(2500, 6);

    const poly = contourPoly(c0(res.slab))!;
    expect(axisAligned(poly)).toBe(true);
    expect(isSimplePolygon(poly)).toBe(true);
    expect(polygonArea(poly)).toBeGreaterThan(0);
  });

  it('rejects lengths that would flip a free side', () => {
    const first = setLen(base(L), 0, 2000);
    if (!first.ok) throw new Error('setup failed');
    const res = setLen(first.slab, 4, 2800);
    expect(res.ok).toBe(false);
  });
});

describe('slab with several contours', () => {
  const centerOf = (poly: Pt[]): Pt => ({
    x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
    y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
  });
  const contourOf = (id: string, poly: Pt[]): SlabContour => ({
    id,
    raw: poly,
    base: poly,
    pivot: centerOf(poly),
    lens: null,
    pinned: null,
    entered: true,
    vThickness: poly.map(() => null),
  });
  const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const draftOf = (poly: Pt[]): SlabContour => ({
    id: 'draft',
    raw: poly,
    base: null,
    pivot: { x: 0, y: 0 },
    lens: null,
    pinned: null,
    entered: false,
    vThickness: [],
  });

  it('completes the fourth corner when a three-point contour is closed', () => {
    const slab: SlabState = {
      contours: [
        draftOf([
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
          { x: 1000, y: 600 },
        ]),
      ],
      thickness: 200,
      entered: false,
    };
    const res = closeSlabContour(slab, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const poly = contourPoly(res.slab.contours[0]);
    expect(poly).toHaveLength(4);
    if (!poly) return;
    expect(axisAligned(poly)).toBe(true);
    expect(isSimplePolygon(poly)).toBe(true);
    expect(polygonArea(poly)).toBeCloseTo(600000, 3);
  });

  it('rejects three collinear points instead of inventing a contour', () => {
    const slab: SlabState = {
      contours: [
        draftOf([
          { x: 0, y: 0 },
          { x: 500, y: 0 },
          { x: 1000, y: 0 },
        ]),
      ],
      thickness: 200,
      entered: false,
    };
    expect(closeSlabContour(slab, 1).ok).toBe(false);
  });

  it('subtracts a contour drawn inside the slab', () => {
    const slab: SlabState = {
      contours: [
        contourOf('outer', rect(0, 0, 4000, 3000)),
        contourOf('hole', rect(1000, 1000, 2000, 2000)),
      ],
      thickness: 200,
      entered: true,
    };
    const d = deriveSlab(slab)!;
    expect(d.parts.map((p) => p.role)).toEqual(['add', 'hole']);
    expect(d.metrics.areaMm2).toBeCloseTo(12e6 - 1e6, 3);
    expect(d.metrics.volumeMm3 / 1e9).toBeCloseTo(((12e6 - 1e6) * 200) / 1e9, 6);
    expect(d.metrics.avgThickness).toBeCloseTo(200, 6);
  });

  it('adds a contour drawn outside the slab', () => {
    const slab: SlabState = {
      contours: [
        contourOf('a', rect(0, 0, 1000, 1000)),
        contourOf('b', rect(2000, 0, 3000, 1000)),
      ],
      thickness: 100,
      entered: true,
    };
    const d = deriveSlab(slab)!;
    expect(d.parts.map((p) => p.role)).toEqual(['add', 'add']);
    expect(d.metrics.areaMm2).toBeCloseTo(2e6, 3);
    expect(d.metrics.volumeMm3 / 1e9).toBeCloseTo(0.2, 6);
  });

  it('counts an island inside a hole as concrete again', () => {
    const slab: SlabState = {
      contours: [
        contourOf('outer', rect(0, 0, 4000, 4000)),
        contourOf('hole', rect(1000, 1000, 3000, 3000)),
        contourOf('island', rect(1500, 1500, 2000, 2000)),
      ],
      thickness: 100,
      entered: true,
    };
    const d = deriveSlab(slab)!;
    expect(d.parts.map((p) => p.role)).toEqual(['add', 'hole', 'add']);
    expect(d.metrics.areaMm2).toBeCloseTo(16e6 - 4e6 + 0.25e6, 3);
  });

  it('scales every contour together when the first length fixes the units', () => {
    const slab: SlabState = {
      contours: [
        { ...contourOf('outer', rect(0, 0, 400, 300)), entered: false },
        { ...contourOf('hole', rect(100, 100, 200, 200)), entered: false },
      ],
      thickness: 200,
      entered: false,
    };
    const res = setSlabEdgeLength(slab, 'outer', 0, 4000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.slab.entered).toBe(true);
    const d = deriveSlab(res.slab)!;
    expect(d.metrics.areaMm2).toBeCloseTo(4000 * 3000 - 1000 * 1000, 3);
    expect(contourLens(res.slab.contours[1])[0]).toBeCloseTo(1000, 6);
  });

  it('refuses a new contour that crosses an existing one', () => {
    const slab: SlabState = {
      contours: [
        contourOf('outer', rect(0, 0, 4000, 3000)),
        draftOf(rect(3000, 500, 5000, 1500)),
      ],
      thickness: 200,
      entered: true,
    };
    const res = closeSlabContour(slab, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/пересекаются/);
  });

  it('accepts a new contour drawn flush with an existing one', () => {
    const slab: SlabState = {
      contours: [
        contourOf('outer', rect(0, 0, 4000, 3000)),
        draftOf(rect(4000, 0, 5000, 1000)),
      ],
      thickness: 200,
      entered: true,
    };
    const res = closeSlabContour(slab, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = deriveSlab(res.slab)!;
    expect(d.parts[1].role).toBe('add');
    expect(d.metrics.areaMm2).toBeCloseTo(4000 * 3000 + 1000 * 1000, 3);
  });

  it('accepts a contour drawn inside as a void', () => {
    const slab: SlabState = {
      contours: [
        contourOf('outer', rect(0, 0, 4000, 3000)),
        draftOf(rect(1000, 1000, 2000, 2000)),
      ],
      thickness: 200,
      entered: true,
    };
    const res = closeSlabContour(slab, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = deriveSlab(res.slab)!;
    expect(d.parts[1].role).toBe('hole');
    expect(d.metrics.areaMm2).toBeCloseTo(12e6 - 1e6, 3);
  });

  it('keeps a void inside when its side is edited', () => {
    const slab: SlabState = {
      contours: [
        contourOf('outer', rect(0, 0, 4000, 3000)),
        contourOf('hole', rect(1000, 1000, 2000, 2000)),
      ],
      thickness: 200,
      entered: true,
    };
    const res = setSlabEdgeLength(slab, 'hole', 0, 500);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = deriveSlab(res.slab)!;
    expect(d.parts[1].role).toBe('hole');
    expect(d.parts[1].metrics.areaMm2).toBeCloseTo(500 * 1000, 3);
    expect(d.metrics.volumeMm3 / 1e9).toBeCloseTo(((12e6 - 0.5e6) * 200) / 1e9, 6);
  });

  const withHole = (): SlabState => ({
    contours: [
      contourOf('outer', rect(0, 0, 4000, 3000)),
      contourOf('hole', rect(1000, 700, 1600, 1200)),
    ],
    thickness: 200,
    entered: true,
  });

  it('measures a void from the edges of its slab', () => {
    const rows = slabPlacements(withHole());
    expect(rows).toHaveLength(2);
    expect(rows[0].refId).toBeNull();
    expect(rows[1].refId).toBe('outer');
    expect(rows[1].dx).toBeCloseTo(1000, 6);
    expect(rows[1].dy).toBeCloseTo(700, 6);
  });

  it('reports offsets on all four sides and recalculates the opposite one', () => {
    const rows = slabPlacements(withHole());
    expect(rows[1].left).toBeCloseTo(1000, 6);
    expect(rows[1].right).toBeCloseTo(2400, 6);
    expect(rows[1].top).toBeCloseTo(700, 6);
    expect(rows[1].bottom).toBeCloseTo(1800, 6);

    // Moving the right edge keeps the width, so the left offset grows by the same amount.
    const movedRight = setSlabContourOffset(withHole(), 'hole', { right: 2000 });
    expect(movedRight.ok).toBe(true);
    if (!movedRight.ok) return;
    const afterRight = slabPlacements(movedRight.slab)[1];
    expect(afterRight.left).toBeCloseTo(1400, 6);
    expect(afterRight.right).toBeCloseTo(2000, 6);
    expect(afterRight.top).toBeCloseTo(700, 6);
    expect(afterRight.bottom).toBeCloseTo(1800, 6);
    expect(deriveSlab(movedRight.slab)!.parts[1].metrics.areaMm2).toBeCloseTo(600 * 500, 3);

    // Same for the bottom edge and the top offset.
    const movedBottom = setSlabContourOffset(withHole(), 'hole', { bottom: 1000 });
    expect(movedBottom.ok).toBe(true);
    if (!movedBottom.ok) return;
    const afterBottom = slabPlacements(movedBottom.slab)[1];
    expect(afterBottom.left).toBeCloseTo(1000, 6);
    expect(afterBottom.right).toBeCloseTo(2400, 6);
    expect(afterBottom.top).toBeCloseTo(1500, 6);
    expect(afterBottom.bottom).toBeCloseTo(1000, 6);
  });

  it('moves a void by offsets and keeps its sizes', () => {
    const res = setSlabContourOffset(withHole(), 'hole', { dx: 2400 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = deriveSlab(res.slab)!;
    expect(d.parts[1].metrics.areaMm2).toBeCloseTo(600 * 500, 3);
    expect(d.metrics.volumeMm3 / 1e9).toBeCloseTo(((12e6 - 0.3e6) * 200) / 1e9, 6);
    expect(slabPlacements(res.slab)[1].dx).toBeCloseTo(2400, 6);
    expect(contourLens(res.slab.contours[1])).toEqual(contourLens(withHole().contours[1]));
  });

  it('keeps real lengths when a contour is moved', () => {
    const slab: SlabState = {
      contours: [
        contourOf('outer', rect(0, 0, 4000, 3000)),
        { ...contourOf('hole', rect(1000, 1000, 2000, 2000)), lens: [1000, 1000, 1000, 1000] },
      ],
      thickness: 200,
      entered: true,
    };
    const res = setSlabContourOffset(slab, 'hole', { dx: 1800, dy: 200 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = slabPlacements(res.slab)[1];
    expect(row.dx).toBeCloseTo(1800, 6);
    expect(row.dy).toBeCloseTo(200, 6);
    expect(res.slab.contours[1].lens).toEqual([1000, 1000, 1000, 1000]);
  });

  it('allows a void to sit flush with its slab at a zero offset', () => {
    const res = setSlabContourOffset(withHole(), 'hole', { left: 0, top: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = slabPlacements(res.slab)[1];
    expect(row.left).toBeCloseTo(0, 6);
    expect(row.top).toBeCloseTo(0, 6);
    expect(row.right).toBeCloseTo(3400, 6);
    expect(row.bottom).toBeCloseTo(2500, 6);
    // Touching the slab boundary does not turn the void into a separate volume.
    expect(row.role).toBe('hole');
    expect(deriveSlab(res.slab)!.parts[1].role).toBe('hole');
  });

  it('refuses to push a void out of its slab', () => {
    const res = setSlabContourOffset(withHole(), 'hole', { dx: 4200 });
    expect(res.ok).toBe(false);
  });

  it('refuses an overlap but allows touching and a gap', () => {
    const slab: SlabState = {
      contours: [
        contourOf('a', rect(0, 0, 1000, 1000)),
        contourOf('b', rect(2000, 0, 3000, 1000)),
      ],
      thickness: 100,
      entered: true,
    };
    const rows = slabPlacements(slab);
    expect(rows[0].refId).toBeNull();
    expect(rows[1].refId).toBe('a');
    expect(rows[1].dx).toBeCloseTo(2000, 6);

    // A real overlap is still refused.
    const clash = setSlabContourOffset(slab, 'b', { dx: 500 });
    expect(clash.ok).toBe(false);

    // Touching the slab (zero gap) is a valid flush added volume.
    const touching = setSlabContourOffset(slab, 'b', { dx: 1000 });
    expect(touching.ok).toBe(true);
    if (!touching.ok) return;
    expect(slabPlacements(touching.slab)[1].gapX).toBeCloseTo(0, 6);

    const gap = setSlabContourOffset(slab, 'b', { dx: 1500 });
    expect(gap.ok).toBe(true);
    if (!gap.ok) return;
    expect(slabPlacements(gap.slab)[1].dx).toBeCloseTo(1500, 6);
    expect(deriveSlab(gap.slab)!.metrics.areaMm2).toBeCloseTo(2e6, 3);
  });

  it('shows three real distances for a contour beside the slab', () => {
    const slab: SlabState = {
      contours: [
        contourOf('a', rect(0, 0, 1000, 1000)),
        contourOf('b', rect(2000, 200, 3000, 800)),
      ],
      thickness: 100,
      entered: true,
    };
    const row = slabPlacements(slab)[1];
    expect(row.mode).toBe('gaps');
    expect(row.gapAxis).toBe('x');
    expect(row.gapX).toBeCloseTo(1000, 6);
    expect(row.top).toBeCloseTo(200, 6);
    expect(row.bottom).toBeCloseTo(200, 6);
    expect(row.top + 600 + row.bottom).toBeCloseTo(1000, 6);

    // Editing the gap moves the contour horizontally and keeps the side.
    const moved = setSlabContourOffset(slab, 'b', { gapX: 1500 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const afterGap = slabPlacements(moved.slab)[1];
    expect(afterGap.gapX).toBeCloseTo(1500, 6);
    expect(afterGap.top).toBeCloseTo(200, 6);
    expect(afterGap.bottom).toBeCloseTo(200, 6);
    expect(afterGap.dx).toBeCloseTo(2500, 6);

    // The vertical position is set by the distance between the top edge planes;
    // the bottom distance follows because the height is fixed.
    const top = setSlabContourOffset(slab, 'b', { top: 300 });
    expect(top.ok).toBe(true);
    if (!top.ok) return;
    const afterTop = slabPlacements(top.slab)[1];
    expect(afterTop.top).toBeCloseTo(300, 6);
    expect(afterTop.bottom).toBeCloseTo(100, 6);
    expect(afterTop.gapX).toBeCloseTo(1000, 6);

    const bottom = setSlabContourOffset(slab, 'b', { bottom: 50 });
    expect(bottom.ok).toBe(true);
    if (!bottom.ok) return;
    const afterBottom = slabPlacements(bottom.slab)[1];
    expect(afterBottom.top).toBeCloseTo(350, 6);
    expect(afterBottom.bottom).toBeCloseTo(50, 6);

    // Negative input is clamped to zero, and touching the slab is allowed.
    const negative = setSlabContourOffset(slab, 'b', { gapX: -500 });
    expect(negative.ok).toBe(true);
    if (!negative.ok) return;
    expect(slabPlacements(negative.slab)[1].gapX).toBeCloseTo(0, 6);
  });

  it('shows three real distances for a contour above the slab', () => {
    const slab: SlabState = {
      contours: [
        contourOf('a', rect(0, 0, 1000, 1000)),
        contourOf('b', rect(200, 2000, 800, 3000)),
      ],
      thickness: 100,
      entered: true,
    };
    const row = slabPlacements(slab)[1];
    expect(row.mode).toBe('gaps');
    expect(row.gapAxis).toBe('y');
    expect(row.gapY).toBeCloseTo(1000, 6);
    expect(row.left).toBeCloseTo(200, 6);
    expect(row.right).toBeCloseTo(200, 6);

    const moved = setSlabContourOffset(slab, 'b', { gapY: 1500 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const afterGap = slabPlacements(moved.slab)[1];
    expect(afterGap.gapY).toBeCloseTo(1500, 6);
    expect(afterGap.left).toBeCloseTo(200, 6);
    expect(afterGap.right).toBeCloseTo(200, 6);

    const left = setSlabContourOffset(slab, 'b', { left: 300 });
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    const afterLeft = slabPlacements(left.slab)[1];
    expect(afterLeft.left).toBeCloseTo(300, 6);
    expect(afterLeft.right).toBeCloseTo(100, 6);
    expect(afterLeft.gapY).toBeCloseTo(1000, 6);

    const right = setSlabContourOffset(slab, 'b', { right: 50 });
    expect(right.ok).toBe(true);
    if (!right.ok) return;
    const afterRight = slabPlacements(right.slab)[1];
    expect(afterRight.left).toBeCloseTo(350, 6);
    expect(afterRight.right).toBeCloseTo(50, 6);
  });

  it('shows only two real gaps for a diagonal external contour', () => {
    const slab: SlabState = {
      contours: [
        contourOf('a', rect(0, 0, 1000, 1000)),
        contourOf('b', rect(2000, 2000, 3000, 3000)),
      ],
      thickness: 100,
      entered: true,
    };
    const before = slabPlacements(slab)[1];
    expect(before.mode).toBe('gaps');
    expect(before.gapAxis).toBe('both');
    expect(before.gapX).toBeCloseTo(1000, 6);
    expect(before.gapY).toBeCloseTo(1000, 6);

    const movedX = setSlabContourOffset(slab, 'b', { gapX: 1500 });
    expect(movedX.ok).toBe(true);
    if (!movedX.ok) return;
    const afterX = slabPlacements(movedX.slab)[1];
    expect(afterX.gapX).toBeCloseTo(1500, 6);
    expect(afterX.gapY).toBeCloseTo(1000, 6);

    const movedY = setSlabContourOffset(slab, 'b', { gapY: 1200 });
    expect(movedY.ok).toBe(true);
    if (!movedY.ok) return;
    const afterY = slabPlacements(movedY.slab)[1];
    expect(afterY.gapX).toBeCloseTo(1000, 6);
    expect(afterY.gapY).toBeCloseTo(1200, 6);

    // Negative input is clamped to zero; the axes are separated, so the contour
    // does not touch the slab even at a zero gap.
    const clamped = setSlabContourOffset(slab, 'b', { gapX: -500 });
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    expect(slabPlacements(clamped.slab)[1].gapX).toBeCloseTo(0, 6);
  });
});

describe('strip network', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 1000, y: 0 },
    { id: 'c', x: 1000, y: 1000 },
  ];
  const segs = [
    { id: 's1', a: 'a', b: 'b' },
    { id: 's2', a: 'b', b: 'c' },
  ];

  it('mitres an L corner without double counting', () => {
    const built = buildStrip(nodes, segs, () => 400, () => 600);
    // Mitred L band: 1200x400 + 400x1200 - 400x400 corner overlap.
    expect(built.areaMm2).toBeCloseTo(800000, 0);
    expect(built.volumeMm3 / 1e9).toBeCloseTo(0.48, 4);
    // Outer side of the first leg grows by half a width at the mitre, inner shrinks.
    expect(built.segments[0].outerLen).toBeCloseTo(1200, 0);
    expect(built.segments[0].innerLen).toBeCloseTo(800, 0);
  });

  it('builds a closed ring and detects a triangle as impossible', () => {
    const ring = [
      { id: 'p', x: 0, y: 0 },
      { id: 'q', x: 3000, y: 0 },
      { id: 'r', x: 3000, y: 2000 },
      { id: 't', x: 0, y: 2000 },
    ];
    const ringSegs = [
      { id: '1', a: 'p', b: 'q' },
      { id: '2', a: 'q', b: 'r' },
      { id: '3', a: 'r', b: 't' },
      { id: '4', a: 't', b: 'p' },
    ];
    expect(fitNetwork({ nodes: ring, segs: ringSegs }).ok).toBe(true);

    const tri = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 500, y: 900 },
    ];
    const triSegs = [
      { id: '1', a: 'a', b: 'b' },
      { id: '2', a: 'b', b: 'c' },
      { id: '3', a: 'c', b: 'a' },
    ];
    expect(fitNetwork({ nodes: tri, segs: triSegs }).ok).toBe(false);
  });

  it('allows centrelines to cross and counts overlaps once', () => {
    const crossing = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 2000, y: 0 },
      { id: 'c', x: 1000, y: -1000 },
      { id: 'd', x: 1000, y: 1000 },
    ];
    const crossingSegs = [
      { id: '1', a: 'a', b: 'b' },
      { id: '2', a: 'c', b: 'd' },
    ];
    expect(validateTopology(crossing, crossingSegs)).toBeNull();

    // Overlapping collinear centrelines are allowed: the union counts the
    // shared run once instead of warning about it.
    const overlapping = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 500, y: 0 },
      { id: 'd', x: 1500, y: 0 },
    ];
    const overlappingSegs = [
      { id: '1', a: 'a', b: 'b' },
      { id: '2', a: 'c', b: 'd' },
    ];
    expect(validateTopology(overlapping, overlappingSegs)).toBeNull();
    const shared = buildStrip(overlapping, overlappingSegs, () => 400, () => 600);
    expect(shared.areaMm2).toBeCloseTo(1500 * 400, 0);
    expect(shared.volumeMm3 / 1e9).toBeCloseTo((1500 * 400 * 600) / 1e9, 6);

    // The exact same pair drawn twice is also fine and still counts once.
    const doubled = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
    ];
    const doubledSegs = [
      { id: '1', a: 'a', b: 'b' },
      { id: '2', a: 'b', b: 'a' },
    ];
    expect(fitNetwork({ nodes: doubled, segs: doubledSegs }).ok).toBe(true);
    const one = buildStrip(doubled, doubledSegs, () => 400, () => 600);
    expect(one.areaMm2).toBeCloseTo(1000 * 400, 0);
    expect(one.volumeMm3 / 1e9).toBeCloseTo((1000 * 400 * 600) / 1e9, 6);
  });

  it('merges a line drawn over another into one centreline with branch vertices', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 2000, y: 0 },
      { id: 'c', x: 500, y: 0 },
      { id: 'd', x: 1500, y: 0 },
    ];
    const segs = [
      { id: 'base', a: 'a', b: 'b' },
      { id: 'over', a: 'c', b: 'd' },
    ];
    const merged = mergeCollinearNet(nodes, segs);
    // a-c, the shared c-d run, and d-b.
    expect(merged.segs).toHaveLength(3);
    expect(merged.nodes).toHaveLength(4);
    const pairs = merged.segs.map((s) => [s.a, s.b].sort().join('-')).sort();
    expect(pairs).toEqual(['a-c', 'b-d', 'c-d']);

    const shared = merged.segs.find((s) => [s.a, s.b].sort().join('-') === 'c-d')!;
    // The shared run remembers both sources so width and pins can be carried over.
    expect(merged.origin[shared.id].sort()).toEqual(['base', 'over']);

    // Geometry and volume are unchanged by the merge.
    const before = buildStrip(nodes, segs, () => 400, () => 600);
    const after = buildStrip(merged.nodes, merged.segs, () => 400, () => 600);
    expect(after.areaMm2).toBeCloseTo(before.areaMm2, 3);
    expect(after.volumeMm3).toBeCloseTo(before.volumeMm3, 3);
  });

  it('keeps a wider segment flush with its neighbour instead of growing along the axis', () => {
    const nodesW = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 1000, y: 1000 },
    ];
    const segsW = [
      { id: 'h', a: 'a', b: 'b' },
      { id: 'v', a: 'b', b: 'c' },
    ];
    const narrow = buildStrip(nodesW, segsW, (s) => (s.id === 'h' ? 400 : 400), () => 500);
    const wide = buildStrip(nodesW, segsW, (s) => (s.id === 'h' ? 800 : 400), () => 500);
    const x1 = (built: typeof wide) =>
      Math.max(...built.outline.flat().map((p) => p.x));
    // The horizontal leg ends at the vertical leg's far side in both cases, so
    // only its width changes; before, it also grew by its own half-width.
    expect(x1(narrow)).toBeCloseTo(1200, 6);
    expect(x1(wide)).toBeCloseTo(1200, 6);
    expect(wide.areaMm2).toBeGreaterThan(narrow.areaMm2);
  });

  it('counts a crossing once, by exactly one band width squared', () => {
    const crossing = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 2000, y: 0 },
      { id: 'c', x: 1000, y: -1000 },
      { id: 'd', x: 1000, y: 1000 },
    ];
    const crossingSegs = [
      { id: '1', a: 'a', b: 'b' },
      { id: '2', a: 'c', b: 'd' },
    ];
    const built = buildStrip(crossing, crossingSegs, () => 400, () => 600);
    // Two 2000x400 bands minus the 400x400 square where they meet.
    expect(built.areaMm2).toBeCloseTo(2 * 2000 * 400 - 400 * 400, 3);
    expect(built.volumeMm3).toBeCloseTo(built.areaMm2 * 600, 3);
    expect(built.outline).toHaveLength(1);
  });

  it('auto-draws a corner for a connection and avoids doubling a side', () => {
    const start = { x: 100, y: 200 };
    const a = { x: 300, y: 200 };
    const b = { x: 300, y: 400 };
    // Closing from b back to the start: the corner must be bottom-left,
    // not the top-right one that would run back along the two existing sides.
    expect(orthogonalConnector(b, start, [{ a: start, b: a }, { a, b }], 'V')).toEqual([
      { x: 100, y: 400 },
    ]);
    // Aligned points need no corner at all.
    expect(orthogonalConnector({ x: 0, y: 0 }, { x: 0, y: 500 })).toEqual([]);
  });

  it('reports mitred outer/inner lengths on a closed ring', () => {
    const ring = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 4000, y: 4000 },
      { id: 'd', x: 0, y: 4000 },
    ];
    const ringSegs = [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
    ];
    const built = buildStrip(ring, ringSegs, () => 400, () => 500);
    for (const g of built.segments) {
      expect(g.outerLen).toBeCloseTo(4400, 6);
      expect(g.innerLen).toBeCloseTo(3600, 6);
    }
    // ring band: outer 4400² minus inner 3600²
    expect(built.areaMm2).toBeCloseTo(4400 ** 2 - 3600 ** 2, 0);
  });

  it('per-segment widths change the area', () => {
    const built = buildStrip(nodes, segs, (s) => (s.id === 's2' ? 200 : 400), () => 500);
    expect(built.areaMm2).toBeLessThan(800000);
    expect(built.segments[1].width).toBe(200);
  });

  it('uses a separate constant depth for each segment', () => {
    const separate = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 3000, y: 0 },
      { id: 'd', x: 4000, y: 0 },
    ];
    const separateSegs = [
      { id: 's1', a: 'a', b: 'b' },
      { id: 's2', a: 'c', b: 'd' },
    ];
    const built = buildStrip(
      separate,
      separateSegs,
      () => 400,
      (s) => (s.id === 's1' ? 200 : 600),
    );
    expect(built.volumeMm3).toBeCloseTo(
      1000 * 400 * 200 + 1000 * 400 * 600,
      0,
    );
    expect(built.segments.map((g) => g.id)).toEqual(['s1', 's2']);
  });

  it('keeps outer and inner faces on their side for every segment direction', () => {
    // Half of these rings are stored with a segment pointing "the other way".
    // The mitre used to follow the stored direction literally, so on those rings
    // the two labels swapped sides and, where the sides became equal, vanished.
    const ring = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 4000, y: 4000 },
      { id: 'd', x: 0, y: 4000 },
    ];
    const pairs = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'a'],
    ] as const;
    const ids = ['t', 'r', 'u', 'l'];
    for (let mask = 0; mask < 16; mask++) {
      const segs: NetSeg[] = pairs.map(([a, b], i) => ({
        id: ids[i],
        a: mask & (1 << i) ? b : a,
        b: mask & (1 << i) ? a : b,
      }));
      const built = buildStrip(ring, segs, () => 400, () => 500);
      for (const g of built.segments) {
        expect(g.outerLen, `${g.id} outer, mask ${mask}`).toBeCloseTo(4400, 6);
        expect(g.innerLen, `${g.id} inner, mask ${mask}`).toBeCloseTo(3600, 6);
      }
    }
  });

  it('turns the union outline into one run per visible face', () => {
    const ring = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 4000, y: 4000 },
      { id: 'd', x: 0, y: 4000 },
    ];
    const ringSegs = [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
    ];
    const runs = faceRuns(buildStrip(ring, ringSegs, () => 400, () => 500));
    // Four outer and four inner faces, end caps excluded.
    expect(runs).toHaveLength(8);
    expect(runs.filter((r) => r.outer)).toHaveLength(4);
    expect(runs.filter((r) => !r.outer)).toHaveLength(4);
    for (const r of runs) {
      expect(r.ids.length).toBe(1);
      expect(r.len).toBeCloseTo(r.outer ? 4400 : 3600, 6);
    }
    expect(new Set(runs.map((r) => r.key)).size).toBe(8);
  });

  it('keeps a wall that a partition only touches from inside as one outer run', () => {
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 4000, y: 3000 },
      { id: 'd', x: 0, y: 3000 },
      { id: 'm', x: 2000, y: 0 },
      { id: 'q', x: 2000, y: 1500 },
    ];
    const segs: NetSeg[] = [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
      { id: 'p', a: 'm', b: 'q' },
    ];
    const merged = mergeCollinearNet(nodes, segs);
    const runs = faceRuns(buildStrip(merged.nodes, merged.segs, () => 400, () => 500));
    // The outside of the bottom wall is continuous: one number for the whole side.
    const outerH = runs.filter((r) => r.outer && r.axis === 'H');
    expect(outerH.map((r) => Math.round(r.len)).sort((x, y) => x - y)).toEqual([4400, 4400]);
    // The inside is cut by the partition, and the partition gets its own faces.
    const holeH = runs.filter((r) => !r.outer && r.axis === 'H');
    expect(holeH.map((r) => Math.round(r.len)).sort((x, y) => x - y)).toEqual([1600, 1600, 3600]);
    const partition = runs.filter((r) => r.ids.includes('p'));
    expect(partition.map((r) => Math.round(r.len))).toEqual([1300, 1300]);
  });

  it('dimensions both sides of an open line and skips its end caps', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 1000, y: 800 },
    ];
    const segs = [
      { id: 's1', a: 'a', b: 'b' },
      { id: 's2', a: 'b', b: 'c' },
    ];
    const runs = faceRuns(buildStrip(nodes, segs, () => 400, () => 500));
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => Math.round(r.len)).sort((x, y) => x - y)).toEqual([600, 800, 1000, 1200]);
  });
});

describe('apron tooth', () => {
  const ring = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 4000, y: 0 },
    { id: 'c', x: 4000, y: 3000 },
    { id: 'd', x: 0, y: 3000 },
  ];
  const ringSegs = [
    { id: 't', a: 'a', b: 'b' },
    { id: 'r', a: 'b', b: 'c' },
    { id: 'u', a: 'c', b: 'd' },
    { id: 'l', a: 'd', b: 'a' },
  ];

  it('runs only along the outer contour of a closed ring', () => {
    const built = buildStrip(ring, ringSegs, () => 400, () => 500);
    // Outer contour is 4400 × 3400; a 100 mm tooth leaves 4200 × 3200 free.
    expect(toothBandAreaMm2(built.outline, 100)).toBeCloseTo(4400 * 3400 - 4200 * 3200, 3);
  });

  it('ignores internal partitions and holes', () => {
    const nodes = [
      { id: 'bl', x: 0, y: 0 },
      { id: 'bm', x: 2000, y: 0 },
      { id: 'br', x: 4000, y: 0 },
      { id: 'tr', x: 4000, y: 3000 },
      { id: 'tm', x: 2000, y: 3000 },
      { id: 'tl', x: 0, y: 3000 },
    ];
    const segs = [
      { id: 'bl-bm', a: 'bl', b: 'bm' },
      { id: 'bm-br', a: 'bm', b: 'br' },
      { id: 'r', a: 'br', b: 'tr' },
      { id: 'tr-tm', a: 'tr', b: 'tm' },
      { id: 'tm-tl', a: 'tm', b: 'tl' },
      { id: 'l', a: 'tl', b: 'bl' },
      { id: 'p', a: 'bm', b: 'tm' },
    ];
    const built = buildStrip(nodes, segs, () => 400, () => 500);
    expect(toothBandAreaMm2(built.outline, 100)).toBeCloseTo(4400 * 3400 - 4200 * 3200, 3);
  });

  it('is zero without a positive width', () => {
    const built = buildStrip(ring, ringSegs, () => 400, () => 500);
    expect(toothBandAreaMm2(built.outline, 0)).toBe(0);
  });
});

describe('segment deletion', () => {
  const ringNodes: NetNode[] = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 4000, y: 0 },
    { id: 'c', x: 4000, y: 4000 },
    { id: 'd', x: 0, y: 4000 },
  ];
  const ring: NetSeg[] = [
    { id: 't', a: 'a', b: 'b' },
    { id: 'r', a: 'b', b: 'c' },
    { id: 'u', a: 'c', b: 'd' },
    { id: 'l', a: 'd', b: 'a' },
  ];

  it('opens a ring into a polyline and keeps both end vertices', () => {
    const res = removeSegment(ringNodes, ring, 't');
    expect(res.segs.map((s) => s.id)).toEqual(['r', 'u', 'l']);
    // The ends a and b are still used by the left and right sides.
    expect(res.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    const openEnds = res.nodes.filter(
      (n) => res.segs.filter((s) => s.a === n.id || s.b === n.id).length === 1,
    );
    expect(openEnds.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('removes a bridge without touching the lines it joined', () => {
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 0, y: 2000 },
      { id: 'd', x: 4000, y: 2000 },
    ];
    const segs: NetSeg[] = [
      { id: 'top', a: 'a', b: 'b' },
      { id: 'bottom', a: 'c', b: 'd' },
      { id: 'bridge', a: 'b', b: 'd' },
    ];
    const res = removeSegment(nodes, segs, 'bridge');
    expect(res.segs.map((s) => s.id)).toEqual(['top', 'bottom']);
    expect(res.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops vertices that would be left isolated', () => {
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 2000, y: 0 },
      { id: 'd', x: 2000, y: 1000 },
    ];
    const segs: NetSeg[] = [
      { id: 's1', a: 'a', b: 'b' },
      { id: 's2', a: 'b', b: 'c' },
      { id: 'tail', a: 'c', b: 'd' },
    ];
    const res = removeSegment(nodes, segs, 's1');
    // a only met b through s1; b keeps s2, so it stays.
    expect(res.nodes.map((n) => n.id)).toEqual(['b', 'c', 'd']);
    for (const n of res.nodes) {
      expect(res.segs.some((s) => s.a === n.id || s.b === n.id)).toBe(true);
    }
  });

  it('empties the network with the last segment', () => {
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
    ];
    const segs: NetSeg[] = [{ id: 'only', a: 'a', b: 'b' }];
    const res = removeSegment(nodes, segs, 'only');
    expect(res.segs).toEqual([]);
    expect(res.nodes).toEqual([]);
  });
});

describe('rectangle union', () => {
  it('merges overlapping rects exactly', () => {
    const u = unionAxisRects([
      { x0: 0, y0: 0, x1: 100, y1: 100, heightAt: () => 10 },
      { x0: 50, y0: 50, x1: 150, y1: 150, heightAt: () => 10 },
    ]);
    expect(u.areaMm2).toBeCloseTo(10000 + 10000 - 2500, 3);
    expect(u.volumeMm3).toBeCloseTo(17500 * 10, 3);
    expect(u.outline.length).toBe(1);
  });

  it('keeps disjoint parts as separate loops', () => {
    const u = unionAxisRects([
      { x0: 0, y0: 0, x1: 100, y1: 100, heightAt: () => 1 },
      { x0: 300, y0: 0, x1: 400, y1: 100, heightAt: () => 1 },
    ]);
    expect(u.areaMm2).toBeCloseTo(20000, 3);
    expect(u.outline.length).toBe(2);
  });

  it('does not grow a rect when its bound is a hair above another grid line', () => {
    // Values come from sums of millimetre lengths, so a side that should sit on
    // `1000` may land at `1000.0000005`. Compressing that to its own line and
    // then rounding the bound forward used to swallow the next whole cell —
    // painting empty areas brown. The second rect sits far away on purpose.
    const u = unionAxisRects([
      { x0: 0, y0: 0, x1: 1000.0000005, y1: 1000, heightAt: () => 1 },
      { x0: 1000, y0: 5000, x1: 2000, y1: 6000, heightAt: () => 1 },
    ]);
    expect(u.areaMm2).toBeCloseTo(2000000, 3);
    expect(u.outline.length).toBe(2);
    for (const loop of u.outline) {
      expect(Math.max(...loop.map((p) => p.x))).toBeLessThanOrEqual(2000);
      expect(Math.max(...loop.map((p) => p.y))).toBeLessThanOrEqual(6000);
    }
  });

  it('seals a sub-micron crack between two bands', () => {
    const u = unionAxisRects([
      { x0: 0, y0: 0, x1: 1000, y1: 1000, heightAt: () => 1 },
      { x0: 1000.0000015, y0: 0, x1: 2000, y1: 1000, heightAt: () => 1 },
    ]);
    expect(u.areaMm2).toBeCloseTo(2000000, 3);
    expect(u.outline.length).toBe(1);
  });
});

it('keeps a T-junction outline axis aligned and its volume exact', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 1000, y: 0 },
    { id: 'c', x: 1000, y: 800 },
    { id: 'd', x: 500, y: 0 },
    { id: 'e', x: 500, y: -600 },
  ];
  const segs = [
    { id: 's1', a: 'a', b: 'd' },
    { id: 's2', a: 'd', b: 'b' },
    { id: 's3', a: 'b', b: 'c' },
    { id: 's4', a: 'd', b: 'e' },
  ];
  const built = buildStrip(nodes, segs, () => 400, () => 200);
  console.log('loops', built.outline.length);
  for (const l of built.outline) console.log(l.map((p) => `${p.x},${p.y}`).join('  '));
  for (const loop of built.outline) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const axis = Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6;
      expect(axis, `diagonal ${JSON.stringify(a)}->${JSON.stringify(b)}`).toBe(true);
    }
  }
  expect(built.volumeMm3).toBeCloseTo(200 * (1000 * 400 + 800 * 400 + 400 * 400), 0);
});

describe('strip lengths', () => {
  // L-shaped open axis: a-b (H), b-c (V), c-d (H) — no cycles, every length is free.
  const open = {
    nodes: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 1000, y: 800 },
      { id: 'd', x: 200, y: 800 },
    ],
    segs: [
      { id: 's1', a: 'a', b: 'b' },
      { id: 's2', a: 'b', b: 'c' },
      { id: 's3', a: 'c', b: 'd' },
    ],
  };
  const stripOf = (nodes: NetNode[], segs: NetSeg[]): StripState => ({
    nodes,
    segs,
    baseNodes: nodes,
    pivot: { x: 0, y: 0 },
    sx: 1,
    sy: 1,
    refSeg: null,
    lens: null,
    pinned: null,
    entered: false,
    baseWidth: 400,
    baseDepth: 600,
    widths: {},
    depths: {},
    tooth: false,
    toothWidth: 100,
    toothDepth: 100,
  });

  it('turns the sketch into millimetres on the first value and pins it', () => {
    const res = setStripSegLength(stripOf(open.nodes, open.segs), 's1', 5000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lens = stripLens(res.strip);
    expect(lens.s1).toBeCloseTo(5000, 6);
    // uniform scale: 800 units become 4000 mm
    expect(lens.s2).toBeCloseTo(4000, 6);
    expect([...stripPins(res.strip)]).toEqual(['s1']);
    const nodes = scaledStripNodes(res.strip);
    expect(Math.abs(nodes[1].x - nodes[0].x)).toBeCloseTo(5000, 6);
  });

  it('keeps the pinned length and only grows the edited axis on an open axis', () => {
    const first = setStripSegLength(stripOf(open.nodes, open.segs), 's1', 5000);
    if (!first.ok) throw new Error('setup failed');
    const second = setStripSegLength(first.strip, 's3', 1200);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const lens = stripLens(second.strip);
    expect(lens.s1).toBeCloseTo(5000, 6);
    expect(lens.s3).toBeCloseTo(1200, 6);
    expect(lens.s2).toBeCloseTo(4000, 6);
    expect(stripPins(second.strip).size).toBe(2);
    // the geometry follows the lengths, angles stay 90°
    const nodes = scaledStripNodes(second.strip);
    expect(nodes[0].y).toBeCloseTo(nodes[1].y, 6);
    expect(nodes[1].x).toBeCloseTo(nodes[2].x, 6);
    expect(Math.abs(nodes[3].x - nodes[2].x)).toBeCloseTo(1200, 6);
  });

  it('slides the opposite side of a closed ring and keeps both numbers', () => {
    const ring = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 3000, y: 0 },
      { id: 'c', x: 3000, y: 2000 },
      { id: 'd', x: 0, y: 2000 },
    ];
    const ringSegs = [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
    ];
    const first = setStripSegLength(stripOf(ring, ringSegs), 't', 3000);
    if (!first.ok) throw new Error('setup failed');
    const grown = setStripSegLength(first.strip, 't', 5000);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    const lens = stripLens(grown.strip);
    expect(lens.t).toBeCloseTo(5000, 6);
    // the opposite side absorbs the difference so the ring still closes
    expect(lens.u).toBeCloseTo(5000, 6);
    expect(lens.r).toBeCloseTo(2000, 6);
    expect(lens.l).toBeCloseTo(2000, 6);
    const nodes = scaledStripNodes(grown.strip);
    expect(stripNodesFromLens(grown.strip.baseNodes!, grown.strip.segs, lens)).not.toBeNull();
    expect(Math.abs(nodes[1].x - nodes[0].x)).toBeCloseTo(5000, 6);
  });

  it('uses the remaining capacity of a free side instead of refusing the edit', () => {
    // Rectilinear hexagon: h1 + h2 = h3 on the horizontal axis. h3 is already
    // close to the 200 m limit, so the old "split the difference evenly" logic
    // tried to push it past the limit and refused the edit.
    const hex = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 194000, y: 0 },
      { id: 'c', x: 194000, y: 5900 },
      { id: 'd', x: 199900, y: 5900 },
      { id: 'e', x: 199900, y: -1000 },
      { id: 'f', x: 0, y: -1000 },
    ];
    const hexSegs = [
      { id: 'h1', a: 'a', b: 'b' },
      { id: 'v1', a: 'b', b: 'c' },
      { id: 'h2', a: 'c', b: 'd' },
      { id: 'v2', a: 'd', b: 'e' },
      { id: 'h3', a: 'e', b: 'f' },
      { id: 'v3', a: 'f', b: 'a' },
    ];
    const first = setStripSegLength(stripOf(hex, hexSegs), 'h1', 194000);
    if (!first.ok) throw new Error('setup failed');
    // h2 and h3 stay free: they must absorb the change, not raise a false alert.
    const grown = setStripSegLength(first.strip, 'h1', 199000);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    const lens = stripLens(grown.strip);
    expect(lens.h1).toBeCloseTo(199000, 6);
    // h3 is the opposite side: it slides to its own limit (200 m), the small
    // h2 takes the rest, so the hexagon still closes.
    expect(lens.h3).toBeCloseTo(200000, 6);
    expect(lens.h2).toBeCloseTo(1000, 6);
    expect(lens.h1 + lens.h2 - lens.h3).toBeCloseTo(0, 6);
    expect(stripNodesFromLens(grown.strip.baseNodes!, grown.strip.segs, lens)).not.toBeNull();
  });

  it('keeps a detached line in place instead of collapsing it onto the ring', () => {
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 0 },
      { id: 'c', x: 1000, y: 1000 },
      { id: 'd', x: 0, y: 1000 },
      { id: 'e', x: 500, y: 300 },
      { id: 'f', x: 500, y: 600 },
    ];
    const segs: NetSeg[] = [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
      { id: 's', a: 'e', b: 'f' },
    ];
    const lens = { t: 1000, r: 1000, u: 1000, l: 1000, s: 300 };
    const out = stripNodesFromLens(nodes, segs, lens);
    expect(out).not.toBeNull();
    const byId = new Map((out ?? []).map((n) => [n.id, n]));
    // The detached line stays at its own centre, not on the ring's left edge.
    expect(byId.get('e')!.x).toBeCloseTo(500, 6);
    expect(byId.get('e')!.y).toBeCloseTo(300, 6);
    expect(byId.get('f')!.x).toBeCloseTo(500, 6);
    expect(byId.get('f')!.y).toBeCloseTo(600, 6);
    expect(byId.get('a')!.x).toBeCloseTo(0, 6);
  });

  it('reports a conflict when the whole ring is locked and refuses the edit', () => {
    const ring = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 3000, y: 0 },
      { id: 'c', x: 3000, y: 2000 },
      { id: 'd', x: 0, y: 2000 },
    ];
    const ringSegs = [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
    ];
    let strip = stripOf(ring, ringSegs);
    for (const id of ['t', 'u', 'r', 'l']) {
      const res = setStripSegLength(strip, id, stripLens(strip)[id]);
      if (!res.ok) throw new Error('setup failed at ' + id);
      strip = res.strip;
    }
    const before = stripLens(strip);
    const res = setStripSegLength(strip, 't', 9000);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/Открепите/);
    expect(stripLens(strip)).toEqual(before);
  });

  it('long press releases a pin without moving the geometry', () => {
    const first = setStripSegLength(stripOf(open.nodes, open.segs), 's1', 5000);
    if (!first.ok) throw new Error('setup failed');
    const before = stripLens(first.strip);
    const released = toggleStripPin(first.strip, 's1');
    expect([...stripPins(released)]).toEqual([]);
    expect(stripLens(released)).toEqual(before);
    expect(scaledStripNodes(released)).toEqual(scaledStripNodes(first.strip));
  });

  // A square ring gives every face a simple expected number: 4000 axis + 400 width.
  const square = {
    nodes: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 4000, y: 4000 },
      { id: 'd', x: 0, y: 4000 },
    ],
    segs: [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
    ],
  };
  const runsOf = (strip: StripState) =>
    faceRuns(buildStrip(scaledStripNodes(strip), strip.segs, () => 400, () => 500));

  /** Outer face on the requested side of the ring: V -1 is the left wall. */
  const outerFace = (strip: StripState, axis: 'H' | 'V', sign: 1 | -1) => {
    const run = runsOf(strip).find((r) => {
      if (!r.outer || r.axis !== axis) return false;
      return (axis === 'V' ? Math.sign(r.a.x) : Math.sign(r.a.y)) === sign;
    });
    if (!run) throw new Error(`${axis}${sign} face not found`);
    return run;
  };

  const bottomRun = (strip: StripState) => {
    // Dimensions come from the shape rebuilt from the entered lengths, not from
    // the original sketch stored in `baseNodes`.
    const run = outerFace(strip, 'H', -1);
    return run;
  };

  it('writes the typed number onto the whole visible face on first entry', () => {
    const res = setStripRunLength(stripOf(square.nodes, square.segs), bottomRun(stripOf(square.nodes, square.segs)), 5000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lens = stripLens(res.strip);
    // The face is 400 mm out from the axis, so the axis grows to 4600.
    expect(lens.t).toBeCloseTo(4600, 6);
    expect(lens.r).toBeCloseTo(4600, 6);
    expect(lens.u).toBeCloseTo(4600, 6);
    expect(lens.l).toBeCloseTo(4600, 6);
    expect([...stripSidePins(res.strip)]).toEqual([bottomRun(res.strip).key]);
    expect(res.strip.entered).toBe(true);
  });

  it('spreads a face edit over its pieces and slides the opposite side', () => {
    const first = setStripRunLength(
      stripOf(square.nodes, square.segs),
      bottomRun(stripOf(square.nodes, square.segs)),
      4400,
    );
    if (!first.ok) throw new Error('setup failed');
    const grown = setStripRunLength(first.strip, bottomRun(first.strip), 5000);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    const lens = stripLens(grown.strip);
    expect(lens.t).toBeCloseTo(4600, 6);
    expect(lens.u).toBeCloseTo(4600, 6);
    // The perpendicular sides keep their own length; the ring stays closed.
    expect(lens.r).toBeCloseTo(4000, 6);
    expect(lens.l).toBeCloseTo(4000, 6);
    expect(bottomRun(grown.strip).len).toBeCloseTo(5000, 6);
    expect(lockedStripSegments(grown.strip).has('t')).toBe(true);
  });

  it('keeps a pinned perpendicular face in place when a length changes', () => {
    const base = stripOf(square.nodes, square.segs);
    const first = setStripRunLength(base, bottomRun(base), 4400);
    if (!first.ok) throw new Error('setup failed');
    const left = outerFace(first.strip, 'V', -1);
    const right = outerFace(first.strip, 'V', 1);
    const pinned = toggleStripRunPin(first.strip, left.key);
    const grown = setStripRunLength(pinned, bottomRun(pinned), 5000);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    // Left wall was held by hand: it must not move at all. The right wall
    // takes the whole 600 mm change of the face length.
    expect(outerFace(grown.strip, 'V', -1).a.x).toBeCloseTo(left.a.x, 3);
    expect(outerFace(grown.strip, 'V', 1).a.x - right.a.x).toBeCloseTo(600, 3);
  });

  it('moves two pinned perpendicular faces evenly instead of alerting', () => {
    const base = stripOf(square.nodes, square.segs);
    const first = setStripRunLength(base, bottomRun(base), 4400);
    if (!first.ok) throw new Error('setup failed');
    const left = outerFace(first.strip, 'V', -1);
    const right = outerFace(first.strip, 'V', 1);
    let pinned = toggleStripRunPin(first.strip, left.key);
    pinned = toggleStripRunPin(pinned, right.key);
    const grown = setStripRunLength(pinned, bottomRun(pinned), 5000);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    const afterLeft = outerFace(grown.strip, 'V', -1);
    const afterRight = outerFace(grown.strip, 'V', 1);
    // No conflict and no lopsided jump: each wall moves half the change.
    expect(afterLeft.a.x - left.a.x).toBeCloseTo(-300, 3);
    expect(afterRight.a.x - right.a.x).toBeCloseTo(300, 3);
    expect((afterLeft.a.x + afterRight.a.x) / 2).toBeCloseTo((left.a.x + right.a.x) / 2, 3);
  });

  /** A ring that already has millimetre lengths entered, without moving the nodes. */
  const enteredRing = (sidePins: string[] = [], pinned: string[] = []): StripState => ({
    ...stripOf(square.nodes, square.segs),
    lens: { t: 4000, r: 4000, u: 4000, l: 4000 },
    entered: true,
    sidePins,
    pinned,
  });

  /** Y of one band edge of the bottom segment, side -1 is the outer (below) one. */
  const faceY = (strip: StripState, side: 1 | -1) => {
    const nodes = scaledStripNodes(strip);
    const a = nodes.find((n) => n.id === 'a')!;
    const b = nodes.find((n) => n.id === 'b')!;
    const w = strip.widths.t ?? strip.baseWidth;
    return (a.y + b.y) / 2 + (side * w) / 2;
  };

  it('keeps a held edge of the band when its width changes', () => {
    const strip = enteredRing(['t|-1|0']);
    expect(faceY(strip, -1)).toBeCloseTo(-200, 6);
    const res = setStripSegWidth(strip, 't', 600);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The green bottom edge is a promise about position: it must not move.
    expect(faceY(res.strip, -1)).toBeCloseTo(-200, 3);
    // The free edge takes the whole change, so the perpendicular walls shorten
    // by half of it and the opposite wall of the ring stays where it was.
    const lens = stripLens(res.strip);
    expect(lens.r).toBeCloseTo(3900, 6);
    expect(lens.l).toBeCloseTo(3900, 6);
    const top = scaledStripNodes(res.strip).find((n) => n.id === 'c')!;
    expect(top.y).toBeCloseTo(4000, 3);
  });

  it('grows to the free side when the perpendicular face is held too', () => {
    const base = enteredRing();
    const built = buildStrip(scaledStripNodes(base), base.segs, () => 400, () => 500);
    const runs = faceRuns(built);
    // Right wall of the ring, inner (left) face and top wall, inner (lower) face.
    const right = runs.find(
      (r) => r.ids.length === 1 && r.ids[0] === 'r' && r.axis === 'V' && (r.a.x + r.b.x) / 2 < 4000,
    );
    const top = runs.find(
      (r) => r.ids.length === 1 && r.ids[0] === 't' && r.axis === 'H' && (r.a.y + r.b.y) / 2 > 0,
    );
    if (!right || !top) throw new Error('faces not found');
    const strip: StripState = { ...base, sidePins: [right.key, top.key] };
    const rightX = (right.a.x + right.b.x) / 2;
    const res = setStripSegWidth(strip, 'r', 600);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The band only grows to the free (outer) side. Both horizontal walls take
    // the shift on their centrelines, so their green inner faces stay put.
    const lens = stripLens(res.strip);
    expect(lens.r).toBeCloseTo(4000, 6);
    expect(lens.t).toBeCloseTo(4100, 6);
    expect(lens.u).toBeCloseTo(4100, 6);
    const afterRuns = faceRuns(
      buildStrip(scaledStripNodes(res.strip), res.strip.segs, (s) => (s.id === 'r' ? 600 : 400), () => 500),
    );
    const afterRight = afterRuns.find((r) => r.key === right.key);
    const afterTop = afterRuns.find((r) => r.key === top.key);
    expect(afterRight?.len).toBeCloseTo(right.len, 3);
    expect(afterTop?.len).toBeCloseTo(top.len, 3);
    expect(afterRight ? (afterRight.a.x + afterRight.b.x) / 2 : NaN).toBeCloseTo(rightX, 3);
  });

  it('grows evenly when both edges of the segment are held', () => {
    const strip = enteredRing(['t|-1|0', 't|1|0']);
    const res = setStripSegWidth(strip, 't', 600);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Two green edges leave no preferred side, so the band grows around the axis.
    const lens = stripLens(res.strip);
    expect(lens.r).toBeCloseTo(4000, 6);
    expect(lens.l).toBeCloseTo(4000, 6);
  });

  it('allows a width change when the perpendicular green face keeps its length', () => {
    const strip = enteredRing(['t|-1|0', 'l|-1|0']);
    const keys = ['t|-1|0', 'l|-1|0'];
    const before = new Map(
      faceRuns(buildStrip(scaledStripNodes(strip), strip.segs, () => 400, () => 500)).map(
        (r) => [r.key, r.len] as const,
      ),
    );
    const res = setStripSegWidth(strip, 't', 600);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const after = new Map(
      faceRuns(
        buildStrip(scaledStripNodes(res.strip), res.strip.segs, (s) => (s.id === 't' ? 600 : 400), () => 500),
      ).map((r) => [r.key, r.len] as const),
    );
    // The left wall's centreline gives a little, but the mitre at the corner
    // grows by exactly the same half-width: its visible green face is unchanged.
    for (const key of keys) expect(after.get(key)).toBeCloseTo(before.get(key) ?? 0, 3);
  });

  it('still refuses when the perpendicular green face would change length', () => {
    // The left wall's inner face sits on the side the band grows into, so the
    // mitre pushes it longer. There is no free parallel left to take that.
    const strip = enteredRing(['t|-1|0', 'l|1|0']);
    const res = setStripSegWidth(strip, 't', 600);
    expect(res.ok).toBe(false);
  });

  it('explains a width change blocked by a T-junction continuation', () => {
    // The selected top piece ends at a T-junction where the same band carries
    // on to the right. The axis would have to shift up, but the shared joint
    // cannot move without dragging that continuation out of line.
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 6000, y: 0 },
      { id: 'c', x: 6000, y: 4000 },
      { id: 'd', x: 0, y: 4000 },
      { id: 'e', x: 10000, y: 0 },
    ];
    const segs: NetSeg[] = [
      { id: 't1', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
      { id: 't2', a: 'b', b: 'e' },
    ];
    const strip: StripState = {
      ...stripOf(nodes, segs),
      lens: { t1: 6000, r: 4000, u: 6000, l: 4000, t2: 4000 },
      entered: true,
      sidePins: ['t1|1|0'],
    };
    const res = setStripSegWidth(strip, 't1', 600);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/T-стык/);
    expect(res.reason).toMatch(/продолжается в том же направлении/);
    // This is not the generic pinned-perpendicular conflict.
    expect(res.reason).not.toMatch(/перпендикулярная сторона/);
  });

  it('hands a width change to a free perpendicular piece past the held one', () => {
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 4000, y: 4000 },
      { id: 'd', x: 0, y: 4000 },
      { id: 'm', x: 0, y: 2000 },
    ];
    const segs: NetSeg[] = [
      { id: 't', a: 'a', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l1', a: 'd', b: 'm' },
      { id: 'l2', a: 'm', b: 'a' },
    ];
    const strip: StripState = {
      ...stripOf(nodes, segs),
      lens: { t: 4000, r: 4000, u: 4000, l1: 2000, l2: 2000 },
      entered: true,
      sidePins: ['t|-1|0'],
      pinned: ['l1'],
    };
    const res = setStripSegWidth(strip, 't', 600);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lens = stripLens(res.strip);
    expect(lens.l1).toBeCloseTo(2000, 6);
    expect(lens.l2).toBeCloseTo(1900, 6);
    expect(lens.r).toBeCloseTo(3900, 6);
  });

  it('anchors a pinned wall when the opposite side has more pieces', () => {
    // Top edge is split in two, bottom is one piece: the number of segments on
    // the two opposite faces differs, the face anchor still has to hold.
    const nodes: NetNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'm', x: 1500, y: 0 },
      { id: 'b', x: 3000, y: 0 },
      { id: 'c', x: 3000, y: 2000 },
      { id: 'd', x: 0, y: 2000 },
    ];
    const segs: NetSeg[] = [
      { id: 't1', a: 'a', b: 'm' },
      { id: 't2', a: 'm', b: 'b' },
      { id: 'r', a: 'b', b: 'c' },
      { id: 'u', a: 'c', b: 'd' },
      { id: 'l', a: 'd', b: 'a' },
    ];
    const base = stripOf(nodes, segs);
    const first = setStripRunLength(base, bottomRun(base), 4400);
    if (!first.ok) throw new Error('setup failed');
    const left = outerFace(first.strip, 'V', -1);
    const pinned = toggleStripRunPin(first.strip, left.key);
    const grown = setStripRunLength(pinned, bottomRun(pinned), 5000);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    expect(outerFace(grown.strip, 'V', -1).a.x).toBeCloseTo(left.a.x, 3);
    expect(outerFace(grown.strip, 'H', 1).len).toBeCloseTo(5000, 3);
    expect(outerFace(grown.strip, 'H', -1).len).toBeCloseTo(5000, 3);
  });

  it('refuses an edit when the opposite green side leaves no free parallel', () => {
    const first = setStripRunLength(
      stripOf(square.nodes, square.segs),
      bottomRun(stripOf(square.nodes, square.segs)),
      4400,
    );
    if (!first.ok) throw new Error('setup failed');
    // The bottom face was held by hand. A green face is a hard length lock, so
    // growing the top face must be refused: there is no free parallel side to
    // absorb the difference, and the user has to release one of the green ones.
    const built = buildStrip(scaledStripNodes(first.strip), first.strip.segs, () => 400, () => 500);
    const top = faceRuns(built).find((r) => r.outer && r.axis === 'H' && r.a.y > 0);
    if (!top) throw new Error('top face not found');
    const bottomKey = bottomRun(first.strip).key;
    const before = stripLens(first.strip);
    const res = setStripRunLength(first.strip, top, 6000);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/Открепите/);
    // Neither the lengths nor the green marks changed on a refused edit.
    expect(stripLens(first.strip)).toEqual(before);
    expect(stripSidePins(first.strip).has(bottomKey)).toBe(true);
    expect(stripSidePins(first.strip).has(top.key)).toBe(false);
  });

  it('lets a pinned face be corrected again and keeps it pinned', () => {
    const first = setStripRunLength(
      stripOf(square.nodes, square.segs),
      bottomRun(stripOf(square.nodes, square.segs)),
      4400,
    );
    if (!first.ok) throw new Error('setup failed');
    const run = bottomRun(first.strip);
    const res = setStripRunLength(first.strip, run, 5200);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lens = stripLens(res.strip);
    expect(lens.t).toBeCloseTo(4800, 6);
    expect(lens.u).toBeCloseTo(4800, 6);
    expect(stripSidePins(res.strip).has(run.key)).toBe(true);
    expect(toggleStripRunPin(res.strip, run.key).sidePins ?? []).toEqual([]);
  });

  it('locks every piece of a pinned face, not only the first one', () => {
    const withPin: StripState = { ...stripOf(square.nodes, square.segs), sidePins: ['t+r|-1|0'] };
    expect([...lockedStripSegments(withPin)].sort()).toEqual(['r', 't']);
  });
});

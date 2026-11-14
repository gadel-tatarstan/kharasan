import { useCallback, useEffect, useRef } from 'react';
import type { Pt } from '../geometry/vec';
import { MAX_SCALE, MIN_SCALE, panBy, unproject, zoomAt, type View } from '../lib/view';
import { setCanvasGestureActive } from '../lib/gesture';

type Props = {
  view: View;
  onView: (v: View) => void;
  onSize: (w: number, h: number) => void;
  draw: (ctx: CanvasRenderingContext2D, view: View) => void;
  onTap?: (screen: Pt, world: Pt) => void;
  children?: React.ReactNode;
  className?: string;
};

/** A press that travels further than this is a pan, not a tap. */
const PAN_SLOP = 11;

type Press = {
  id: number;
  x: number;
  y: number;
  t: number;
  moved: boolean;
  /** The press started on empty canvas, so a tap may add a point / select. */
  onCanvas: boolean;
};

export function PlanCanvas({ view, onView, onSize, draw, onTap, children, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const pointers = useRef(new Map<number, Pt>());
  const tap = useRef<Press | null>(null);
  const pinch = useRef<{ dist: number; mid: Pt; view: View } | null>(null);
  const last = useRef<Pt | null>(null);
  const captured = useRef(new Set<number>());

  // keep the canvas backing store in sync with its CSS size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) onSize(Math.round(r.width), Math.round(r.height));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(view.w));
    const h = Math.max(1, Math.round(view.h));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, view);
  });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      onView(zoomAt(viewRef.current, p, factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onView]);

  const local = (e: React.PointerEvent): Pt => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Called when the press has clearly become a drag: the canvas takes over. */
  const claim = (id: number) => {
    setCanvasGestureActive(true);
    const el = wrapRef.current;
    if (!el || captured.current.has(id)) return;
    try {
      el.setPointerCapture(id);
      captured.current.add(id);
    } catch {
      /* the pointer may already be gone — nothing to capture */
    }
  };

  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Text fields keep their own drag (selection, caret) instead of panning.
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('[data-canvas-ignore]')) return;

    // Touching the plan is "tapping outside" the number being typed: the soft
    // keyboard must fold away instead of hanging over the drawing.
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) active.blur();

    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      const onCanvas = !target || target === wrapRef.current || target.tagName === 'CANVAS';
      tap.current = {
        id: e.pointerId,
        x: p.x,
        y: p.y,
        t: performance.now(),
        moved: false,
        onCanvas,
      };
      last.current = p;
    } else if (pointers.current.size === 2) {
      tap.current = null;
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: viewRef.current,
      };
      // Two fingers are always a zoom, even when one of them landed on a chip.
      for (const id of pointers.current.keys()) claim(id);
    }
  };

  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const base = pinch.current;
      let next = zoomAt(base.view, base.mid, dist / base.dist);
      next = panBy(next, mid.x - base.mid.x, mid.y - base.mid.y);
      viewRef.current = next;
      onView(next);
      return;
    }

    if (pointers.current.size === 1) {
      const prev = last.current ?? p;
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      if (tap.current && !tap.current.moved) {
        if (Math.hypot(p.x - tap.current.x, p.y - tap.current.y) > PAN_SLOP) {
          tap.current.moved = true;
          claim(e.pointerId);
        }
      }
      if (tap.current?.moved) {
        const next = panBy(viewRef.current, dx, dy);
        viewRef.current = next;
        onView(next);
      }
      last.current = p;
    }
  };

  const up = useCallback(
    (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      const p = pointers.current.get(e.pointerId)!;
      pointers.current.delete(e.pointerId);
      captured.current.delete(e.pointerId);

      if (tap.current && tap.current.id === e.pointerId) {
        const isTap = !tap.current.moved && performance.now() - tap.current.t < 650;
        // A tap on a chip belongs to the chip: the canvas stays out of it,
        // otherwise selecting a segment would also fire while editing a number.
        if (isTap && tap.current.onCanvas && onTap) {
          onTap(p, unproject(p, viewRef.current));
        }
        tap.current = null;
      }

      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size === 1) {
        last.current = [...pointers.current.values()][0];
        tap.current = null;
      }
      if (pointers.current.size === 0) {
        last.current = null;
        setCanvasGestureActive(false);
      }
    },
    [onTap],
  );

  const cancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    captured.current.delete(e.pointerId);
    tap.current = null;
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setCanvasGestureActive(false);
  };

  // Safety net: a mouse released outside the canvas never reaches the handlers
  // above, so forget that pointer instead of leaving a half-finished gesture.
  useEffect(() => {
    const drop = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.delete(e.pointerId);
      captured.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size === 0) {
        tap.current = null;
        last.current = null;
        setCanvasGestureActive(false);
      }
    };
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
    return () => {
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', drop);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`plan-canvas ${className ?? ''}`}
      onPointerDownCapture={down}
      onPointerMoveCapture={move}
      onPointerUpCapture={up}
      onPointerCancelCapture={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} style={{ width: view.w, height: view.h }} />
      <div className="overlay">{children}</div>
    </div>
  );
}

export { MIN_SCALE, MAX_SCALE };

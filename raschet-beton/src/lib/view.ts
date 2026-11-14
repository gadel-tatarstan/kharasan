import type { Pt, Rect } from '../geometry/vec';

export type View = { cx: number; cy: number; scale: number; w: number; h: number };

export const project = (p: Pt, v: View): Pt => ({
  x: (p.x - v.cx) * v.scale + v.w / 2,
  y: (p.y - v.cy) * v.scale + v.h / 2,
});

export const unproject = (s: Pt, v: View): Pt => ({
  x: (s.x - v.w / 2) / v.scale + v.cx,
  y: (s.y - v.h / 2) / v.scale + v.cy,
});

export const MIN_SCALE = 0.005;
export const MAX_SCALE = 8;

/** Top band of the canvas reserved for the volume badge. */
export const HUD_BAND = 92;

export function fitView(b: Rect, w: number, h: number, pad = 44, padTop = HUD_BAND): View {
  const bw = Math.max(b.x1 - b.x0, 1);
  const bh = Math.max(b.y1 - b.y0, 1);
  const wx = Math.max(w - pad * 2, 40);
  const wy = Math.max(h - pad * 2 - padTop, 40);
  const scale = Math.min(Math.max(Math.min(wx / bw, wy / bh), MIN_SCALE), 2);
  return {
    cx: (b.x0 + b.x1) / 2,
    // shift the content down so it starts below the badge
    cy: (b.y0 + b.y1) / 2 - padTop / 2 / scale,
    scale,
    w,
    h,
  };
}

export function zoomAt(v: View, screen: Pt, factor: number): View {
  const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));

  const world = unproject(screen, v);
  // keep the world point under the cursor/touch fixed
  const cx = world.x - (screen.x - v.w / 2) / nextScale;
  const cy = world.y - (screen.y - v.h / 2) / nextScale;
  return { ...v, scale: nextScale, cx, cy };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { ...v, cx: v.cx - dx / v.scale, cy: v.cy - dy / v.scale };
}

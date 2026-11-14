import type { Pt } from '../geometry/vec';
import { project, type View } from '../lib/view';

export const C = {
  bg: '#0b0f14',
  grid: 'rgba(140,170,205,0.09)',
  gridMajor: 'rgba(140,170,205,0.18)',
  slabFill: 'rgba(255,122,47,0.16)',
  slabStroke: '#ff8a4c',
  bandFill: 'rgba(255,122,47,0.18)',
  bandStroke: '#ff8a4c',
  raw: 'rgba(255,255,255,0.5)',
  rawDash: 'rgba(255,255,255,0.28)',
  center: 'rgba(255,255,255,0.35)',
  node: '#ffb27a',
  nodeRing: '#0b0f14',
  ref: '#3ddc97',
  ghost: 'rgba(255,122,47,0.55)',
  text: 'rgba(234,240,247,0.9)',
};

export function circle(
  ctx: CanvasRenderingContext2D,
  p: Pt,
  r: number,
  fill: string,
  ring?: string,
) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (ring) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = ring;
    ctx.stroke();
  }
}

const STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000];

export function drawGrid(ctx: CanvasRenderingContext2D, v: View) {
  const scale = v.scale;
  let step = STEPS[STEPS.length - 1];
  for (const s of STEPS) {
    if (s * scale >= 58) {
      step = s;
      break;
    }
  }
  const left = v.cx - v.w / 2 / scale;
  const right = v.cx + v.w / 2 / scale;
  const top = v.cy - v.h / 2 / scale;
  const bottom = v.cy + v.h / 2 / scale;

  ctx.lineWidth = 1;
  const startX = Math.floor(left / step) * step;
  const startY = Math.floor(top / step) * step;

  for (let x = startX; x <= right; x += step) {
    const sx = Math.round(project({ x, y: 0 }, v).x) + 0.5;
    ctx.strokeStyle = Math.round(x / step) % 5 === 0 ? C.gridMajor : C.grid;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, v.h);
    ctx.stroke();
  }
  for (let y = startY; y <= bottom; y += step) {
    const sy = Math.round(project({ x: 0, y }, v).y) + 0.5;
    ctx.strokeStyle = Math.round(y / step) % 5 === 0 ? C.gridMajor : C.grid;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(v.w, sy);
    ctx.stroke();
  }
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, v: View) {
  const options = [500, 1000, 2000, 5000, 10000, 20000];
  let len = options[0];
  for (const o of options) {
    if (o * v.scale <= 120) len = o;
  }
  const px = len * v.scale;
  const x = 16;
  const y = v.h - 18;
  ctx.strokeStyle = 'rgba(234,240,247,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(234,240,247,0.7)';
  ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(len >= 1000 ? `${len / 1000} м` : `${len} мм`, x, y - 8);
}

export function tracePolygon(ctx: CanvasRenderingContext2D, v: View, poly: Pt[]) {
  if (poly.length < 2) return;
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = project(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
}

export function traceLine(ctx: CanvasRenderingContext2D, v: View, a: Pt, b: Pt) {
  const p = project(a, v);
  const q = project(b, v);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(q.x, q.y);
}

/** World-space normal pointing away from the polygon interior. */
export function outwardNormal(poly: Pt[], i: number, inside: (p: Pt) => boolean): Pt {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const n = { x: dy / len, y: -dx / len };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const probe = 4;
  const test = { x: m.x + n.x * probe, y: m.y + n.y * probe };
  return inside(test) ? { x: -n.x, y: -n.y } : n;
}

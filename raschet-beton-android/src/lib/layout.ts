import type { Pt } from '../geometry/vec';

/** Screen size of a chip at full scale, used to decide how they share space. */
export const CHIP_W = 84;
export const CHIP_H = 34;

/** Numbers may shrink to this before they are dropped instead. */
const MIN_CHIP_SCALE = 0.6;
/** Distance between two labels at which they still fit at full size. */
const ROOMY_GAP = 100;

export type ChipFit = {
  /** Scale applied to every chip so dense numbers shrink before they vanish. */
  scale: number;
  /** Per-chip flag; false means the number cannot fit and is hidden. */
  visible: boolean[];
};

/**
 * Numbers on a plan pile up once the drawing is zoomed out. Rather than dragging
 * them away from the edge they describe, the whole set shrinks with the room it
 * has, and the labels that still cannot fit are dropped. More important numbers
 * (pinned, selected, typed) win over placeholders.
 */
export function fitChips(
  points: Pt[],
  weights: number[] = [],
  baseW = CHIP_W,
  baseH = CHIP_H,
  gap = 4,
): ChipFit {
  const visible = points.map(() => false);
  if (points.length === 0) return { scale: 1, visible };

  // Rank each label by its closest neighbour and take the median: one pair that
  // almost coincides must not shrink the whole set, it should simply hide.
  const nearest = points.map(() => Infinity);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (d < nearest[i]) nearest[i] = d;
      if (d < nearest[j]) nearest[j] = d;
    }
  }
  const sorted = [...nearest].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
  const scale = points.length < 2 ? 1 : Math.min(1, Math.max(MIN_CHIP_SCALE, typical / ROOMY_GAP));
  const w = baseW * scale + gap;
  const h = baseH * scale + gap;

  const order = points.map((_, i) => i);
  order.sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a - b);

  const kept: number[] = [];
  for (const i of order) {
    const hits = kept.some(
      (j) => Math.abs(points[i].x - points[j].x) < w && Math.abs(points[i].y - points[j].y) < h,
    );
    if (!hits) {
      visible[i] = true;
      kept.push(i);
    }
  }
  return { scale, visible };
}

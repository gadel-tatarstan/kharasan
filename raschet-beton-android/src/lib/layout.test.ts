import { describe, expect, it } from 'vitest';
import { CHIP_H, CHIP_W, fitChips } from './layout';

describe('fitChips', () => {
  it('keeps every label in place when there is room', () => {
    const points = [
      { x: 40, y: 40 },
      { x: 240, y: 40 },
      { x: 240, y: 240 },
      { x: 40, y: 240 },
    ];
    const fit = fitChips(points);
    expect(fit.scale).toBe(1);
    expect(fit.visible).toEqual([true, true, true, true]);
  });

  it('shrinks labels before hiding them', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ];
    const fit = fitChips(points);
    expect(fit.scale).toBeLessThan(1);
    expect(fit.scale).toBeGreaterThanOrEqual(0.6);
    expect(fit.visible).toEqual([true, true]);
  });

  it('hides the labels that cannot fit without overlapping', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 12, y: 4 },
      { x: 24, y: 8 },
      { x: 36, y: 12 },
    ];
    const fit = fitChips(points);
    expect(fit.scale).toBe(0.6);
    const kept = points.filter((_, i) => fit.visible[i]);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(points.length);
    const w = CHIP_W * fit.scale;
    const h = CHIP_H * fit.scale;
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const dx = Math.abs(kept[i].x - kept[j].x);
        const dy = Math.abs(kept[i].y - kept[j].y);
        expect(dx >= w || dy >= h).toBe(true);
      }
    }
  });

  it('prefers the heavier label when two share a spot', () => {
    const points = [
      { x: 100, y: 100 },
      { x: 100, y: 100 },
    ];
    const fit = fitChips(points, [1, 3]);
    expect(fit.visible).toEqual([false, true]);
  });

  it('handles a single label', () => {
    const fit = fitChips([{ x: 10, y: 10 }]);
    expect(fit.scale).toBe(1);
    expect(fit.visible).toEqual([true]);
  });
});

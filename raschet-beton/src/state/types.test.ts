import { describe, expect, it } from 'vitest';
import { migrateStrip, nextProjectName } from './types';

const nodes = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 1000, y: 0 },
  { id: 'c', x: 1000, y: 1000 },
];
const segs = [
  { id: 's1', a: 'a', b: 'b' },
  { id: 's2', a: 'b', b: 'c' },
];

describe('strip depth migration', () => {
  it('lifts legacy per-vertex depth onto the incident segments', () => {
    const strip = migrateStrip({
      nodes,
      segs,
      baseNodes: nodes,
      baseDepth: 600,
      baseWidth: 400,
      entered: true,
      depths: { a: 300, b: 700 },
    });
    // The deepest endpoint wins, so the old volume is not lost.
    expect(strip.depths).toEqual({ s1: 700, s2: 700 });
    expect(strip.baseDepth).toBe(600);
    expect(strip.entered).toBe(true);
  });

  it('numbers duplicate calculation names without collisions', () => {
    expect(nextProjectName('slab', [])).toBe('Плита');
    expect(nextProjectName('strip', [])).toBe('Лента');
    expect(nextProjectName('slab', ['Плита'])).toBe('Плита 2');
    expect(nextProjectName('slab', ['Плита', 'Плита 2'])).toBe('Плита 3');
    // Names are shared between both kinds, so a slab never repeats a strip name.
    expect(nextProjectName('slab', ['Лента'])).toBe('Плита');
    expect(nextProjectName('strip', ['Плита', 'Лента'])).toBe('Лента 2');
  });

  it('keeps per-segment depth and ignores unrelated keys', () => {
    const strip = migrateStrip({
      nodes,
      segs,
      baseNodes: nodes,
      entered: true,
      depths: { s1: 250, gone: 900 },
    });
    expect(strip.depths).toEqual({ s1: 250 });
    expect(strip.baseDepth).toBe(600);
  });
});

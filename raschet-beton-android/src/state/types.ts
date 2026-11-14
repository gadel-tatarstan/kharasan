import type { Pt } from '../geometry/vec';
import type { NetNode, NetSeg } from '../geometry/strip';

export type Kind = 'slab' | 'strip';
export type Stage = 'setup' | 'outline' | 'dims' | 'depth' | 'offset';

/**
 * One closed contour of a slab. Several contours are allowed: a contour drawn
 * outside the first one adds volume, a contour drawn inside it becomes a void.
 * Which is which is not stored — it is derived from how the contours nest.
 */
export type SlabContour = {
  id: string;
  /** Points placed on the canvas, before the rectilinear snap. */
  raw: Pt[];
  /** Snapped orthogonal polygon in world units (mm once the slab has a scale). */
  base: Pt[] | null;
  /** Centre the rebuilt polygon keeps — the shape never crawls while edited. */
  pivot: Pt;
  /** Per-edge lengths in mm; the shape is rebuilt from them. null = not entered yet. */
  lens: number[] | null;
  /** Edge indices whose length the user typed by hand; they never change on their own. */
  pinned: number[] | null;
  /** Legacy single reference edge from older saves — migrated into `pinned` on read. */
  refEdge?: number | null;
  /** True as soon as this contour has real lengths. */
  entered: boolean;
  /** Per-vertex thickness override, null = use the base thickness. */
  vThickness: (number | null)[];
};

export type SlabState = {
  contours: SlabContour[];
  thickness: number;
  /** True once the sketch units have been fixed to millimetres for the whole slab. */
  entered: boolean;
};

export type StripState = {
  nodes: NetNode[];
  segs: NetSeg[];
  baseNodes: NetNode[] | null;
  /** Legacy uniform scale from older saves — only a fallback until `lens` exists. */
  pivot: Pt;
  sx: number;
  sy: number;
  /** Legacy single reference segment from older saves — migrated into `pinned`. */
  refSeg: string | null;
  /** Centreline length of every segment in mm; the geometry is rebuilt from these. */
  lens: Record<string, number> | null;
  /** Segments whose number the user typed by hand; they never change on their own. */
  pinned: string[] | null;
  /** Faces of the band fixed by a long press; the key embeds the segment ids. */
  sidePins?: string[] | null;
  entered: boolean;
  baseWidth: number;
  baseDepth: number;
  /** Per-segment width in mm, absolute (not affected by scaling). */
  widths: Record<string, number>;
  /** Per-segment depth override in mm (older saves kept it per vertex). */
  depths: Record<string, number>;
  /** Adds a tooth (thickened lip) along the outer contour of the strip. */
  tooth: boolean;
  /** Tooth width measured inward from the outer contour, mm. */
  toothWidth: number;
  /** Extra tooth depth added to the strip volume, mm. */
  toothDepth: number;
};

export type Folder = {
  id: string;
  name: string;
  createdAt: number;
};

export type Project = {
  id: string;
  kind: Kind;
  stage: Stage;
  /** Human-readable name, editable from the home list or the editor header. */
  name: string;
  /** Folder that owns this calculation. Calculations never live outside a folder. */
  folderId: string;
  createdAt: number;
  updatedAt: number;
  slab?: SlabState;
  strip?: StripState;
};

const baseName = (kind: Kind): string => (kind === 'slab' ? 'Плита' : 'Лента');

/** A readable, unique-by-default name for a freshly created calculation. */
export function nextProjectName(kind: Kind, existing: Iterable<string>): string {
  const used = new Set(existing);
  const first = baseName(kind);
  if (!used.has(first)) return first;
  let n = 2;
  while (used.has(`${first} ${n}`)) n++;
  return `${first} ${n}`;
}

export const defaultFolderName = 'Новая папка';

export const newId = (prefix = 'n'): string =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const newContour = (): SlabContour => ({
  id: newId('c'),
  raw: [],
  base: null,
  pivot: { x: 0, y: 0 },
  lens: null,
  pinned: null,
  entered: false,
  vThickness: [],
});

export const defaultSlab = (): SlabState => ({
  contours: [],
  thickness: 200,
  entered: false,
});

const numOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Reads a slab from storage. Saves made before multiple contours existed keep
 * their single contour, so old projects open exactly as they were left.
 */
export function migrateSlab(raw: unknown): SlabState {
  const s = (raw ?? {}) as Record<string, any>;

  if (Array.isArray(s.contours)) {
    const contours: SlabContour[] = s.contours.map((c: any) => ({
      id: typeof c?.id === 'string' ? c.id : newId('c'),
      raw: Array.isArray(c?.raw) ? c.raw : [],
      base: Array.isArray(c?.base) && c.base.length >= 3 ? c.base : null,
      pivot: c?.pivot ?? { x: 0, y: 0 },
      lens: Array.isArray(c?.lens) ? c.lens : null,
      pinned: Array.isArray(c?.pinned) ? c.pinned : null,
      refEdge: c?.refEdge ?? null,
      entered: !!c?.entered,
      vThickness: Array.isArray(c?.vThickness) ? c.vThickness : [],
    }));
    return { contours, thickness: numOr(s.thickness, 200), entered: !!s.entered };
  }

  const base = Array.isArray(s.base) && s.base.length >= 3 ? (s.base as Pt[]) : null;
  const rawPoints = Array.isArray(s.raw) ? (s.raw as Pt[]) : [];
  const contours: SlabContour[] = [];
  if (base || rawPoints.length) {
    contours.push({
      id: 'c0',
      raw: rawPoints,
      base,
      pivot: s.pivot ?? { x: 0, y: 0 },
      lens: Array.isArray(s.lens) ? s.lens : null,
      pinned: Array.isArray(s.pinned)
        ? s.pinned
        : s.refEdge != null
          ? [s.refEdge]
          : null,
      refEdge: null,
      entered: !!s.entered,
      vThickness: Array.isArray(s.vThickness) ? s.vThickness : [],
    });
  }
  return { contours, thickness: numOr(s.thickness, 200), entered: !!s.entered };
}

export const defaultStrip = (): StripState => ({
  nodes: [],
  segs: [],
  baseNodes: null,
  pivot: { x: 0, y: 0 },
  sx: 1,
  sy: 1,
  refSeg: null,
  lens: null,
  pinned: null,
  sidePins: null,
  entered: false,
  baseWidth: 400,
  baseDepth: 600,
  widths: {},
  depths: {},
  tooth: false,
  toothWidth: 150,
  toothDepth: 150,
});

/**
 * Reads a strip from storage. Depth used to be stored per vertex; those values
 * are lifted to the incident segments so an old project keeps its volume after
 * the switch to per-edge depth.
 */
export function migrateStrip(raw: unknown): StripState {
  const s = (raw ?? {}) as Record<string, unknown>;
  const base = defaultStrip();
  const nodes = Array.isArray(s.nodes) ? (s.nodes as NetNode[]) : base.nodes;
  const segs = Array.isArray(s.segs) ? (s.segs as NetSeg[]) : base.segs;
  const baseNodes = Array.isArray(s.baseNodes) ? (s.baseNodes as NetNode[]) : null;
  const rawDepths =
    s.depths && typeof s.depths === 'object' && !Array.isArray(s.depths)
      ? (s.depths as Record<string, unknown>)
      : {};

  const depths: Record<string, number> = {};
  const segIds = new Set(segs.map((seg) => seg.id));
  // Keep overrides that are already stored per segment.
  for (const [id, v] of Object.entries(rawDepths)) {
    if (segIds.has(id) && typeof v === 'number' && Number.isFinite(v)) depths[id] = v;
  }
  // Lift legacy per-vertex values onto every incident segment.
  const nodeIds = new Set((baseNodes ?? nodes).map((n) => n.id));
  if (Object.keys(rawDepths).some((id) => nodeIds.has(id))) {
    for (const seg of segs) {
      if (depths[seg.id] !== undefined) continue;
      const va = rawDepths[seg.a];
      const vb = rawDepths[seg.b];
      const a = typeof va === 'number' && Number.isFinite(va) ? va : null;
      const b = typeof vb === 'number' && Number.isFinite(vb) ? vb : null;
      if (a !== null || b !== null) depths[seg.id] = Math.max(a ?? 0, b ?? 0);
    }
  }

  return {
    nodes,
    segs,
    baseNodes,
    pivot: (s.pivot as Pt) ?? base.pivot,
    sx: numOr(s.sx, 1),
    sy: numOr(s.sy, 1),
    refSeg: typeof s.refSeg === 'string' ? s.refSeg : null,
    lens:
      s.lens && typeof s.lens === 'object' && !Array.isArray(s.lens)
        ? (s.lens as Record<string, number>)
        : null,
    pinned: Array.isArray(s.pinned) ? (s.pinned as string[]) : null,
    sidePins: Array.isArray(s.sidePins) ? (s.sidePins as string[]) : null,
    entered: !!s.entered,
    baseWidth: numOr(s.baseWidth, base.baseWidth),
    baseDepth: numOr(s.baseDepth, base.baseDepth),
    widths:
      s.widths && typeof s.widths === 'object' && !Array.isArray(s.widths)
        ? (s.widths as Record<string, number>)
        : {},
    depths,
    tooth: !!s.tooth,
    toothWidth: numOr(s.toothWidth, base.toothWidth),
    toothDepth: numOr(s.toothDepth, base.toothDepth),
  };
}
